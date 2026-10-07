import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { copyFixture, fakeRunner, pr } from './helpers.js';

const P1 = 'tasks/p1-foundation';
const P2 = 'tasks/p2-features';

describe('agent commands', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let out: string;
  let err: string;
  const runner = () =>
    fakeRunner({
      top: dir,
      branches: ['main', 'task/demo-4-projects-crud'],
      prs: [
        pr(7, 'task/demo-5-comments', { isDraft: true }),
        pr(30, 'task/demo-3-x', { state: 'MERGED' }),
      ],
    });
  const run = async (...argv: string[]) => {
    out = '';
    err = '';
    return main([...argv, '--config', join(dir, 'boardmd.config.json')], { runner: runner() });
  };
  const json = () => JSON.parse(out);
  const file = (path: string) => readFile(join(dir, path), 'utf8');

  beforeEach(async () => {
    ({ dir, cleanup } = await copyFixture());
    vi.spyOn(console, 'log').mockImplementation(
      (...a: unknown[]) => void (out += `${a.join(' ')}\n`),
    );
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void (err += `${a.join(' ')}\n`),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  describe('list', () => {
    it('prints JSON in the shape scripts/board.mjs --json used', async () => {
      const demo3 = join(dir, P1, 'demo-3-database-schema.md');
      await writeFile(demo3, (await readFile(demo3, 'utf8')).replace('pr:\n', 'pr: 30\n'));
      expect(await run('list', '--json')).toBe(0);
      const tasks = json();
      expect(tasks.map((t: { id: string }) => t.id)).toEqual([
        'DEMO-2',
        'DEMO-3',
        'DEMO-4',
        'DEMO-5',
      ]);
      expect(tasks[2]).toEqual({
        id: 'DEMO-4',
        title: 'Projects CRUD',
        status: 'todo',
        phase: 'P2',
        module: 'projects',
        priority: 'P0',
        size: 'M',
        endpoints: ['GET|POST /projects', 'PATCH|DELETE /projects/{id}'],
        branch: null,
        pr: null,
        file: `${P2}/demo-4-projects-crud.md`,
        folder: 'p2-features',
        filename: 'demo-4-projects-crud.md',
        live: { state: 'in-progress', branch: 'task/demo-4-projects-crud' },
      });
      expect(tasks[3].live).toEqual({ state: 'in-review', pr: 7, base: 'main', note: 'draft' });
      expect(tasks[1].live).toEqual({
        state: 'merged',
        pr: 30,
        note: 'merged; file not marked done',
      });
      expect(tasks[0].live).toBeUndefined();
    });

    it('filters by status and by field, and --all adds finished tasks', async () => {
      await run('list', '--json', '--all');
      expect(json()).toHaveLength(6);
      await run('list', '--json', '--status', 'done');
      expect(json().map((t: { id: string }) => t.id)).toEqual(['DEMO-1']);
      await run('list', '--json', '--all', '--phase', 'P1');
      expect(json().map((t: { id: string }) => t.id)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3']);
      await run('list', '--json', '--where', 'module=projects', '--where', 'module=infra');
      expect(json().map((t: { id: string }) => t.id)).toEqual(['DEMO-3', 'DEMO-4', 'DEMO-5']);
      expect(await run('list', '--colour', 'red')).toBe(1);
      expect(err).toContain("Unknown option '--colour'");
    });

    it('prints tables by phase, also as plain `boardmd`', async () => {
      expect(await run()).toBe(0);
      expect(out).toContain(
        '# Board: 6 tasks · 0 todo · 2 in progress · 1 in review · 1 blocked · 1 done · 1 deferred',
      );
      expect(out).toContain('next id DEMO-7');
      expect(out).toContain('## P1 Foundation');
      expect(out).toContain(
        '| DEMO-4 | Projects CRUD | in progress (task/demo-4-projects-crud) | P0 | M | projects |  |',
      );
      expect(out).toContain('| DEMO-5 | Comments on projects | in review #7 (draft) |');
      await run('--json', '--all');
      expect(json()).toHaveLength(6);
    });
  });

  it('shows one task', async () => {
    expect(await run('show', 'DEMO-5')).toBe(0);
    expect(out).toContain('DEMO-5 Comments on projects\n  status: in review #7 (draft)\n');
    expect(out).toContain('Plain text only for now.');
    await run('show', 'DEMO-5', '--json');
    expect(json()).toMatchObject({
      id: 'DEMO-5',
      body: expect.stringContaining('Plain text only'),
    });
    expect(await run('show', 'DEMO-99')).toBe(1);
  });

  describe('new', () => {
    it('creates a task with the next id, in the right folder, like the other files', async () => {
      const code = await run(
        'new',
        'Export projects as CSV',
        '--set',
        'phase=P2',
        '--set',
        'module=projects',
        '--set',
        'priority=P1',
        '--set',
        'size=S',
        '--set',
        'endpoints=GET /projects/export',
        '--body',
        'One row per project.',
      );
      expect(code).toBe(0);
      expect(out).toBe(`Created DEMO-7: ${P2}/demo-7-export-projects-as-csv.md\n`);
      expect(await file(`${P2}/demo-7-export-projects-as-csv.md`)).toBe(
        [
          '---',
          'id: DEMO-7',
          'title: Export projects as CSV',
          'status: todo',
          'phase: P2',
          'module: projects',
          'priority: P1',
          'size: S',
          'endpoints:',
          '  - GET /projects/export',
          'branch:',
          'pr:',
          '---',
          '',
          '# DEMO-7 Export projects as CSV',
          '',
          'One row per project.',
          '',
        ].join('\n'),
      );
      expect(await run('check')).toBe(0);
    });

    it('says which fields are missing or wrong, and writes nothing', async () => {
      expect(await run('new', 'Half a task', '--set', 'priority=P9')).toBe(1);
      expect(err).toContain('priority must be one of: P0, P1, P2');
      expect(err).toContain(
        'set phase (P1, P2), module, size (S, M, L) with --set <field>=<value>',
      );
      await run('list', '--json', '--all');
      expect(json()).toHaveLength(6);
    });

    it('quotes titles that need it, and --dry-run and --json', async () => {
      const args = [
        'new',
        'Decide: email provider',
        '--set',
        'phase=P1',
        '--set',
        'module=decisions',
        '--set',
        'priority=P0',
        '--set',
        'size=S',
      ];
      expect(await run(...args, '--dry-run')).toBe(0);
      expect(out).toContain(`Would create DEMO-7: ${P1}/demo-7-decide-email-provider.md`);
      expect(out).toContain("title: 'Decide: email provider'");
      expect(existsSync(join(dir, P1, 'demo-7-decide-email-provider.md'))).toBe(false);
      expect(await run(...args, '--json')).toBe(0);
      expect(json()).toMatchObject({
        id: 'DEMO-7',
        title: 'Decide: email provider',
        folder: 'p1-foundation',
      });
    });
  });

  describe('set', () => {
    it('changes only the given lines', async () => {
      const before = await file(`${P2}/demo-5-comments.md`);
      expect(await run('set', 'DEMO-5', 'status=blocked', 'pr=12', '--offline')).toBe(0);
      expect(out).toBe('DEMO-5: status todo → blocked, pr (none) → 12\n');
      expect(await file(`${P2}/demo-5-comments.md`)).toBe(
        before.replace('status: todo\n', 'status: blocked\n').replace('pr:\n', 'pr: 12\n'),
      );
      await run('show', 'DEMO-5', '--json', '--offline');
      expect(json().pr).toBe(12);
    });

    it('warns, but writes, when git shows the task in progress', async () => {
      expect(await run('set', 'DEMO-4', 'status=done')).toBe(0);
      expect(err).toContain('Warning: DEMO-4 is in progress (task/demo-4-projects-crud)');
      expect(await file(`${P2}/demo-4-projects-crud.md`)).toContain('status: done\n');
    });

    it('clears values, adds missing fields and refuses bad values', async () => {
      await run('set', 'DEMO-1', 'branch=', 'reviewer=sam', '--offline');
      const text = await file(`${P1}/demo-1-set-up-repo.md`);
      expect(text).toContain('branch:\npr: 1\nreviewer: sam\n---');
      expect(await run('set', 'DEMO-1', 'size=XL')).toBe(1);
      expect(err).toContain('size must be one of: S, M, L');
      expect(await run('set', 'DEMO-1', 'id=DEMO-9')).toBe(1);
      expect(await run('set', 'DEMO-99', 'status=done')).toBe(1);
      expect(await run('set', 'DEMO-1', 'status')).toBe(1);
    });

    it('moves the file when the folder field changes', async () => {
      expect(await run('set', 'DEMO-5', 'phase=P1', '--offline')).toBe(0);
      expect(out).toContain(`Moved DEMO-5 to ${P1}/demo-5-comments.md`);
      expect(existsSync(join(dir, P2, 'demo-5-comments.md'))).toBe(false);
      expect(await run('check')).toBe(0);
    });
  });

  describe('check', () => {
    it('passes on good files', async () => {
      expect(await run('check')).toBe(0);
      expect(out).toBe('6 task files OK\n');
      expect(await run('--check')).toBe(0);
    });

    it('lists every problem and exits 1', async () => {
      const demo5 = join(dir, P2, 'demo-5-comments.md');
      await writeFile(
        demo5,
        (await readFile(demo5, 'utf8'))
          .replace('priority: P1', 'priority: P9')
          .replace('module: projects\n', '')
          .replace('status: todo', 'status: done')
          .replace('branch:', 'branch: task/demo-5-comments')
          .replace('phase: P2', 'phase: P1'),
      );
      await rename(join(dir, P2, 'demo-4-projects-crud.md'), join(dir, P2, 'projects-crud.md'));
      expect(await run('check')).toBe(1);
      expect(err.trim().split('\n')).toEqual([
        `${P2}/demo-5-comments.md: missing module`,
        `${P2}/demo-5-comments.md: priority must be one of: P0, P1, P2`,
        `${P2}/demo-5-comments.md: phase P1 belongs in tasks/p1-foundation/`,
        `${P2}/projects-crud.md: file name must look like demo-4-<slug>.md`,
      ]);
      await run('check', '--json');
      expect(json().count).toBe(6);
    });

    it('applies the config rules', async () => {
      const demo4 = join(dir, P2, 'demo-4-projects-crud.md');
      await writeFile(
        demo4,
        (await readFile(demo4, 'utf8'))
          .replace('status: todo', 'status: done')
          .replace('branch:', 'branch: task/demo-4-x'),
      );
      expect(await run('check')).toBe(1);
      expect(err).toBe(`${P2}/demo-4-projects-crud.md: done with a branch but no pr\n`);
    });
  });

  describe('guide', () => {
    it("prints this repo's rules", async () => {
      expect(await run('guide')).toBe(0);
      expect(out).toContain('Tasks are markdown files in `tasks/`');
      expect(out).toContain(
        'npx boardmd new "<title>" --set phase=P2 --set module=infra --set priority=P1 --set size=M',
      );
      expect(out).toContain('next id (now DEMO-7)');
      expect(out).toContain(
        '| `priority` (Priority) | `P0` Must, `P1` Should, `P2` Could; required |',
      );
      expect(out).toContain('`task/demo-1-<slug>`');
      expect(out).toContain(
        '- If status is done and branch is set (unless phase is P1): pr is required.',
      );
    });

    it('adds a section to CLAUDE.md and a skill, and updates them in place', async () => {
      await writeFile(join(dir, 'CLAUDE.md'), '# Project\n\nOur rules.\n');
      expect(await run('guide', '--install', '--yes')).toBe(0);
      const claude = await file('CLAUDE.md');
      expect(claude).toMatch(
        /^# Project\n\nOur rules\.\n\n<!-- boardmd:start -->\n## Tasks \(board\.md\)\n/,
      );
      expect(claude.trimEnd().endsWith('<!-- boardmd:end -->')).toBe(true);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
      const skill = await file('.claude/skills/boardmd/SKILL.md');
      expect(skill).toMatch(
        /^---\nname: boardmd\ndescription: Read, create and update this repo's tasks/,
      );

      await writeFile(
        join(dir, 'CLAUDE.md'),
        claude.replace('## Tasks (board.md)', '## Old') + '\nMore rules.\n',
      );
      await run('guide', '--install', '--yes');
      const again = await file('CLAUDE.md');
      expect(again).toContain('## Tasks (board.md)');
      expect(again).not.toContain('## Old');
      expect(again.endsWith('\nMore rules.\n')).toBe(true);
      expect(out).toContain('.claude/skills/boardmd/SKILL.md is up to date.');
    });
  });
});
