import { describe, expect, it, vi } from 'vitest';
import { placeTasks } from '../src/board.js';
import { computeLive, GitState, idsFromBranch, prNumber, webUrl, type Runner } from '../src/live.js';
import { loaded, pr, task } from './helpers.js';

const { config } = loaded('/repo');
const live = config.live!;
const ids = (branch: string) => idsFromBranch(branch, live, 'DEMO-{n}');

describe('idsFromBranch', () => {
  it('reads one task, a bundle and a docs range', () => {
    expect(ids('task/demo-27-login-form')).toEqual(['DEMO-27']);
    expect(ids('task/demo-27-29-auth-bundle')).toEqual(['DEMO-27', 'DEMO-29']);
    expect(ids('docs/demo-1-4-tidy-up')).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4']);
    expect(ids('fix/demo-8-typo')).toEqual(['DEMO-8']);
  });

  it('only treats docs/ branches with a gap as ranges', () => {
    expect(ids('task/demo-1-10-two-tasks')).toEqual(['DEMO-1', 'DEMO-10']);
    expect(ids('docs/demo-3-4-neighbours')).toEqual(['DEMO-3', 'DEMO-4']);
    expect(ids('docs/demo-1-5-9-three')).toEqual(['DEMO-1', 'DEMO-5', 'DEMO-9']);
  });

  it('ignores branches that do not match', () => {
    expect(ids('main')).toEqual([]);
    expect(ids('chore/board-tidy')).toEqual([]);
    expect(ids('task/demo-x-nope')).toEqual([]);
    expect(ids('task/demo-12')).toEqual([]);
  });
});

describe('computeLive', () => {
  const tasks = [
    task('DEMO-1', 'todo'),
    task('DEMO-2', 'todo'),
    task('DEMO-3', 'in-progress', { pr: 30 }),
    task('DEMO-4', 'todo', { branch: 'feature/custom-name' }),
    task('DEMO-5', 'done', { pr: 50 }),
    task('DEMO-6', 'blocked', { pr: 60 }),
    task('DEMO-7', 'todo', { pr: 70 }),
  ];
  const run = (branches: string[], prs: Parameters<typeof computeLive>[4]) =>
    computeLive(tasks, live, 'DEMO-{n}', branches, prs);

  it('shows a local branch as in progress', () => {
    const result = run(['main', 'task/demo-1-start'], []);
    expect(result.get('DEMO-1')).toEqual({ live: { state: 'in-progress', branch: 'task/demo-1-start' } });
    expect(result.has('DEMO-2')).toBe(false);
  });

  it('marks every task in a bundle and a docs range', () => {
    const result = run(['task/demo-1-2-pair', 'docs/demo-2-4-sweep'], []);
    expect([...result.keys()].sort()).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4']);
    expect(result.get('DEMO-2')?.live?.branch).toBe('task/demo-1-2-pair');
  });

  it('skips done and deferred tasks', () => {
    expect(run(['task/demo-5-again'], [pr(51, 'task/demo-5-again')]).has('DEMO-5')).toBe(false);
  });

  it('shows an open PR as in review, over a local branch', () => {
    const result = run(['task/demo-1-start'], [pr(11, 'task/demo-1-start')]);
    expect(result.get('DEMO-1')?.live).toEqual({
      state: 'in-review',
      pr: 11,
      branch: 'task/demo-1-start',
      base: 'main',
    });
  });

  it('labels drafts, requested changes and approvals', () => {
    const result = run(
      [],
      [
        pr(1, 'task/demo-1-a', { isDraft: true }),
        pr(2, 'task/demo-2-b', { reviewDecision: 'CHANGES_REQUESTED' }),
        pr(3, 'task/demo-7-c', { reviewDecision: 'APPROVED' }),
      ],
    );
    expect(result.get('DEMO-1')?.live?.note).toBe('draft');
    expect(result.get('DEMO-2')?.live?.note).toBe('changes requested');
    expect(result.get('DEMO-7')?.live?.note).toBe('approved');
  });

  it("matches a PR by the task's pr and branch fields", () => {
    const result = run([], [pr(30, 'whatever'), pr(40, 'feature/custom-name')]);
    expect(result.get('DEMO-3')?.live?.pr).toBe(30);
    expect(result.get('DEMO-4')?.live?.pr).toBe(40);
  });

  it('keeps the newest open PR when there are several', () => {
    const result = run([], [pr(12, 'task/demo-1-second'), pr(10, 'task/demo-1-first')]);
    expect(result.get('DEMO-1')?.live?.pr).toBe(12);
  });

  it('adds the merged badge when the file is not done', () => {
    const merged = { state: 'MERGED' as const };
    const result = run(
      [],
      [
        pr(70, 'task/demo-7-x', merged),
        pr(60, 'task/demo-6-x', merged),
        pr(50, 'task/demo-5-x', merged),
        pr(99, 'task/demo-2-x', merged),
      ],
    );
    expect(result.get('DEMO-7')).toEqual({ merged: { pr: 70 } });
    // Blocked and done files don't get it, nor does a merged PR that isn't the task's pr.
    expect(result.get('DEMO-6')).toBeUndefined();
    expect(result.get('DEMO-5')).toBeUndefined();
    expect(result.get('DEMO-2')).toBeUndefined();
  });

  it('only counts PRs merged into the base branch', () => {
    const result = run([], [pr(70, 'task/demo-7-x', { state: 'MERGED', baseRefName: 'release' })]);
    expect(result.get('DEMO-7')).toBeUndefined();
  });

  it("drops the leftover branch of a merged PR, but not other branches", () => {
    const merged = pr(70, 'task/demo-7-x', { state: 'MERGED' });
    expect(run(['task/demo-7-x'], [merged]).get('DEMO-7')).toEqual({ merged: { pr: 70 } });
    expect(run(['task/demo-7-more'], [merged]).get('DEMO-7')).toEqual({
      live: { state: 'in-progress', branch: 'task/demo-7-more' },
      merged: { pr: 70 },
    });
  });

  it('ignores closed PRs', () => {
    expect(run([], [pr(5, 'task/demo-1-a', { state: 'CLOSED' })]).size).toBe(0);
  });
});

