// Live state from git branches and GitHub pull requests, ported from EduStrux's scripts/board.mjs.
// Every git and gh call goes through a Runner, so tests can fake it.
import { execFile } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LiveConfig, LiveState } from './config.js';
import type { Task } from './tasks.js';

export type RunResult = { ok: true; stdout: string } | { ok: false; error: string };
export type Runner = (cmd: string, args: string[], options: { cwd: string }) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, { cwd }) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
        },
      },
      (error, stdout, stderr) =>
        resolve(error ? { ok: false, error: (stderr || error.message).trim() } : { ok: true, stdout }),
    );
  });

export interface PullRequest {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
}

export interface Live {
  state: LiveState;
  branch?: string;
  pr?: number;
  base?: string;
  /** `draft`, `changes requested` or `approved` for an open PR. */
  note?: string;
}

export interface TaskLive {
  live?: Live;
  /** A PR equal to the task's `pr` field merged into the base branch, but the file isn't done. */
  merged?: { pr: number };
}

/** Task ids named by a branch: task/tui-27-…, task/tui-27-29-… (a bundle), docs/tui-1-10-… (a range). */
export function idsFromBranch(branch: string, live: LiveConfig, template: string): string[] {
  const m = live.branchPattern.exec(branch);
  if (!m?.[1]) return [];
  const nums = m[1].split(/\D+/).filter(Boolean).map(Number);
  const id = (n: number) => template.replaceAll('{n}', String(n));
  const [first, second] = nums;
  if (
    nums.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    second > first + 1 &&
    second - first < 1000 &&
    live.rangePrefixes.some((p) => branch.startsWith(p))
  )
    return Array.from({ length: second - first + 1 }, (_, i) => id(first + i));
  return nums.map(id);
}

/** Works out each task's live state from local branches and PRs (newest PR first, as gh lists them). */
export function computeLive(
  tasks: Task[],
  live: LiveConfig,
  template: string,
  branches: string[],
  prs: PullRequest[],
): Map<string, TaskLive> {
  const result = new Map<string, TaskLive>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = (t: Task) => !(t.status !== null && live.ignoreStatuses.includes(t.status));
  const entry = (id: string) => {
    let e = result.get(id);
    if (!e) result.set(id, (e = {}));
    return e;
  };
  const prOf = (t: Task) => (live.prField ? prNumber(t.data[live.prField]) : null);

  for (const branch of branches) {
    for (const id of idsFromBranch(branch, live, template)) {
      const t = byId.get(id);
      if (t && active(t) && !result.get(id)?.live) entry(id).live = { state: 'in-progress', branch };
    }
  }

  const mergedHeads = new Map<string, string>();
  for (const pr of prs) {
    const ids = new Set(idsFromBranch(pr.headRefName, live, template));
    for (const t of tasks) {
      if (prOf(t) === pr.number) ids.add(t.id);
      if (live.branchField && t.data[live.branchField] === pr.headRefName) ids.add(t.id);
    }
    for (const id of ids) {
      const t = byId.get(id);
      if (!t || !active(t)) continue;
      if (pr.state === 'OPEN') {
        const e = entry(id);
        // An open PR takes precedence over a branch; the newest open PR wins.
        if (e.live?.state !== 'in-review')
          e.live = {
            state: 'in-review',
            pr: pr.number,
            branch: pr.headRefName,
            base: pr.baseRefName,
            ...(prNote(pr) ? { note: prNote(pr) } : {}),
          };
      } else if (
        pr.state === 'MERGED' &&
        pr.baseRefName === live.baseBranch &&
        prOf(t) === pr.number &&
        !(t.status !== null && live.mergedIgnoreStatuses.includes(t.status))
      ) {
        entry(id).merged = { pr: pr.number };
        mergedHeads.set(id, pr.headRefName);
      }
    }
  }

  // A local branch left over from the merged PR isn't work in progress.
  for (const [id, head] of mergedHeads) {
    const e = result.get(id)!;
    if (e.live?.state === 'in-progress' && e.live.branch === head) delete e.live;
  }
  return result;
}

function prNote(pr: PullRequest): string {
  if (pr.isDraft) return 'draft';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  return '';
}

export function prNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^#?\d+$/.test(value.trim()))
    return Number(value.trim().replace('#', ''));
  return null;
}

/** Turns a git remote URL into the repo's web URL (https://github.com/owner/repo). */
export function webUrl(remote: string): string | null {
  const r = remote.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(r);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(r);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
    return path.length > 1 ? `https://${url.hostname}${path}` : null;
  } catch {
    return null;
  }
}

function ghProblem(error: string): string {
  if (/ENOENT|not found|not recognized/i.test(error) && !/repository/i.test(error))
    return 'gh is not installed';
  if (/auth login|not logged in|authenticat/i.test(error)) return 'gh is not signed in (run gh auth login)';
  if (/remote|not a git repository|determine/i.test(error)) return "gh can't tell which GitHub repo this is";
  return `gh pr list failed (${error.split('\n')[0]?.slice(0, 200)})`;
}

export interface Uncommitted {
  /** Path relative to the config file's folder, with forward slashes. */
  file: string;
  /** git's two-letter status, e.g. " M" or "??". */
  code: string;
}

