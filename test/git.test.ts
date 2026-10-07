// Real git (gh stays faked): checks that branch, status and watcher handling work on real output.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Board } from '../src/board.js';
import { defaultRunner, type Runner } from '../src/live.js';
import { startServer, type RunningServer } from '../src/server.js';
import { copyFixture, loaded } from './helpers.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const noGh: Runner = (cmd, args, options) =>
  cmd === 'gh' ? Promise.resolve({ ok: false, error: 'spawn gh ENOENT' }) : defaultRunner(cmd, args, options);

function get(server: RunningServer, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.port, path, headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve(text));
    })
      .on('error', reject)
      .end();
  });
}

describe.skipIf(!hasGit)('with a real git repo', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: RunningServer | undefined;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });

  beforeEach(async () => {
    ({ dir, cleanup } = await copyFixture());
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await server?.close();
    await cleanup();
  });

  it('reads branches, the current branch and uncommitted files', async () => {
    git('branch', 'task/demo-4-projects-crud');
    git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const file = join(dir, 'tasks/p2-features/demo-5-comments.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('Plain text', 'Rich text'));
    await writeFile(join(dir, 'tasks', 'scratch.txt'), 'not a task');

    server = await startServer({ loaded: loaded(dir), port: 0, runner: noGh, watch: false });
    const board = JSON.parse(await get(server, '/api/board')) as Board;
    expect(board.branch).toBe('main');
    expect(board.repoUrl).toBe('https://github.com/acme/demo');
    expect(board.notes).toEqual(['PR state unavailable: gh is not installed.']);
    expect(board.tasks.find((t) => t.id === 'DEMO-4')?.live).toEqual({
      state: 'in-progress',
      branch: 'task/demo-4-projects-crud',
    });
    expect(board.uncommitted).toEqual([{ file: 'tasks/p2-features/demo-5-comments.md', code: ' M' }]);
    expect(board.tasks.find((t) => t.id === 'DEMO-5')?.modified).toBe(true);
  });

  it('pushes a change when a branch is created', async () => {
    server = await startServer({ loaded: loaded(dir), port: 0, runner: noGh });
    const port = server.port;
    const event = new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('event: changed')) {
            resolve(text);
            req.destroy();
          }
        });
        setTimeout(() => git('branch', 'task/demo-5-comments'), 100);
      });
      req.on('error', reject);
      req.end();
    });
    expect(await event).toContain('data: {"reason":"git"}');
  });
});
