// `boardmd init`: looks at the repo's task files and branches, works out a config, shows it and
// writes boardmd.config.json (and, if asked, a package.json script).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CONFIG_FILE, loadConfig, parseConfig } from './config.js';
import { folderMatches as folderMatchesValue } from './check.js';
import { parseFrontmatter } from './frontmatter.js';
import { installAgentFiles } from './guide.js';
import { defaultRunner, type Runner } from './live.js';
import { readTasks } from './tasks.js';

export interface Prompter {
  /** Asks a question; an empty answer means `fallback`. */
  ask(question: string, fallback: string): Promise<string>;
  close(): void;
}

export interface InitOptions {
  cwd?: string;
  /** Where to write the config (default boardmd.config.json in cwd). */
  config?: string;
  /** Use this folder instead of the one found. */
  tasksDir?: string;
  /** Accept every default without asking. */
  yes?: boolean;
  /** Replace an existing config. */
  force?: boolean;
  runner?: Runner;
  /** Answers questions; without one, init behaves as if --yes was given. */
  prompter?: Prompter;
  log?: (line: string) => void;
  /** `boardmd serve` starts the board right after, so don't say how to start it. */
  thenServe?: boolean;
}

export interface InitResult {
  code: number;
  /** The config that was written. */
  configPath?: string;
}

/** Asks questions on the terminal. */
export function terminalPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (question, fallback) => (await rl.question(question)).trim() || fallback,
    close: () => rl.close(),
  };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;

interface TaskFile {
  absPath: string;
  data: Record<string, unknown>;
  body?: string;
}

/** Markdown files under `root` whose frontmatter has a status. */
export async function findTaskFiles(root: string): Promise<TaskFile[]> {
  const found: TaskFile[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || seen >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md') && seen++ < MAX_FILES) {
        const info = await stat(path).catch(() => null);
        if (!info || info.size > MAX_FILE_BYTES) continue;
        try {
          const { data, body } = parseFrontmatter(await readFile(path, 'utf8'));
          if (statusKey(data)) found.push({ absPath: path, data, body });
        } catch {
          // Not a task file.
        }
      }
    }
  };
  await walk(root, 0);
  return found;
}

const ID_KEYS = ['id', 'key', 'ref', 'slug', 'number', 'issue'];

/** The id family a file belongs to: its id's prefix ("TUI" for TUI-12), "#" for numbers, "" for none. */
function idFamily(data: Record<string, unknown>): string {
  const key = ID_KEYS.find((k) => !isBlank(data[k]));
  if (!key) return '';
  const id = String(data[key]);
  return (
    /^([A-Za-z][A-Za-z0-9]*)[-_]\d+$/.exec(id)?.[1]?.toUpperCase() ?? (/^\d+$/.test(id) ? '#' : '?')
  );
}

/**
 * The folder for the largest family of task files (by id prefix), as the deepest folder that
 * holds all of them. Other markdown files with a status, such as decision records, don't pull
 * it up to the repo root.
 */
export function pickTasksDir(root: string, files: TaskFile[]): string | null {
  if (!files.length) return null;
  const families = new Map<string, TaskFile[]>();
  for (const f of files) {
    const family = idFamily(f.data);
    families.set(family, [...(families.get(family) ?? []), f]);
  }
  const ranked = [...families].sort(
    ([a, x], [b, y]) => Number(a === '') - Number(b === '') || y.length - x.length,
  );
  const group = ranked[0]![1];
  let dir = dirname(group[0]!.absPath);
  while (
    !group.every((f) => f.absPath.startsWith(dir + sep)) &&
    dir !== root &&
    dir !== dirname(dir)
  )
    dir = dirname(dir);
  return dir;
}

// Statuses in board order. Anything unknown goes between in review and blocked.
const STATUS_RANKS: Array<[number, RegExp]> = [
  [0, /^(backlog|icebox|someday|idea|ideas)$/],
  [1, /^(todo|to-do|open|new|ready|planned|pending|not-started|unstarted|next)$/],
  [
    2,
    /^(in-progress|inprogress|doing|wip|started|active|in-dev|in-development|development|working)$/,
  ],
  [3, /^(review|in-review|reviewing|qa|testing|in-qa|in-test)$/],
  [5, /^(blocked|waiting|on-hold|hold|paused|stuck)$/],
  [6, /^(done|closed|complete|completed|resolved|shipped|merged|finished|released)$/],
  [
    7,
    /^(deferred|cancelled|canceled|wontfix|wont-fix|won-t-fix|archived|dropped|rejected|abandoned)$/,
  ],
];
const UNKNOWN_RANK = 4;