const PR_TTL_MS = 60_000;

/** git and gh lookups for one repo. PR results are cached for a minute; `refresh()` drops them. */
export class GitState {
  private prCache: { at: number; prs: PullRequest[] | null; problem: string | null } | null = null;
  private prPending: Promise<PullRequest[] | null> | null = null;
  private topLevel: Promise<string | null> | null = null;
  /** Called when a background PR lookup finds something different. */
  onPullRequestsChanged: (() => void) | null = null;

  constructor(
    private readonly run: Runner,
    /** Where to run git: a folder inside the repo (the tasks folder). */
    private readonly cwd: string,
    private readonly root: string,
  ) {}

  private async git(args: string[]): Promise<string | null> {
    const r = await this.run('git', args, { cwd: this.cwd });
    return r.ok ? r.stdout : null;
  }

  refresh(): void {
    this.prCache = null;
  }

  /** Local branch names, or null when git isn't available. */
  async branches(): Promise<string[] | null> {
    const out = await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return out === null ? null : out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Why the last PR lookup failed, in a few words. */
  get prProblem(): string | null {
    return this.prCache?.problem ?? null;
  }

  /**
   * PRs from gh, or null when gh isn't installed or signed in. Once the cached result is a minute
   * old it's still returned straight away, while a fresh one is fetched in the background.
   */
  async pullRequests(): Promise<PullRequest[] | null> {
    const cache = this.prCache;
    if (!cache) return this.fetchPullRequests();
    if (Date.now() - cache.at >= PR_TTL_MS) {
      const before = JSON.stringify(cache.prs);
      void this.fetchPullRequests().then((prs) => {
        if (JSON.stringify(prs) !== before) this.onPullRequestsChanged?.();
      });
    }
    return cache.prs;
  }

  /**
   * Like pullRequests(), but when nothing is cached yet it stops waiting after `ms` and returns
   * undefined. onPullRequestsChanged fires once gh answers.
   */
  async pullRequestsWithin(ms: number): Promise<PullRequest[] | null | undefined> {
    if (this.prCache) return this.pullRequests();
    const fetching = this.fetchPullRequests();
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      fetching,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
    clearTimeout(timer);
    if (result === undefined) void fetching.then(() => this.onPullRequestsChanged?.());
    return result;
  }

  private fetchPullRequests(): Promise<PullRequest[] | null> {
    this.prPending ??= (async () => {
      const r = await this.run(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'all',
          '--limit',
          '200',
          '--json',
          'number,state,headRefName,baseRefName,isDraft,reviewDecision',
        ],
        { cwd: this.cwd },
      );
      let prs: PullRequest[] | null = null;
      let problem: string | null = null;
      if (r.ok) {
        try {
          const parsed: unknown = JSON.parse(r.stdout);
          if (Array.isArray(parsed)) prs = parsed as PullRequest[];
        } catch {
          prs = null;
        }
        if (!prs) problem = "gh returned something that isn't a list of PRs";
      } else problem = ghProblem(r.error);
      this.prCache = { at: Date.now(), prs, problem };
      return prs;
    })().finally(() => {
      this.prPending = null;
    });
    return this.prPending;
  }

  /** The checked-out branch, `detached at <sha>`, or null outside a repo. */
  async currentBranch(): Promise<string | null> {
    const name = (await this.git(['branch', '--show-current']))?.trim();
    if (name) return name;
    if (name === undefined) return null;
    const sha = (await this.git(['rev-parse', '--short', 'HEAD']))?.trim();
    return sha ? `detached at ${sha}` : null;
  }

  async repoUrl(): Promise<string | null> {
    const remote = await this.git(['remote', 'get-url', 'origin']);
    return remote === null ? null : webUrl(remote);
  }

  /** The repo's top folder, or null outside a repo. */
  repoRoot(): Promise<string | null> {
    this.topLevel ??= this.git(['rev-parse', '--show-toplevel']).then((s) => s?.trim() || null);
    return this.topLevel;
  }

  /** The .git folder (HEAD) and the folder with refs/heads, which differ in a worktree. */
  async gitDirs(): Promise<{ gitDir: string; commonDir: string } | null> {
    const out = await this.git(['rev-parse', '--absolute-git-dir', '--git-common-dir']);
    const [gitDir, commonDir] = out?.trim().split('\n') ?? [];
    return gitDir && commonDir ? { gitDir, commonDir: resolve(this.cwd, commonDir) } : null;
  }

  /** Task files under `dir` with uncommitted changes, or null when git isn't available. */
  async uncommitted(dir: string): Promise<Uncommitted[] | null> {
    const [top, out] = await Promise.all([
      this.repoRoot(),
      this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', dir]),
    ]);
    if (top === null || out === null) return null;
    const entries = out.split('\0');
    const files: Uncommitted[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename or copy is followed by its old path.
      if (code[0] === 'R' || code[0] === 'C') i++;
      const abs = isAbsolute(path) ? path : join(top, path);
      if (!path.endsWith('.md') || relative(dir, abs).startsWith('..')) continue;
      files.push({ file: relative(this.root, abs).split(sep).join('/'), code });
    }
    return files;
  }
}
