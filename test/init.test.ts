import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBoard } from '../src/board.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { findTaskFiles, formatJson, pickTasksDir, runInit, type Prompter } from '../src/init.js';
import { GitState } from '../src/live.js';
import { readTasks } from '../src/tasks.js';
import { copyFixture, FIXTURE, fakeRunner } from './helpers.js';

/** Answers questions in order, and records them. */
function answers(...replies: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question, fallback) => {
      asked.push(question.trim());
      return replies.shift() || fallback;
    },
    close: () => {},
  };
}

describe('boardmd init', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let lines: string[];
  const log = (line: string) => lines.push(line);
  const config = async () => JSON.parse(await readFile(join(dir, 'boardmd.config.json'), 'utf8'));

  beforeEach(async () => {
    ({ dir, cleanup } = await copyFixture());
    await rm(join(dir, 'boardmd.config.json'));
    lines = [];
  });
  afterEach(() => cleanup());

  it('works out the hand-written fixture config from the task files', async () => {
    const result = await runInit({ cwd: dir, yes: true, runner: fakeRunner({}), log });
    expect(result.code).toBe(0);
    const written = await config();
    const expected = JSON.parse(await readFile(join(FIXTURE, 'boardmd.config.json'), 'utf8'));
    // Not a git repository, so no live state or live-only columns.
    delete expected.live;
    expected.columns = expected.columns
      .filter((c: { status?: string }) => c.status)
      .map(({ live: _live, ...c }: { live?: string[] }) => c);
    // Rules can't be guessed, and badge labels ("Must" for P0) start as the values themselves.
    delete expected.rules;
    expected.fields.priority.values = { P0: 'P0', P1: 'P1', P2: 'P2' };
    expect(written).toEqual(expected);
    expect(Object.keys(written.fields.size.values)).toEqual(['S', 'M', 'L']);
    expect(lines.join('\n')).toContain('Found 6 task files in tasks');
    expect(lines.join('\n')).toContain('new tasks  tasks/<phase folder>/demo-<n>-<slug>.md');
    expect(lines.join('\n')).toContain('live       off: this folder is not in a git repository');
  });

  it('turns on live state in a git repo, and the board uses it', async () => {
    const runner = fakeRunner({
      top: dir,
      branches: ['main', 'task/demo-4-projects-crud'],
      prs: [],
    });
    expect((await runInit({ cwd: dir, yes: true, runner, log })).code).toBe(0);
    const written = await config();
    expect(written.live).toEqual({
      baseBranch: 'main',
      branchPattern: '^(?:[\\w.-]+/)?demo[-_](\\d+(?:-\\d+)*)(?:[-_]|$)',
      rangePrefixes: [],
      branchField: 'branch',
      prField: 'pr',
      ignoreStatuses: ['done', 'deferred'],
    });
    expect(written.columns.map((c: { name: string }) => c.name)).toEqual([
      'Todo',
      'In progress',
      'In review',
      'Blocked',
      'Done',
      'Deferred',
    ]);
    expect(lines.join('\n')).toContain('(1 local branch matches now)');

    const loaded = await loadConfig(join(dir, 'boardmd.config.json'));
    const board = await buildBoard(loaded, new GitState(runner, loaded.tasksDir, loaded.root));
    expect(board.tasks.find((t) => t.id === 'DEMO-4')?.live?.branch).toBe(
      'task/demo-4-projects-crud',
    );
    expect(board.invalid).toEqual([]);
  });

  it('writes JSON that keeps short values on one line', async () => {
    await runInit({ cwd: dir, yes: true, runner: fakeRunner({}), log });
    const text = await readFile(join(dir, 'boardmd.config.json'), 'utf8');
    expect(text).toContain(
      '\n  "id": { "field": "id", "pattern": "^DEMO-(\\\\d+)$", "template": "DEMO-{n}" },\n',
    );
    expect(text).toContain('\n    { "name": "Todo", "status": "todo" },\n');
    expect(formatJson({ a: [1, 2], b: { c: 'x'.repeat(120) } })).toBe(
      `{\n  "a": [1, 2],\n  "b": {\n    "c": "${'x'.repeat(120)}"\n  }\n}`,
    );
  });

  it('labels swimlane values from folder names', async () => {
    await mkdir(join(dir, 'tasks', 'p3-ui-polish'));
    await writeFile(
      join(dir, 'tasks', 'p3-ui-polish', 'demo-7-tooltips.md'),
      '---\nid: DEMO-7\ntitle: Tooltips\nstatus: todo\nphase: P3\nmodule: web\npriority: P2\nsize: S\nendpoints: []\n---\n',
    );
    await runInit({ cwd: dir, yes: true, runner: fakeRunner({}), log });
    expect((await config()).fields.phase.values).toEqual({
      P1: 'Foundation',
      P2: 'Features',
      P3: 'UI polish',
    });
  });

  it('adds a script to package.json, picking a free name and the package manager', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: 'x', packageManager: 'pnpm@11.0.0', scripts: { board: 'node old.js' } },
        null,
        2,
      ),
    );
    await runInit({ cwd: dir, yes: true, runner: fakeRunner({}), log });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts).toEqual({ board: 'node old.js', 'board:web': 'boardmd serve --open' });
    expect(lines.at(-1)).toBe('Start the board: pnpm board:web');
  });

  it('asks before writing, and can be told no', async () => {
    await writeFile(join(dir, 'package.json'), '{ "name": "x" }\n');
    const prompter = answers('', 'y', 'n', 'n', 'n');
    await runInit({ cwd: dir, prompter, runner: fakeRunner({}), log });
    expect(prompter.asked).toEqual([
      'Use tasks as the tasks folder? (Y/n)',
      'Write boardmd.config.json? (Y/n)',
      'Add a "board" script to package.json? (Y/n)',
      'Create AGENTS.md with instructions for coding agents? (Y/n)',
      'Add a Claude Code skill for managing tasks (.claude/skills/boardmd)? (Y/n)',
    ]);
    expect(existsSync(join(dir, 'boardmd.config.json'))).toBe(true);
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{ "name": "x" }\n');
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(lines.at(-1)).toBe('Start the board: npx boardmd serve --open');
  });

  it('lets the user pick another folder', async () => {
    const prompter = answers('n', 'tasks/p2-features', '', 'y');
    await runInit({ cwd: dir, prompter, runner: fakeRunner({}), log });
    expect((await config()).tasksDir).toBe('tasks/p2-features');
    expect(lines.join('\n')).toContain('Found 3 task files in tasks/p2-features');
  });

  it("doesn't replace a config unless told to", async () => {
    await writeFile(join(dir, 'boardmd.config.json'), '{}\n');
    expect((await runInit({ cwd: dir, yes: true, runner: fakeRunner({}), log })).code).toBe(1);
    expect(await readFile(join(dir, 'boardmd.config.json'), 'utf8')).toBe('{}\n');
    expect(lines).toContain(
      'boardmd.config.json already exists. Run boardmd init --force to replace it.',
    );
    expect(
      (await runInit({ cwd: dir, yes: true, force: true, runner: fakeRunner({}), log })).code,
    ).toBe(0);
    expect((await config()).tasksDir).toBe('tasks');
  });

  it('ignores other files with a status, such as decision records', async () => {
    await mkdir(join(dir, 'docs', 'adr'), { recursive: true });
    for (const n of [1, 2, 3, 4])
      await writeFile(
        join(dir, 'docs', 'adr', `${n}.md`),
        `---\ntitle: Decision ${n}\nstatus: accepted\n---\n`,
      );
    const files = await findTaskFiles(dir);
    expect(files).toHaveLength(10);
    expect(pickTasksDir(dir, files)).toBe(join(dir, 'tasks'));
  });
});