function statusRank(status: string): number {
  const key = status.toLowerCase().replace(/[\s_']+/g, '-');
  return STATUS_RANKS.find(([, re]) => re.test(key))?.[0] ?? UNKNOWN_RANK;
}

function statusKey(data: Record<string, unknown>): string | null {
  return ['status', 'state'].find((k) => typeof data[k] === 'string' && data[k] !== '') ?? null;
}

const SMALL_WORDS = new Set([
  'an',
  'as',
  'at',
  'be',
  'by',
  'do',
  'go',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'no',
  'of',
  'on',
  'or',
  'so',
  'to',
  'up',
  'us',
  'we',
]);

/** "in-progress" → "In progress"; two-letter words that aren't English words are acronyms ("ui" → "UI"). */
const humanize = (s: string) => {
  const words = s
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length === 2 && !SMALL_WORDS.has(w) ? w.toUpperCase() : w))
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

export interface GitInfo {
  inRepo: boolean;
  baseBranch: string;
  branches: string[];
}

export async function gitInfo(cwd: string, run: Runner = defaultRunner): Promise<GitInfo> {
  const git = async (...args: string[]) => {
    const r = await run('git', args, { cwd });
    return r.ok ? r.stdout.trim() : null;
  };
  if ((await git('rev-parse', '--show-toplevel')) === null)
    return { inRepo: false, baseBranch: 'main', branches: [] };
  const branches = ((await git('for-each-ref', '--format=%(refname:short)', 'refs/heads')) ?? '')
    .split('\n')
    .filter(Boolean);
  const originHead = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const baseBranch =
    originHead?.replace(/^origin\//, '') ||
    ['main', 'master', 'trunk', 'develop'].find((b) => branches.includes(b)) ||
    (await git('branch', '--show-current')) ||
    'main';
  return { inRepo: true, baseBranch, branches };
}

export interface Plan {
  /** The config object to write. */
  config: Record<string, unknown>;
  /** Lines describing what was found, for the summary. */
  summary: string[];
  /** Things the user may want to adjust by hand. */
  hints: string[];
}

const STARTER_STATUSES = ['todo', 'in-progress', 'blocked', 'done'];

/**
 * Works out a config from the task files in `tasksDir`. With `starter`, the usual statuses are
 * added to the ones found, for a project that's only just begun.
 */
export function planConfig(
  configRoot: string,
  tasksDir: string,
  files: TaskFile[],
  git: GitInfo,
  starter = false,
): Plan {
  const inDir = files.filter((f) => f.absPath.startsWith(tasksDir + sep));
  const tasks = inDir.map((f) => f.data);
  const n = tasks.length;
  const summary: string[] = [];
  const hints: string[] = [];
  const share = (key: string) => tasks.filter((t) => !isBlank(t[key])).length / Math.max(n, 1);
  const keys = [...new Set(tasks.flatMap((t) => Object.keys(t)))];

  // Status
  const statusField = ['status', 'state'].find((k) => share(k) >= 0.5) ?? 'status';
  const found = [
    ...new Set(tasks.map((t) => t[statusField]).filter((v) => typeof v === 'string')),
  ] as string[];
  const statuses = [
    ...new Set([...found, ...(starter || !found.length ? STARTER_STATUSES : [])]),
  ].sort((a, b) => statusRank(a) - statusRank(b));

  // Id
  const unique = (k: string) => new Set(tasks.map((t) => String(t[k]))).size === n;
  const idField = ID_KEYS.find((k) => share(k) >= 0.9 && unique(k)) ?? 'id';
  if (n && share(idField) < 0.9)
    hints.push(
      `Give every task file an "${idField}" field; files without one are listed as invalid.`,
    );
  const ids = tasks
    .map((t) => t[idField])
    .filter((v) => !isBlank(v))
    .map(String);
  const prefixed = ids.map((id) => /^([A-Za-z][A-Za-z0-9]*)([-_])(\d+)$/.exec(id));
  let id: Record<string, string> = { field: idField };
  let branchPattern: string | null = null;
  let idExample = ids[0] ?? '';
  const first = prefixed[0];
  if (first && prefixed.every((m) => m && m[1] === first[1] && m[2] === first[2])) {
    const [, prefix, dash] = first;
    id = { field: idField, pattern: `^${prefix}${dash}(\\d+)$`, template: `${prefix}${dash}{n}` };
    branchPattern = `^(?:[\\w.-]+/)?${prefix!.toLowerCase()}[-_](\\d+(?:-\\d+)*)(?:[-_]|$)`;
    const nums = prefixed.map((m) => Number(m![3])).sort((a, b) => a - b);
    idExample =
      nums.length > 1 ? `${prefix}${dash}${nums[0]} … ${prefix}${dash}${nums.at(-1)}` : ids[0]!;
  } else if (ids.length && ids.every((v) => /^\d+$/.test(v))) {
    id = { field: idField, pattern: '^(\\d+)$', template: '{n}' };
    branchPattern = '^(?:task|issue|feat|feature|fix)/(\\d+(?:-\\d+)*)(?:[-_]|$)';
  }

  const titleField = ['title', 'name', 'summary'].find((k) => share(k) >= 0.5) ?? 'title';
  const branchField = keys.find((k) => k === 'branch');
  const prField = keys.find((k) => ['pr', 'pull', 'pull_request', 'pullRequest'].includes(k));

  // Columns, with live state where it fits
  const live = git.inRepo && branchPattern !== null;
  const columns: Array<Record<string, unknown>> = statuses.map((status) => ({
    name: humanize(status),
    status,
    ...(statusRank(status) === 7 ? { collapsed: true } : {}),
  }));
  if (live) {
    const at = (rank: number) => statuses.findIndex((s) => statusRank(s) === rank);
    const lastBefore = (rank: number) => statuses.filter((s) => statusRank(s) < rank).length;
    const progress = at(2);
    if (progress >= 0) columns[progress]!.live = ['in-progress'];
    else columns.splice(lastBefore(2), 0, { name: 'In progress', live: ['in-progress'] });
    const review = statuses.findIndex((s) => statusRank(s) === 3);
    if (review >= 0)
      columns[columns.findIndex((c) => c.status === statuses[review])]!.live = ['in-review'];
    else {
      const after = columns.findIndex((c) =>
        (c.live as string[] | undefined)?.includes('in-progress'),
      );
      columns.splice(after + 1, 0, { name: 'In review', live: ['in-review'] });
    }
  }

  // Other fields: lists, badges, a swimlane and filters
  const fields: Record<string, Record<string, unknown>> = {};
  const roles: Record<string, string[]> = { swimlanes: [], badges: [], filters: [], lists: [] };
  const skip = new Set([idField, titleField, statusField, branchField, prField]);
  for (const key of keys) {
    if (skip.has(key) || share(key) < 0.3) continue;
    const values = tasks.map((t) => t[key]).filter((v) => !isBlank(v));
    if (values.filter(Array.isArray).length >= values.length / 2) {
      fields[key] = { label: humanize(key), list: true };
      roles.lists!.push(key);
      continue;
    }
    if (
      values.some(
        (v) =>
          typeof v === 'object' ||
          (typeof v === 'string' && (v.length > 30 || /^\d{4}-\d{2}-\d{2}/.test(v))),
      )
    )
      continue;
    const distinct = new Set(values.map(String)).size;
    if (distinct > 30 || (distinct === values.length && values.length > 3)) continue;
    if (
      /^(priority|prio|severity|importance|size|estimate|effort|points|complexity|t-?shirt)$/i.test(
        key,
      )
    ) {
      // A short set of badge values becomes the allowed list (rename them to labels later).
      const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];
      const rank = (v: string) => sizes.indexOf(v.toUpperCase());
      const distinctValues = [...new Set(values.map(String))].sort((a, b) =>
        rank(a) >= 0 && rank(b) >= 0
          ? rank(a) - rank(b)
          : a.localeCompare(b, undefined, { numeric: true }),
      );
      const allowed =
        distinctValues.length <= 8 ? Object.fromEntries(distinctValues.map((v) => [v, v])) : null;
      fields[key] = { label: humanize(key), badge: true, ...(allowed ? { values: allowed } : {}) };
      roles.badges!.push(key);
    } else if (
      !roles.swimlanes!.length &&
      /^(phase|milestone|epic|stage|sprint|release|iteration)$/i.test(key)
    ) {
      const values = folderLabels(key, inDir, tasksDir);
      fields[key] = { label: humanize(key), swimlane: true, ...(values ? { values } : {}) };
      roles.swimlanes!.push(key);
    } else {
      fields[key] = { label: humanize(key), filter: true };
      roles.filters!.push(key);
    }
  }

  // Fields every file fills in are required, so `check` and `new` insist on them.
  for (const [key, field] of Object.entries(fields)) {
    const present = field.list
      ? tasks.every((t) => Array.isArray(t[key]))
      : tasks.every((t) => !isBlank(t[key]));
    if (n > 1 && present) field.required = true;
  }

  // How new task files are named and placed, copied from the existing ones.
  const newTask: Record<string, unknown> = {};
  const lane = roles.swimlanes![0];
  if (
    lane &&
    inDir.length &&
    inDir.every((f) => {
      const [folder, ...rest] = relative(tasksDir, f.absPath).split(sep);
      return (
        rest.length > 0 &&
        !isBlank(f.data[lane]) &&
        folderMatchesValue(folder!, String(f.data[lane]))
      );
    })
  )
    newTask.folderBy = lane;
  const named = (make: (id: string) => string) =>
    inDir.length > 0 &&
    inDir.every(
      (f) =>
        !isBlank(f.data[idField]) && basename(f.absPath).startsWith(make(String(f.data[idField]))),
    );
  if (named((v) => `${v.toLowerCase()}-`)) newTask.fileName = '{id-lower}-{slug}.md';
  else if (named((v) => `${v}-`)) newTask.fileName = '{id}-{slug}.md';
  const headed = inDir.filter((f) =>
    f.body?.trimStart().startsWith(`# ${String(f.data[idField])}`),
  ).length;
  if (inDir.length && headed < inDir.length / 2) newTask.heading = false;

  const ignoreStatuses = statuses.filter((s) => statusRank(s) >= 6);
  const config: Record<string, unknown> = {
    tasksDir: displayDir(configRoot, tasksDir),
    id,
    titleField,
    statusField,
    statuses,
    columns,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(Object.keys(newTask).length ? { newTask } : {}),
    ...(live
      ? {
          live: {
            baseBranch: git.baseBranch,
            branchPattern,
            rangePrefixes: [],
            ...(branchField ? { branchField } : {}),
            ...(prField ? { prField } : {}),
            ignoreStatuses,
          },
        }
      : {}),
  };

  if (idExample) summary.push(`ids        ${idExample} (the "${idField}" field)`);
  if (id.template) {
    const folder = newTask.folderBy ? `<${newTask.folderBy} folder>/` : '';
    const file = String(newTask.fileName ?? '{id-lower}-{slug}.md')
      .replace('{id-lower}', id.template.toLowerCase().replace('{n}', '<n>'))
      .replace('{id}', id.template.replace('{n}', '<n>'))
      .replace('{slug}', '<slug>');
    summary.push(`new tasks  ${displayDir(configRoot, tasksDir)}/${folder}${file}`);
  }
  summary.push(
    `statuses   ${statuses.join(', ')}${found.length ? '' : ' (none found yet; edit as you like)'}`,
  );
  summary.push(`columns    ${columns.map((c) => c.name).join(' · ')}`);
  const described = [
    roles.swimlanes!.length ? `${roles.swimlanes!.join(', ')} (swimlanes)` : '',
    roles.badges!.length ? `${roles.badges!.join(', ')} (badges)` : '',
    roles.filters!.length ? `${roles.filters!.join(', ')} (filters)` : '',
    roles.lists!.length ? `${roles.lists!.join(', ')} (lists)` : '',
  ].filter(Boolean);
  if (described.length) summary.push(`fields     ${described.join('; ')}`);
  if (live) {
    const re = new RegExp(branchPattern!);
    const matching = git.branches.filter((b) => re.test(b));
    const example = `task/${id.template!.replace('{n}', '12').toLowerCase()}-…`;
    summary.push(
      `live       branches like ${example}, PRs from gh, base branch ${git.baseBranch}` +
        ` (${matching.length} local branch${matching.length === 1 ? ' matches' : 'es match'} now)`,
    );
    // A branch naming two numbers far apart might mean a range (docs/tui-1-10-…).
    for (const branch of matching) {
      const nums = re.exec(branch)![1]!.split('-').map(Number);
      if (nums.length === 2 && nums[1]! > nums[0]! + 2 && branch.includes('/')) {
        const prefix = branch.slice(0, branch.indexOf('/') + 1);
        hints.push(
          `${branch} names tasks ${nums[0]} and ${nums[1]}. If it means ${nums[0]} to ${nums[1]}, ` +
            `add "${prefix}" to live.rangePrefixes.`,
        );
        break;
      }
    }
  } else if (!git.inRepo) {
    summary.push('live       off: this folder is not in a git repository');
  } else {
    summary.push('live       off: ids have no number to match against branch names');
    hints.push('To show branch and PR state, add a "live" section (see the README).');
  }
  return { config, summary, hints };
}

function displayDir(configRoot: string, tasksDir: string): string {
  return relative(configRoot, tasksDir).split(sep).join('/') || '.';
}

/**
 * Labels for a field's values taken from folder names, when each value's files sit in one folder
 * named after it: phase P2 in p2-vertical-slice/ gets the label "Vertical slice".
 */
function folderLabels(
  key: string,
  files: TaskFile[],
  tasksDir: string,
): Record<string, string> | null {
  const folders = new Map<string, Set<string>>();
  for (const f of files) {
    const value = f.data[key];
    const [folder, ...rest] = relative(tasksDir, f.absPath).split(sep);
    if (isBlank(value) || !rest.length) return null;
    folders.set(String(value), (folders.get(String(value)) ?? new Set()).add(folder!));
  }
  const labels: Record<string, string> = {};
  const values = [...folders.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const value of values) {
    const [folder, ...others] = folders.get(value)!;
    const prefix = `${value.toLowerCase()}-`;
    if (
      others.length ||
      !folder!.toLowerCase().startsWith(prefix) ||
      folder!.length === prefix.length
    )
      return null;
    labels[value] = humanize(folder!.slice(prefix.length));
  }
  return labels;
}

/**
 * Pretty JSON that keeps short objects and arrays on one line. `column` is where the value
 * starts on its line, which can be past `indent` when it follows a key.
 */
export function formatJson(value: unknown, indent = 0, width = 100, column = indent): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      return entries.length
        ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
        : '{}';
    }
    return JSON.stringify(v);
  };
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const one = inline(value);
  if (indent > 0 && column + one.length < width) return one;
  const pad = ' '.repeat(indent + 2);
  const items = Array.isArray(value)
    ? value.map((v) => pad + formatJson(v, indent + 2, width))
    : Object.entries(value).map(([k, v]) => {
        const key = `${pad}${JSON.stringify(k)}: `;
        return key + formatJson(v, indent + 2, width, key.length);
      });
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${items.join(',\n')}\n${' '.repeat(indent)}${close}`;
}

const EXAMPLE_TASK = `---
id: TASK-1
title: Try the board
status: todo
priority: P1
---

