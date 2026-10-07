import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type LoadedConfig } from '../src/config.js';
import type { PullRequest, Runner } from '../src/live.js';
import type { Task } from '../src/tasks.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/basic/', import.meta.url));

/** Copies the basic fixture to a temp folder, so tests can write to it. */
export async function copyFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'boardmd-'));
  await cp(FIXTURE, dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function loaded(dir: string, overrides: Record<string, unknown> = {}): LoadedConfig {
  const raw = {
    tasksDir: 'tasks',
    id: { field: 'id', pattern: '^DEMO-(\\d+)$', template: 'DEMO-{n}' },
    titleField: 'title',
    statusField: 'status',
    statuses: ['todo', 'in-progress', 'blocked', 'done', 'deferred'],
    columns: [
      { name: 'Todo', status: 'todo' },
      { name: 'In progress', status: 'in-progress', live: ['in-progress'] },
      { name: 'In review', live: ['in-review'] },
      { name: 'Blocked', status: 'blocked' },
      { name: 'Done', status: 'done' },
      { name: 'Deferred', status: 'deferred', collapsed: true },
    ],
    fields: {
      phase: { label: 'Phase', swimlane: true, values: { P1: 'Foundation', P2: 'Features' } },
      module: { label: 'Module', filter: true },
      priority: { label: 'Priority', badge: true, values: { P0: 'Must', P1: 'Should', P2: 'Could' } },
    },
    live: {
      baseBranch: 'main',
      branchPattern: '^(?:task|docs|fix)/demo-(\\d+(?:-\\d+)*)-[a-z]',
      rangePrefixes: ['docs/'],
      branchField: 'branch',
      prField: 'pr',
      ignoreStatuses: ['done', 'deferred'],
    },
    ...overrides,
  };
  const config = parseConfig(raw, 'test config');
  return { config, path: join(dir, 'boardmd.config.json'), root: dir, tasksDir: join(dir, config.tasksDir) };
}

/** A made-up task, for tests that don't need files. */
export function task(id: string, status: string, data: Record<string, unknown> = {}): Task {
  return {
    id,
    num: Number(id.replace(/\D/g, '')),
    title: id,
    status,
    data: { id, status, ...data },
    file: `tasks/${id.toLowerCase()}.md`,
    absPath: `/repo/tasks/${id.toLowerCase()}.md`,
    version: 'v',
    editable: true,
    body: '',
  };
}

export function pr(number: number, headRefName: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    state: 'OPEN',
    headRefName,
    baseRefName: 'main',
    isDraft: false,
    reviewDecision: null,
    ...extra,
  };
}

/** A runner that answers git and gh from canned output. Anything unlisted fails. */
export function fakeRunner(answers: {
  branches?: string[] | null;
  prs?: PullRequest[] | null;
  current?: string;
  status?: string;
  remote?: string;
  top?: string;
}): Runner & { calls: string[] } {
  const calls: string[] = [];
  const runner: Runner = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const ok = (stdout: string) => ({ ok: true as const, stdout });
    const fail = { ok: false as const, error: `spawn ${cmd} ENOENT` };
    if (cmd === 'gh') return answers.prs ? ok(JSON.stringify(answers.prs)) : fail;
    if (cmd !== 'git') return fail;
    if (args[0] === 'for-each-ref') return answers.branches ? ok(answers.branches.join('\n') + '\n') : fail;
    if (answers.top === undefined) return fail;
    if (args[0] === 'branch') return ok(`${answers.current ?? 'main'}\n`);
    if (args[0] === 'remote') return answers.remote ? ok(`${answers.remote}\n`) : fail;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(`${answers.top}\n`);
    if (args[0] === 'rev-parse') return fail;
    if (args[0] === 'status') return ok(answers.status ?? '');
    return fail;
  };
  return Object.assign(runner, { calls });
}
