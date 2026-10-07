import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { main } from '../src/main.js';
import { FIXTURE } from './helpers.js';

const valid = async () =>
  JSON.parse(await readFile(join(FIXTURE, 'boardmd.config.json'), 'utf8')) as Record<string, unknown>;

/** Expects parseConfig to fail, and returns the message. */
function failure(raw: unknown): string {
  try {
    parseConfig(raw, 'boardmd.config.json');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the config to be rejected');
}

describe('parseConfig', () => {
  it('accepts the fixture config, with defaults filled in', async () => {
    const config = parseConfig(await valid());
    expect(config.columns).toHaveLength(6);
    expect(config.columns[2]).toEqual({ name: 'In review', live: ['in-review'], collapsed: false });
    expect(config.fields.module).toMatchObject({ label: 'Module', filter: true, badge: false });
    expect(config.fields.priority?.filter).toBe(true);
    expect(config.fields.endpoints?.filter).toBe(false);
    expect(config.live?.mergedIgnoreStatuses).toEqual(['blocked']);
    expect(config.live?.branchPattern.test('task/demo-1-x')).toBe(true);
  });

  it('names the bad key', async () => {
    const base = await valid();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, tasksDir: undefined }, 'boardmd.config.json: tasksDir: is required'],
      [{ ...base, tasksDir: 3 }, 'tasksDir: must be a non-empty string'],
      [{ ...base, colums: [] }, 'colums: unknown key'],
      [{ ...base, statuses: [] }, 'statuses: must list at least one status'],
      [{ ...base, statuses: ['todo', 'todo'] }, 'statuses[1]: "todo" is listed twice'],
      [{ ...base, id: { field: 'id', pattern: '^DEMO-\\d+$' } }, 'id.pattern: needs a capture group'],
      [{ ...base, id: { pattern: '(' } }, 'id.pattern: not a valid regular expression'],
      [{ ...base, id: { template: 'DEMO' } }, 'id.template: must contain {n}'],
      [{ ...base, id: { field: 'id' } }, 'id.template: is required when "live" is set'],
    ];
    for (const [raw, message] of cases) expect(failure(raw)).toContain(message);
  });

  it('checks columns against statuses', async () => {
    const base = await valid();
    const columns = base.columns as Array<Record<string, unknown>>;
    expect(failure({ ...base, columns: [...columns, { name: 'Doing', status: 'doing' }] })).toContain(
      'columns[6].status: "doing" is not in statuses',
    );
    expect(failure({ ...base, columns: [...columns, { name: 'Again', status: 'todo' }] })).toContain(
      'columns[6].status: "todo" is already used by columns[0]',
    );
    expect(failure({ ...base, columns: [{ name: 'Nothing' }] })).toContain(
      'columns[0]: needs a "status", a "live" list, or both',
    );
    expect(failure({ ...base, columns: [{ name: 'Live', live: ['merged'] }] })).toContain(
      'columns[0].live[0]: "merged" must be one of in-progress, in-review',
    );
    expect(failure({ ...base, columns: [{ name: 'X', status: 'todo', collapsed: 'yes' }] })).toContain(
      'columns[0].collapsed: must be true or false',
    );
  });

  it('checks fields and live settings', async () => {
    const base = await valid();
    const live = base.live as Record<string, unknown>;
    expect(failure({ ...base, fields: { phase: { label: 'Phase', badges: true } } })).toContain(
      'fields.phase.badges: unknown key',
    );
    expect(failure({ ...base, fields: { size: { values: { S: 1 } } } })).toContain(
      'fields.size.values.S: must be a non-empty string',
    );
    expect(
      failure({ ...base, fields: { a: { swimlane: true }, b: { swimlane: true } } }),
    ).toContain('fields.b.swimlane: only one field can be the swimlane');
    expect(failure({ ...base, live: { ...live, branchPattern: '^task/' } })).toContain(
      'live.branchPattern: needs a capture group',
    );
    expect(failure({ ...base, live: { ...live, ignoreStatuses: ['finished'] } })).toContain(
      'live.ignoreStatuses[0]: "finished" is not in statuses',
    );
  });
});

describe('loading a config file', () => {
  let dir: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('resolves tasksDir against the config file', async () => {
    const { root, tasksDir } = await loadConfig(join(FIXTURE, 'boardmd.config.json'));
    expect(root).toBe(FIXTURE.replace(/\/$/, ''));
    expect(tasksDir).toBe(join(FIXTURE, 'tasks'));
  });

  it('explains a missing file and bad JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'boardmd-config-'));
    await expect(loadConfig(join(dir, 'nope.json'))).rejects.toThrow(/config file not found/);
    await writeFile(join(dir, 'bad.json'), '{ "tasksDir": ');
    await expect(loadConfig(join(dir, 'bad.json'))).rejects.toThrow(/not valid JSON/);
  });

  it('makes boardmd serve fail at startup with the key named', async () => {
    dir = await mkdtemp(join(tmpdir(), 'boardmd-config-'));
    const file = join(dir, 'boardmd.config.json');
    await writeFile(file, JSON.stringify({ ...(await valid()), statuses: 'todo' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['serve', '--config', file])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain('statuses: must be an array of strings');
  });

  it('makes boardmd serve fail when tasksDir is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'boardmd-config-'));
    const file = join(dir, 'boardmd.config.json');
    await writeFile(file, JSON.stringify(await valid()));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['serve', '--config', file])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/tasksDir: .* is not a folder/);
  });
});