# TASK-1 Try the board

Drag this card to another column: only the \`status:\` line in this file changes.

To add a task, add a markdown file to this folder with an \`id\`, a \`title\` and a \`status\` in its
frontmatter.
`;

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? DEFAULT_CONFIG_FILE);
  const configRoot = dirname(configPath);
  const configName = relative(cwd, configPath) || basename(configPath);
  const prompter = options.yes ? undefined : options.prompter;
  const ask = (question: string, fallback: string) =>
    prompter ? prompter.ask(question, fallback) : Promise.resolve(fallback);
  const yes = async (question: string, fallback = true) =>
    /^y/i.test(await ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `, fallback ? 'y' : 'n'));

  if (existsSync(configPath) && !options.force) {
    if (!prompter || !(await yes(`${configName} already exists. Replace it?`, false))) {
      log(`${configName} already exists. Run boardmd init --force to replace it.`);
      return { code: 1 };
    }
  }

  const git = await gitInfo(configRoot, options.runner);
  log('Looking for task files…');
  const files = await findTaskFiles(configRoot);
  let tasksDir: string | null = options.tasksDir
    ? resolve(cwd, options.tasksDir)
    : pickTasksDir(configRoot, files);
  let created = false;

  if (!tasksDir || !files.some((f) => f.absPath.startsWith(tasksDir + sep))) {
    if (options.tasksDir) {
      log(
        `No task files in ${options.tasksDir} (markdown files with a status in their frontmatter).`,
      );
    } else {
      log('No task files found here (markdown files with YAML frontmatter that has a status).');
    }
    if (!(await yes('Create a tasks/ folder with an example task to start from?'))) {
      log('Nothing written. Run boardmd init --tasks-dir <folder> once your task files exist.');
      return { code: 1 };
    }
    tasksDir = options.tasksDir ? resolve(cwd, options.tasksDir) : join(configRoot, 'tasks');
    const example = join(tasksDir, 'task-1-try-the-board.md');
    await mkdir(tasksDir, { recursive: true });
    if (!existsSync(example)) await writeFile(example, EXAMPLE_TASK);
    files.push({ absPath: example, data: parseFrontmatter(EXAMPLE_TASK).data });
    created = true;
    log(`Created ${relative(cwd, example)}.`);
  }

  // Let the user pick another folder, then show what was worked out.
  let plan: Plan;
  for (;;) {
    const inDir = files.filter((f) => f.absPath.startsWith(tasksDir + sep));
    plan = planConfig(configRoot, tasksDir, files, git, created);
    const shown = relative(cwd, tasksDir) || '.';
    log('');
    log(`Found ${inDir.length} task file${inDir.length === 1 ? '' : 's'} in ${shown}`);
    for (const line of plan.summary) log(`  ${line}`);
    const elsewhere = files.length - inDir.length;
    if (elsewhere > 0)
      log(
        `  (${elsewhere} other markdown file${elsewhere === 1 ? ' has' : 's have'} a status outside it, and won't be shown)`,
      );
    log('');
    if (created || options.tasksDir || !prompter) break;
    const answer = await ask(`Tasks folder (${shown}): `, shown);
    const chosen = resolve(cwd, answer);
    if (chosen === tasksDir) break;
    if (!(await stat(chosen).catch(() => null))?.isDirectory()) {
      log(`${answer} is not a folder.`);
      continue;
    }
    tasksDir = chosen;
  }

  // Never write a config the board would reject.
  parseConfig(plan.config, configName);
  if (!(await yes(`Write ${configName}?`))) {
    log('Nothing written.');
    return { code: 1 };
  }
  await writeFile(configPath, `${formatJson(plan.config)}\n`);
  const loaded = await loadConfig(configPath);
  const { tasks, invalid } = await readTasks(loaded);
  log(
    `Wrote ${configName}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} load${invalid.length ? `, ${invalid.length} file(s) are invalid (the board lists why)` : ''}.`,
  );
  for (const hint of plan.hints) log(`  Tip: ${hint}`);

  const run = await addScript(configRoot, yes, log);
  await installAgentFiles(loaded, tasks, { yes, log, ...(options.force ? { force: true } : {}) });
  log('');
  if (!options.thenServe) log(`Start the board: ${run}`);
  return { code: 0, configPath };
}

