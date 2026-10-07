import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Board } from '../src/board.js';
import type { LoadedConfig } from '../src/config.js';
import type { Runner } from '../src/live.js';
import { startServer, type RunningServer } from '../src/server.js';
import { copyFixture, fakeRunner, loaded, pr } from './helpers.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

/** A raw HTTP request, so tests control the Host and Origin headers. */
function send(
  server: RunningServer,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; host?: string } = {},
): Promise<Reply> {
  const host = options.host ?? `127.0.0.1:${server.port}`;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path,
        headers: {
          Host: host,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const FILE = 'tasks/p2-features/demo-4-projects-crud.md';

describe('the server', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: RunningServer;
  let config: LoadedConfig;

  const start = async (runner: Runner, extra: Record<string, unknown> = {}, offline = false) => {
    config = loaded(dir, extra);
    server = await startServer({ loaded: config, port: 0, runner, watch: false, offline });
  };
  const write = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    send(server, 'PATCH', path, {
      body,
      headers: {
        Origin: `http://127.0.0.1:${server.port}`,
        'X-Boardmd-Token': server.token,
        ...headers,
      },
    });
  const board = async (): Promise<Board> => (await send(server, 'GET', '/api/board')).json();
  const version = async (id: string) => (await board()).tasks.find((t) => t.id === id)!.version;

  beforeEach(async () => {
    ({ dir, cleanup } = await copyFixture());
  });
  afterEach(async () => {
    await server?.close();
    await cleanup();
  });

  describe('reading', () => {
    it('serves the page with the write token', async () => {
      await start(fakeRunner({}));
      const page = await send(server, 'GET', '/');
      expect(page.status).toBe(200);
      expect(page.text).toContain(`<meta name="boardmd-token" content="${server.token}"`);
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      expect((await send(server, 'GET', '/assets/app.js')).status).toBe(200);
      expect((await send(server, 'GET', '/assets/../package.json')).status).toBe(404);
      expect((await send(server, 'GET', '/assets/index.html')).status).toBe(404);
    });

    it('returns the board with live state', async () => {
      await start(
        fakeRunner({
          top: dir,
          branches: ['main', 'task/demo-4-projects-crud'],
          prs: [pr(7, 'task/demo-5-comments', { isDraft: true })],
          remote: 'git@github.com:acme/demo.git',
          current: 'main',
        }),
      );
      const b = await board();
      expect(b.notes).toEqual([]);
      expect(b.branch).toBe('main');
      expect(b.repoUrl).toBe('https://github.com/acme/demo');
      expect(b.columns.map((c) => `${c.name} ${c.count}`)).toEqual([
        'Todo 0',
        'In progress 2',
        'In review 1',
        'Blocked 1',
        'Done 1',
        'Deferred 1',
      ]);
      const demo4 = b.tasks.find((t) => t.id === 'DEMO-4')!;
      expect(demo4).toMatchObject({
        file: FILE,
        status: 'todo',
        live: { state: 'in-progress', branch: 'task/demo-4-projects-crud' },
        editable: true,
      });
      expect(demo4.version).toMatch(/^[0-9a-f]{40}$/);
      expect(b.tasks.find((t) => t.id === 'DEMO-5')?.live).toMatchObject({ state: 'in-review', pr: 7, note: 'draft' });
    });

    it('still loads without git or gh, with a note', async () => {
      await start(fakeRunner({ branches: null, prs: null }));
      const b = await board();
      expect(b.tasks).toHaveLength(6);
      expect(b.branch).toBeNull();
      expect(b.notes).toEqual([
        'Branch state unavailable: this is not a git repository, or git is not installed.',
        'PR state unavailable: gh is not installed.',
      ]);
    });

    it('says when gh is signed out', async () => {
      const runner: Runner = async (cmd, args, options) =>
        cmd === 'gh'
          ? { ok: false, error: 'To get started with GitHub CLI, please run:  gh auth login' }
          : fakeRunner({ top: dir, branches: [] })(cmd, args, options);
      await start(runner);
      expect((await board()).notes).toEqual(['PR state unavailable: gh is not signed in (run gh auth login).']);
    });

    it('skips git and gh lookups with --offline', async () => {
      const runner = fakeRunner({ top: dir, branches: ['task/demo-4-x'], prs: [] });
      await start(runner, {}, true);
      const b = await board();
      expect(b.notes[0]).toMatch(/^Offline/);
      expect(b.tasks.every((t) => t.live === null)).toBe(true);
      expect(runner.calls.some((c) => c.startsWith('gh') || c.startsWith('git for-each-ref'))).toBe(false);
    });

    it('lists invalid files instead of failing', async () => {
      await writeFile(join(dir, 'tasks', 'notes.md'), '# Not a task\n');
      await writeFile(join(dir, 'tasks', 'copy.md'), '---\nid: DEMO-1\nstatus: todo\n---\n');
      await start(fakeRunner({}));
      const b = await board();
      expect(b.tasks.map((t) => t.id)).toEqual(['DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
      expect(b.invalid).toEqual([
        { file: 'tasks/copy.md', error: 'duplicate id DEMO-1 (also in tasks/p1-foundation/demo-1-set-up-repo.md)' },
        { file: 'tasks/notes.md', error: 'no frontmatter (the file must start with a --- line)' },
        { file: 'tasks/p1-foundation/demo-1-set-up-repo.md', error: 'duplicate id DEMO-1 (also in tasks/copy.md)' },
      ]);
    });

    it('lists uncommitted task files', async () => {
      await start(fakeRunner({ top: dir, status: ` M ${FILE}\0?? tasks/new.md\0 M README.md\0` }));
      const b = await board();
      expect(b.uncommitted).toEqual([
        { file: FILE, code: ' M' },
        { file: 'tasks/new.md', code: '??' },
      ]);
      expect(b.tasks.find((t) => t.id === 'DEMO-4')?.modified).toBe(true);
    });

    it('returns one task with its body rendered safely', async () => {
      const path = join(dir, FILE);
      await writeFile(
        path,
        (await readFile(path, 'utf8')) +
          '\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](../p1-foundation/demo-1-set-up-repo.md)\n',
      );
      await start(fakeRunner({}));
      const res = await send(server, 'GET', '/api/tasks/DEMO-4');
      expect(res.status).toBe(200);
      const t = res.json();
      expect(t.title).toBe('Projects CRUD');
      expect(t.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(t.html).not.toContain('<script>');
      expect(t.html).not.toContain('javascript:');
      expect(t.html).toContain('href="?task=DEMO-1"');
      expect((await send(server, 'GET', '/api/tasks/DEMO-99')).status).toBe(404);
    });
  });

  describe('security', () => {
    beforeEach(() => start(fakeRunner({})));

    it('rejects a wrong Host header', async () => {
      for (const host of ['evil.example', `evil.example:${server.port}`, 'localhost:1', '127.0.0.1'])
        expect((await send(server, 'GET', '/api/board', { host })).status, host).toBe(403);
      expect((await send(server, 'GET', '/api/board', { host: `localhost:${server.port}` })).status).toBe(200);
    });

    it('rejects writes without the right token or Origin', async () => {
      const body = { status: 'blocked', version: await version('DEMO-4') };
      const origin = `http://127.0.0.1:${server.port}`;
      const tries: Array<Record<string, string>> = [
        { Origin: origin },
        { Origin: origin, 'X-Boardmd-Token': 'wrong' },
        { Origin: 'http://evil.example', 'X-Boardmd-Token': server.token },
        { 'X-Boardmd-Token': server.token },
      ];
      for (const headers of tries) {
        const res = await send(server, 'PATCH', '/api/tasks/DEMO-4', { body, headers });
        expect(res.status).toBe(403);
      }
      const refresh = await send(server, 'POST', '/api/refresh', { headers: { Origin: origin } });
      expect(refresh.status).toBe(403);
      expect(await readFile(join(dir, FILE), 'utf8')).toContain('status: todo');
    });
  });

  describe('editing', () => {
    it('changes exactly one line', async () => {
      await start(fakeRunner({}));
      const before = await readFile(join(dir, FILE), 'utf8');
      const old = await version('DEMO-4');
      const res = await write('/api/tasks/DEMO-4', { status: 'blocked', version: old });
      expect(res.status).toBe(200);
      expect(res.json()).toMatchObject({ changed: true, task: { id: 'DEMO-4', status: 'blocked' } });
      const after = await readFile(join(dir, FILE), 'utf8');
      expect(after).toBe(before.replace('status: todo', 'status: blocked'));
      const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
      expect(changed).toEqual(['status: todo']);
      const now = (await board()).tasks.find((t) => t.id === 'DEMO-4')!;
      expect(now.status).toBe('blocked');
      expect(now.version).toBe(res.json().task.version);
      expect(now.version).not.toBe(old);
    });

    it('keeps CRLF files intact', async () => {
      const path = join(dir, FILE);
      const crlf = (await readFile(path, 'utf8')).replaceAll('\n', '\r\n');
      await writeFile(path, crlf);
      await start(fakeRunner({}));
      const res = await write('/api/tasks/DEMO-4', { status: 'done', version: await version('DEMO-4') });
      expect(res.status).toBe(200);
      expect(await readFile(path, 'utf8')).toBe(crlf.replace('status: todo\r\n', 'status: done\r\n'));
    });

    it('returns 400 for an unknown status or missing version', async () => {
      await start(fakeRunner({}));
      const v = await version('DEMO-4');
      expect((await write('/api/tasks/DEMO-4', { status: 'doing', version: v })).status).toBe(400);
      expect((await write('/api/tasks/DEMO-4', { status: 'done' })).status).toBe(400);
      const notJson = await send(server, 'PATCH', '/api/tasks/DEMO-4', {
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'X-Boardmd-Token': server.token,
          'Content-Type': 'text/plain',
        },
      });
      expect(notJson.status).toBe(415);
    });

    it('returns 404 for an unknown task', async () => {
      await start(fakeRunner({}));
      const res = await write('/api/tasks/DEMO-99', { status: 'done', version: 'x' });
      expect(res.status).toBe(404);
    });

    it('returns 409 when the file changed since the page loaded it', async () => {
      await start(fakeRunner({}));
      const stale = await version('DEMO-4');
      const path = join(dir, FILE);
      const edited = (await readFile(path, 'utf8')).replace('Soft delete.', 'Hard delete.');
      await writeFile(path, edited);
      const res = await write('/api/tasks/DEMO-4', { status: 'done', version: stale });
      expect(res.status).toBe(409);
      expect(res.json().task.version).toBe(await version('DEMO-4'));
      expect(await readFile(path, 'utf8')).toBe(edited);
    });

    it('returns 422 when there is no status line', async () => {
      const path = join(dir, FILE);
      const text = (await readFile(path, 'utf8')).replace('status: todo\n', '');
      await writeFile(path, text);
      await start(fakeRunner({}));
      const b = await board();
      const t = b.tasks.find((x) => x.id === 'DEMO-4')!;
      expect(t.editable).toBe(false);
      expect(b.columns[t.column]?.name).toBe('Other');
      const res = await write('/api/tasks/DEMO-4', { status: 'done', version: t.version });
      expect(res.status).toBe(422);
      expect(res.json().error).toContain('no "status:" line');
      expect(await readFile(path, 'utf8')).toBe(text);
    });

    it('returns the checkCommand output as a warning, without blocking the edit', async () => {
      const check = `node -e "console.error('done with a branch but no pr'); process.exit(1)"`;
      await start(fakeRunner({}), { checkCommand: check });
      const res = await write('/api/tasks/DEMO-4', { status: 'done', version: await version('DEMO-4') });
      expect(res.status).toBe(200);
      expect(res.json().warning).toBe('done with a branch but no pr');
      expect(await readFile(join(dir, FILE), 'utf8')).toContain('status: done');
    });

    it('stays quiet when checkCommand passes', async () => {
      await start(fakeRunner({}), { checkCommand: `node -e "console.log('6 task files OK')"` });
      const res = await write('/api/tasks/DEMO-4', { status: 'done', version: await version('DEMO-4') });
      expect(res.json().warning).toBeUndefined();
    });

    it('refreshes PR state on POST /api/refresh', async () => {
      const runner = fakeRunner({ prs: [] });
      await start(runner);
      await board();
      await board();
      expect(runner.calls.filter((c) => c.startsWith('gh'))).toHaveLength(1);
      const res = await send(server, 'POST', '/api/refresh', {
        headers: { Origin: `http://127.0.0.1:${server.port}`, 'X-Boardmd-Token': server.token },
      });
      expect(res.status).toBe(200);
      expect(runner.calls.filter((c) => c.startsWith('gh'))).toHaveLength(2);
    });
  });
});

describe('server-sent events', () => {
  it('sends changed when a task file changes on disk', async () => {
    const { dir, cleanup } = await copyFixture();
    const server = await startServer({ loaded: loaded(dir), port: 0, runner: fakeRunner({}) });
    try {
      const event = new Promise<string>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `127.0.0.1:${server.port}` } },
          (res) => {
            res.setEncoding('utf8');
            let text = '';
            res.on('data', (chunk: string) => {
              text += chunk;
              if (text.includes('event: changed')) {
                resolve(text);
                req.destroy();
              }
            });
            // Change a file once the stream is open.
            setTimeout(async () => {
              const path = join(dir, FILE);
              await writeFile(path, (await readFile(path, 'utf8')).replace('Soft delete.', 'Soft delete!'));
            }, 100);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(await event).toContain('data: {"reason":"files"}');
    } finally {
      await server.close();
      await cleanup();
    }
  });
});
