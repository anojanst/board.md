// Loads boardmd.config.json and checks every key, so a bad config fails at startup with the key
// named. The config is JSON rather than JavaScript so that loading it never runs code.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const LIVE_STATES = ['in-progress', 'in-review'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export interface ColumnConfig {
  name: string;
  status?: string;
  live: LiveState[];
  collapsed: boolean;
}

export interface FieldConfig {
  label: string;
  values?: Record<string, string>;
  badge: boolean;
  filter: boolean;
  swimlane: boolean;
  list: boolean;
  /** `boardmd check` and `boardmd new` insist on a value. */
  required: boolean;
}

/** How `boardmd new` names and places a task file. */
export interface NewTaskConfig {
  /** A field whose value picks the subfolder: phase P2 goes in p2-…/. */
  folderBy?: string;
  /** File name template: {id}, {id-lower}, {n} and {slug}. `check` enforces it when set. */
  fileName?: string;
  /** Values for fields the command line doesn't set. */
  defaults: Record<string, unknown>;
  /** Start the body with a "# <id> <title>" heading. */
  heading: boolean;
}

/** A value test in a rule: one value, any of a list, "*" for any value, or null for none. */
export type RuleMatch = string | number | boolean | null | Array<string | number | boolean>;

/** A `boardmd check` rule: tasks matching `if` (and not `unless`) need the `require` fields. */
export interface CheckRule {
  if: Record<string, RuleMatch>;
  unless?: Record<string, RuleMatch>;
  require: string[];
  message?: string;
}

export interface LiveConfig {
  baseBranch: string;
  branchPattern: RegExp;
  rangePrefixes: string[];
  branchField?: string;
  prField?: string;
  ignoreStatuses: string[];
  /** Statuses that never get the "merged, file not updated" badge. */
  mergedIgnoreStatuses: string[];
}

export interface Config {
  tasksDir: string;
  id: { field: string; pattern?: RegExp; template?: string };
  titleField: string;
  statusField: string;
  statuses: string[];
  columns: ColumnConfig[];
  fields: Record<string, FieldConfig>;
  live?: LiveConfig;
  newTask: NewTaskConfig;
  rules: CheckRule[];
  checkCommand?: string;
  afterEditHint?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file. */
  path: string;
  /** The config file's folder. `tasksDir` and `checkCommand` are relative to it. */
  root: string;
  /** Absolute path of `tasksDir`. */
  tasksDir: string;
}

export const DEFAULT_CONFIG_FILE = 'boardmd.config.json';

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(
    message: string,
    /** The config file doesn't exist. */
    readonly notFound = false,
  ) {
    super(message);
  }
}