/** Offers to add a script that starts the board; returns the command to run it. */
async function addScript(
  root: string,
  yes: (question: string, fallback?: boolean) => Promise<boolean>,
  log: (line: string) => void,
): Promise<string> {
  const fallback = 'npx boardmd serve --open';
  const pkgPath = join(root, 'package.json');
  let text: string;
  try {
    text = await readFile(pkgPath, 'utf8');
  } catch {
    return fallback;
  }
  let pkg: { scripts?: Record<string, string>; packageManager?: string };
  try {
    pkg = JSON.parse(text);
  } catch {
    return fallback;
  }
  const command = 'boardmd serve --open';
  const pm =
    pkg.packageManager?.startsWith('pnpm') || existsSync(join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : pkg.packageManager?.startsWith('yarn') || existsSync(join(root, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
          ? 'bun run'
          : 'npm run';
  const existing = Object.entries(pkg.scripts ?? {}).find(([, cmd]) => cmd === command);
  if (existing) return `${pm} ${existing[0]}`;
  const name = ['board', 'board:web', 'boardmd'].find((n) => !pkg.scripts?.[n]);
  if (!name || !(await yes(`Add a "${name}" script to package.json?`))) return fallback;
  pkg.scripts = { ...pkg.scripts, [name]: command };
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`);
  log(`Added "${name}": "${command}" to package.json.`);
  return `${pm} ${name}`;
}
