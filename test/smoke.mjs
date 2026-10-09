// Runs the built CLI (dist/cli.js) on a copy of the fixture project, using only Node built-ins.
// CI runs it on Node 20, where pnpm 11 and Vitest can't run: `node test/smoke.mjs`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'boardmd-smoke-'));
const project = join(work, 'project');
cpSync(join(root, 'test', 'fixtures', 'basic'), project, { recursive: true });
const config = join(project, 'boardmd.config.json');

const run = (args, cwd = project) =>
  execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (name, fn) => {
  fn();
  console.log(`ok  ${name}`);
};

async function serve() {
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0', '--offline', '--config', config], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const found = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
        if (found) resolve(found[0]);
      });
      child.on('exit', (code) => reject(new Error(`serve exited with ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 10_000);
    });
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<meta name="boardmd-token" content="[^"]+"/);
    const board = await (await fetch(`${url}/api/board`)).json();
    assert.equal(board.tasks.length, 7);
    console.log('ok  serve answers on', url);
  } finally {
    child.kill();
  }
}

try {
  console.log(`boardmd ${version} on Node ${process.version}`);
  step('--version', () => assert.equal(run(['--version']).trim(), version));
  step('check', () => assert.equal(run(['check', '--config', config]).trim(), '6 task files OK'));
  step('list --json', () => {
    const tasks = JSON.parse(run(['list', '--all', '--json', '--offline', '--config', config]));
    assert.deepEqual(tasks.map((t) => t.id), ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
  });
  step('new', () => {
    const out = run(['new', 'Smoke test', '--set', 'phase=P2', '--set', 'module=web', '--set', 'priority=P2', '--set', 'size=S', '--config', config]);
    assert.equal(out.trim(), 'Created DEMO-7: tasks/p2-features/demo-7-smoke-test.md');
  });
  step('set', () => {
    assert.equal(run(['set', 'DEMO-7', 'status=blocked', '--offline', '--config', config]).trim(), 'DEMO-7: status todo → blocked');
    assert.equal(run(['check', '--config', config]).trim(), '7 task files OK');
  });
  step('init --yes', () => {
    const fresh = join(work, 'fresh');
    cpSync(join(project, 'tasks'), join(fresh, 'tasks'), { recursive: true });
    run(['init', '--yes'], fresh);
    assert.equal(run(['check'], fresh).trim(), '7 task files OK');
  });
  await serve();
  console.log('smoke test passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