export async function loadConfig(path = DEFAULT_CONFIG_FILE): Promise<LoadedConfig> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ConfigError(
        `${path}: config file not found. Run boardmd init to create one, or pass --config <file>.`,
        true,
      );
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: not valid JSON (${(error as Error).message})`);
  }
  const config = parseConfig(raw, path);
  const root = dirname(abs);
  return { config, path: abs, root, tasksDir: resolve(root, config.tasksDir) };
}

/** Checks a parsed config object. `source` prefixes every error message. */
export function parseConfig(raw: unknown, source = DEFAULT_CONFIG_FILE): Config {
  const fail = (key: string, message: string): never => {
    throw new ConfigError(`${source}: ${key}: ${message}`);
  };

  const root = object(raw, '(root)', fail);
  allowKeys(root, '', fail, [
    '$schema',
    'tasksDir',
    'id',
    'titleField',
    'statusField',
    'statuses',
    'columns',
    'fields',
    'live',
    'newTask',
    'rules',
    'checkCommand',
    'afterEditHint',
  ]);

  const tasksDir = string(root.tasksDir, 'tasksDir', fail);

  const idRaw = object(root.id, 'id', fail);
  allowKeys(idRaw, 'id.', fail, ['field', 'pattern', 'template']);
  const id: Config['id'] = {
    field: optionalString(idRaw.field, 'id.field', fail) ?? 'id',
  };
  if (idRaw.pattern !== undefined) {
    id.pattern = regex(idRaw.pattern, 'id.pattern', fail);
    if (!hasCaptureGroup(id.pattern))
      fail('id.pattern', 'needs a capture group for the number, e.g. "^TUI-(\\\\d+)$"');
  }
  if (idRaw.template !== undefined) {
    id.template = string(idRaw.template, 'id.template', fail);
    if (!id.template.includes('{n}')) fail('id.template', 'must contain {n}, e.g. "TUI-{n}"');
  }

  const titleField = optionalString(root.titleField, 'titleField', fail) ?? 'title';
  const statusField = optionalString(root.statusField, 'statusField', fail) ?? 'status';

  const statuses = stringList(root.statuses, 'statuses', fail);
  if (statuses.length === 0) fail('statuses', 'must list at least one status');
  statuses.forEach((s, i) => {
    if (statuses.indexOf(s) !== i) fail(`statuses[${i}]`, `"${s}" is listed twice`);
  });

  if (!Array.isArray(root.columns) || root.columns.length === 0)
    fail('columns', 'must be a non-empty array');
  const seenStatus = new Map<string, number>();
  const seenLive = new Map<string, number>();
  const columns = (root.columns as unknown[]).map((c, i): ColumnConfig => {
    const key = `columns[${i}]`;
    const col = object(c, key, fail);
    allowKeys(col, `${key}.`, fail, ['name', 'status', 'live', 'collapsed']);
    const name = string(col.name, `${key}.name`, fail);
    const status = optionalString(col.status, `${key}.status`, fail);
    if (status !== undefined) {
      if (!statuses.includes(status))
        fail(`${key}.status`, `"${status}" is not in statuses (${statuses.join(', ')})`);
      if (seenStatus.has(status))
        fail(`${key}.status`, `"${status}" is already used by columns[${seenStatus.get(status)}]`);
      seenStatus.set(status, i);
    }
    const live = col.live === undefined ? [] : stringList(col.live, `${key}.live`, fail);
    live.forEach((state, j) => {
      if (!(LIVE_STATES as readonly string[]).includes(state))
        fail(`${key}.live[${j}]`, `"${state}" must be one of ${LIVE_STATES.join(', ')}`);
      if (seenLive.has(state))
        fail(`${key}.live[${j}]`, `"${state}" is already used by columns[${seenLive.get(state)}]`);
      seenLive.set(state, i);
    });
    if (status === undefined && live.length === 0)
      fail(key, 'needs a "status", a "live" list, or both');
    const collapsed = optionalBoolean(col.collapsed, `${key}.collapsed`, fail) ?? false;
    return { name, ...(status === undefined ? {} : { status }), live: live as LiveState[], collapsed };
  });

  const fields: Record<string, FieldConfig> = {};
  if (root.fields !== undefined) {
    const fieldsRaw = object(root.fields, 'fields', fail);
    for (const [name, value] of Object.entries(fieldsRaw)) {
      const key = `fields.${name}`;
      const f = object(value, key, fail);
      allowKeys(f, `${key}.`, fail, [
        'label',
        'values',
        'badge',
        'filter',
        'swimlane',
        'list',
        'required',
      ]);
      let values: Record<string, string> | undefined;
      if (f.values !== undefined) {
        values = {};
        for (const [k, v] of Object.entries(object(f.values, `${key}.values`, fail)))
          values[k] = string(v, `${key}.values.${k}`, fail);
      }
      const badge = optionalBoolean(f.badge, `${key}.badge`, fail) ?? false;
      const swimlane = optionalBoolean(f.swimlane, `${key}.swimlane`, fail) ?? false;
      const list = optionalBoolean(f.list, `${key}.list`, fail) ?? false;
      // Fields with known values, badges and swimlanes are filters unless switched off.
      const filter =
        optionalBoolean(f.filter, `${key}.filter`, fail) ??
        (!list && (values !== undefined || badge || swimlane));
      fields[name] = {
        label: optionalString(f.label, `${key}.label`, fail) ?? name,
        ...(values ? { values } : {}),
        badge,
        filter,
        swimlane,
        list,
        required: optionalBoolean(f.required, `${key}.required`, fail) ?? false,
      };
    }
    const lanes = Object.keys(fields).filter((k) => fields[k]!.swimlane);
    if (lanes.length > 1)
      fail(`fields.${lanes[1]}.swimlane`, `only one field can be the swimlane (also ${lanes[0]})`);
  }

  let live: LiveConfig | undefined;
  if (root.live !== undefined) {
    const l = object(root.live, 'live', fail);
    allowKeys(l, 'live.', fail, [
      'baseBranch',
      'branchPattern',
      'rangePrefixes',
      'branchField',
      'prField',
      'ignoreStatuses',
      'mergedIgnoreStatuses',
    ]);
    if (!id.template) fail('id.template', 'is required when "live" is set');
    const branchPattern = regex(l.branchPattern, 'live.branchPattern', fail);
    if (!hasCaptureGroup(branchPattern))
      fail('live.branchPattern', 'needs a capture group for the task numbers, e.g. (\\d+(?:-\\d+)*)');
    const statusList = (value: unknown, key: string, fallback: string[]) => {
      if (value === undefined) return fallback;
      const list = stringList(value, key, fail);
      list.forEach((s, i) => {
        if (!statuses.includes(s)) fail(`${key}[${i}]`, `"${s}" is not in statuses`);
      });
      return list;
    };
    const branchField = optionalString(l.branchField, 'live.branchField', fail);
    const prField = optionalString(l.prField, 'live.prField', fail);
    live = {
      baseBranch: optionalString(l.baseBranch, 'live.baseBranch', fail) ?? 'main',
      branchPattern,
      rangePrefixes:
        l.rangePrefixes === undefined ? [] : stringList(l.rangePrefixes, 'live.rangePrefixes', fail),
      ...(branchField === undefined ? {} : { branchField }),
      ...(prField === undefined ? {} : { prField }),
      ignoreStatuses: statusList(l.ignoreStatuses, 'live.ignoreStatuses', []),
      mergedIgnoreStatuses: statusList(
        l.mergedIgnoreStatuses,
        'live.mergedIgnoreStatuses',
        statuses.includes('blocked') ? ['blocked'] : [],
      ),
    };
  }

  const newTask: NewTaskConfig = { defaults: {}, heading: true };
  if (root.newTask !== undefined) {
    const n = object(root.newTask, 'newTask', fail);
    allowKeys(n, 'newTask.', fail, ['folderBy', 'fileName', 'defaults', 'heading']);
    const folderBy = optionalString(n.folderBy, 'newTask.folderBy', fail);
    if (folderBy !== undefined) newTask.folderBy = folderBy;
    const fileName = optionalString(n.fileName, 'newTask.fileName', fail);
    if (fileName !== undefined) {
      if (!/\{(id|id-lower|n)\}/.test(fileName))
        fail('newTask.fileName', 'must contain {id}, {id-lower} or {n}, e.g. "{id-lower}-{slug}.md"');
      if (!fileName.endsWith('.md')) fail('newTask.fileName', 'must end with .md');
      if (/[\\/]/.test(fileName)) fail('newTask.fileName', 'is a file name, not a path (use folderBy)');
      newTask.fileName = fileName;
    }
    if (n.defaults !== undefined) newTask.defaults = object(n.defaults, 'newTask.defaults', fail);
    newTask.heading = optionalBoolean(n.heading, 'newTask.heading', fail) ?? true;
  }

  const rules: CheckRule[] = [];
  if (root.rules !== undefined) {
    if (!Array.isArray(root.rules)) fail('rules', 'must be an array');
    (root.rules as unknown[]).forEach((r, i) => {
      const key = `rules[${i}]`;
      const rule = object(r, key, fail);
      allowKeys(rule, `${key}.`, fail, ['if', 'unless', 'require', 'message']);
      const matches = (value: unknown, k: string) => {
        const m = object(value, k, fail);
        for (const [field, test] of Object.entries(m)) {
          const ok = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
          if (test !== null && !ok(test) && !(Array.isArray(test) && test.every(ok)))
            fail(`${k}.${field}`, 'must be a value, a list of values, "*" or null');
        }
        return m as Record<string, RuleMatch>;
      };
      const require = stringList(rule.require, `${key}.require`, fail);
      if (!require.length) fail(`${key}.require`, 'must list at least one field');
      const message = optionalString(rule.message, `${key}.message`, fail);
      rules.push({
        if: matches(rule.if, `${key}.if`),
        ...(rule.unless === undefined ? {} : { unless: matches(rule.unless, `${key}.unless`) }),
        require,
        ...(message === undefined ? {} : { message }),
      });
    });
  }

  const checkCommand = optionalString(root.checkCommand, 'checkCommand', fail);
  const afterEditHint = optionalString(root.afterEditHint, 'afterEditHint', fail);

  return {
    tasksDir,
    id,
    titleField,
    statusField,
    statuses,
    columns,
    fields,
    ...(live ? { live } : {}),
    newTask,
    rules,
    ...(checkCommand === undefined ? {} : { checkCommand }),
    ...(afterEditHint === undefined ? {} : { afterEditHint }),
  };
}

type Fail = (key: string, message: string) => never;

function object(value: unknown, key: string, fail: Fail): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(key, value === undefined ? 'is required' : 'must be an object');
  return value as Record<string, unknown>;
}

function allowKeys(obj: Record<string, unknown>, prefix: string, fail: Fail, allowed: string[]) {
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) fail(`${prefix}${k}`, `unknown key (expected one of ${allowed.join(', ')})`);
}

function string(value: unknown, key: string, fail: Fail): string {
  if (value === undefined) fail(key, 'is required');
  if (typeof value !== 'string' || value === '') fail(key, 'must be a non-empty string');
  return value as string;
}

function optionalString(value: unknown, key: string, fail: Fail): string | undefined {
  return value === undefined ? undefined : string(value, key, fail);
}

function optionalBoolean(value: unknown, key: string, fail: Fail): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') fail(key, 'must be true or false');
  return value as boolean | undefined;
}

function stringList(value: unknown, key: string, fail: Fail): string[] {
  if (value === undefined) fail(key, 'is required');
  if (!Array.isArray(value)) fail(key, 'must be an array of strings');
  (value as unknown[]).forEach((v, i) => string(v, `${key}[${i}]`, fail));
  return value as string[];
}

function regex(value: unknown, key: string, fail: Fail): RegExp {
  const source = string(value, key, fail);
  try {
    return new RegExp(source);
  } catch (error) {
    return fail(key, `not a valid regular expression (${(error as Error).message})`);
  }
}

function hasCaptureGroup(re: RegExp): boolean {
  return (new RegExp(`${re.source}|`).exec('')?.length ?? 1) > 1;
}
