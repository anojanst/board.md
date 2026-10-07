// `boardmd check`: validates every task file against the config, the way scripts/board.mjs
// --check did for EduStrux, but with the rules taken from boardmd.config.json.
import { basename, dirname, relative, sep } from 'node:path';
import type { CheckRule, Config, LoadedConfig, RuleMatch } from './config.js';
import { prNumber } from './live.js';
import { readTasks, type Task } from './tasks.js';

export interface Problem {
  file: string;
  message: string;
}

export interface CheckResult {
  /** Task files read, valid or not. */
  count: number;
  problems: Problem[];
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

export async function checkTasks(loaded: LoadedConfig): Promise<CheckResult> {
  const { config } = loaded;
  const { tasks, invalid } = await readTasks(loaded);
  const problems: Problem[] = invalid.map((f) => ({ file: f.file, message: f.error }));
  const folders = folderNames(loaded, tasks);
  for (const task of tasks)
    for (const message of taskProblems(config, task, loaded.tasksDir, folders))
      problems.push({ file: task.file, message });
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { count: tasks.length + invalid.length, problems };
}

/** Folder (directly under tasksDir) for each value of newTask.folderBy, as the files use them. */
export function folderNames(loaded: LoadedConfig, tasks: Task[]): Map<string, string> {
  const by = loaded.config.newTask.folderBy;
  const folders = new Map<string, string>();
  if (!by) return folders;
  for (const t of tasks) {
    const value = t.data[by];
    const folder = topFolder(loaded.tasksDir, t.absPath);
    if (
      !isBlank(value) &&
      folder &&
      folderMatches(folder, String(value)) &&
      !folders.has(String(value))
    )
      folders.set(String(value), folder);
  }
  return folders;
}

/** True when a folder is named after a value: "p2" or "p2-vertical-slice" for P2. */
export function folderMatches(folder: string, value: string): boolean {
  const f = folder.toLowerCase();
  const v = value.toLowerCase();
  return f === v || f.startsWith(`${v}-`);
}

/** The first folder under tasksDir that holds the file, or null for a file directly in it. */
function topFolder(tasksDir: string, absPath: string): string | null {
  const parts = relative(tasksDir, absPath).split(sep);
  return parts.length > 1 ? parts[0]! : null;
}

/** A regular expression for file names made from newTask.fileName, for one task. */
export function fileNamePattern(template: string, task: Pick<Task, 'id' | 'num'>): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = template
    .split(/(\{id\}|\{id-lower\}|\{n\}|\{slug\})/)
    .map((part) =>
      part === '{id}'
        ? escape(task.id)
        : part === '{id-lower}'
          ? escape(task.id.toLowerCase())
          : part === '{n}'
            ? String(task.num ?? '\\d+')
            : part === '{slug}'
              ? '[^/\\\\]+?'
              : escape(part),
    )
    .join('');
  return new RegExp(`^${source}$`);
}

function taskProblems(
  config: Config,
  task: Task,
  tasksDir: string,
  folders: Map<string, string>,
): string[] {
  const out: string[] = [];
  const { data } = task;
  const example = config.id.template?.replace('{n}', '12');

  if (config.id.pattern && !config.id.pattern.test(task.id))
    out.push(`id ${task.id} must look like ${example ?? config.id.pattern.source}`);
  else if (config.newTask.fileName && task.num !== null) {
    const pattern = fileNamePattern(config.newTask.fileName, task);
    if (!pattern.test(basename(task.absPath)))
      out.push(
        `file name must look like ${config.newTask.fileName
          .replace('{id-lower}', task.id.toLowerCase())
          .replace('{id}', task.id)
          .replace('{n}', String(task.num))
          .replace('{slug}', '<slug>')}`,
      );
  }

  if (isBlank(data[config.titleField])) out.push(`missing ${config.titleField}`);
  if (task.status === null || !config.statuses.includes(task.status))
    out.push(`${config.statusField} must be one of: ${config.statuses.join(', ')}`);

  for (const [name, field] of Object.entries(config.fields)) {
    const value = data[name];
    if (field.list) {
      if (value === undefined || value === null) {
        if (field.required) out.push(`${name} must be a list (or [])`);
      } else if (!Array.isArray(value)) out.push(`${name} must be a list (or [])`);
      continue;
    }
    if (isBlank(value)) {
      if (field.required) out.push(`missing ${name}`);
      continue;
    }
    if (field.values && !Object.hasOwn(field.values, String(value)))
      out.push(`${name} must be one of: ${Object.keys(field.values).join(', ')}`);
  }

  const by = config.newTask.folderBy;
  if (by && !isBlank(data[by])) {
    const value = String(data[by]);
    const folder = topFolder(tasksDir, task.absPath);
    if (!folder || !folderMatches(folder, value)) {
      const where = folders.get(value) ?? `${value.toLowerCase()}-…`;
      out.push(`${by} ${value} belongs in ${relative(dirname(tasksDir), tasksDir)}/${where}/`);
    }
  }

  const prField = config.live?.prField;
  if (prField && !isBlank(data[prField]) && prNumber(data[prField]) === null)
    out.push(`${prField} must be a PR number`);

  for (const rule of config.rules) {
    if (!matchesAll(rule.if, data) || (rule.unless && matchesAll(rule.unless, data))) continue;
    const missing = rule.require.filter((k) => isBlank(data[k]));
    if (missing.length) out.push(rule.message ?? ruleMessage(rule, missing));
  }
  return out;
}

function matchesAll(tests: Record<string, RuleMatch>, data: Record<string, unknown>): boolean {
  return Object.entries(tests).every(([key, test]) => {
    const value = data[key];
    if (test === null) return isBlank(value);
    if (test === '*') return !isBlank(value);
    const allowed = Array.isArray(test) ? test : [test];
    return !isBlank(value) && allowed.map(String).includes(String(value));
  });
}

function ruleMessage(rule: CheckRule, missing: string[]): string {
  const when = Object.entries(rule.if)
    .map(([k, v]) =>
      v === '*' ? `a ${k}` : v === null ? `no ${k}` : `${k} ${[v].flat().join('/')}`,
    )
    .join(' and ');
  return `${when} needs ${missing.join(' and ')}`;
}