describe('placeTasks', () => {
  it('puts live tasks in their live column and unknown statuses in Other', () => {
    const tasks = [
      task('DEMO-1', 'todo'),
      task('DEMO-2', 'todo'),
      task('DEMO-3', 'todo'),
      task('DEMO-4', 'waiting'),
      task('DEMO-5', 'done'),
    ];
    const liveMap = computeLive(tasks, live, 'DEMO-{n}', ['task/demo-1-a'], [pr(2, 'task/demo-2-b')]);
    const { columns, tasks: placed } = placeTasks(tasks, config, liveMap);
    expect(columns.map((c) => [c.name, c.count])).toEqual([
      ['Todo', 1],
      ['In progress', 1],
      ['In review', 1],
      ['Blocked', 0],
      ['Done', 1],
      ['Deferred', 0],
      ['Other', 1],
    ]);
    expect(placed.map((t) => columns[t.column]!.name)).toEqual([
      'In progress',
      'In review',
      'Todo',
      'Other',
      'Done',
    ]);
    expect(columns.map((c) => c.droppable)).toEqual([true, true, false, true, true, true, false]);
  });

  it('leaves out the Other column when every status has a column', () => {
    expect(placeTasks([task('DEMO-1', 'todo')], config, new Map()).columns.at(-1)?.name).toBe('Deferred');
  });
});

describe('helpers', () => {
  it('reads PR numbers', () => {
    expect([prNumber(12), prNumber('12'), prNumber('#12'), prNumber(null), prNumber('x'), prNumber(1.5)]).toEqual([
      12,
      12,
      12,
      null,
      null,
      null,
    ]);
  });

  it('turns git remotes into web URLs', () => {
    expect(webUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(webUrl('https://github.com/acme/app.git\n')).toBe('https://github.com/acme/app');
    expect(webUrl('https://user@github.com/acme/app')).toBe('https://github.com/acme/app');
    expect(webUrl('ssh://git@github.com:22/acme/app.git')).toBe('https://github.com/acme/app');
    expect(webUrl('/local/path')).toBeNull();
  });
});

describe('GitState', () => {
  it('caches PRs for a minute, then refreshes them in the background', async () => {
    let prs = [pr(1, 'task/demo-1-a')];
    let calls = 0;
    const runner: Runner = async (cmd) => {
      if (cmd !== 'gh') return { ok: false, error: 'no' };
      calls++;
      return { ok: true, stdout: JSON.stringify(prs) };
    };
    const git = new GitState(runner, '/repo', '/repo');
    const changed = vi.fn();
    git.onPullRequestsChanged = changed;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      expect(await git.pullRequests()).toEqual(prs);
      expect(await git.pullRequests()).toEqual(prs);
      expect(calls).toBe(1);

      // A minute later the old list comes back at once, and a new one is fetched.
      const old = prs;
      prs = [pr(2, 'task/demo-2-b'), ...prs];
      now.mockReturnValue(1_061_000);
      expect(await git.pullRequests()).toEqual(old);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(calls).toBe(2);
      expect(await git.pullRequests()).toEqual(prs);

      // refresh() makes the next call wait for gh.
      git.refresh();
      prs = [];
      expect(await git.pullRequests()).toEqual([]);
      expect(calls).toBe(3);
    } finally {
      now.mockRestore();
    }
  });

  it("doesn't hold up the first page load for a slow gh", async () => {
    let answer: (stdout: string) => void = () => {};
    const runner: Runner = (cmd) =>
      cmd === 'gh'
        ? new Promise((resolve) => (answer = (stdout) => resolve({ ok: true, stdout })))
        : Promise.resolve({ ok: false, error: 'no' });
    const git = new GitState(runner, '/repo', '/repo');
    const changed = vi.fn();
    git.onPullRequestsChanged = changed;
    expect(await git.pullRequestsWithin(10)).toBeUndefined();
    answer(JSON.stringify([pr(3, 'task/demo-3-x')]));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(await git.pullRequestsWithin(10)).toEqual([pr(3, 'task/demo-3-x')]);
  });
});