describe('boardmd init in an empty project', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'boardmd-init-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('creates a tasks folder with an example task', async () => {
    const lines: string[] = [];
    const result = await runInit({
      cwd: dir,
      yes: true,
      runner: fakeRunner({}),
      log: (l) => lines.push(l),
    });
    expect(result.code).toBe(0);
    const written = JSON.parse(await readFile(join(dir, 'boardmd.config.json'), 'utf8'));
    expect(written.statuses).toEqual(['todo', 'in-progress', 'blocked', 'done']);
    expect(written.id).toEqual({ field: 'id', pattern: '^TASK-(\\d+)$', template: 'TASK-{n}' });
    parseConfig(written);
    const { tasks, invalid } = await readTasks(await loadConfig(join(dir, 'boardmd.config.json')));
    expect(tasks.map((t) => [t.id, t.status])).toEqual([['TASK-1', 'todo']]);
    expect(invalid).toEqual([]);
  });

  it('writes nothing when the user declines', async () => {
    const result = await runInit({
      cwd: dir,
      prompter: answers('n'),
      runner: fakeRunner({}),
      log: () => {},
    });
    expect(result.code).toBe(1);
    expect(existsSync(join(dir, 'boardmd.config.json'))).toBe(false);
    expect(existsSync(join(dir, 'tasks'))).toBe(false);
  });
});
