// `boardmd new`: creates a task file with the next id, in the folder and under the file name the
// repo uses, with the same frontmatter keys (in the same order) as the other task files.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { folderNames } from './check.js';
import type { LoadedConfig } from './config.js';
import { invalidValue } from './edit.js';
import { formatScalar, type Scalar } from './frontmatter.js';
import { readTasks, taskFromBytes, type Task } from './tasks.js';

export class CreateError extends Error {
  override name = 'CreateError';
}

export interface NewTaskInput {
  title: string;
  /** Field values; list fields take arrays. */
  values?: Record<string, Scalar | Scalar[]>;
  /** Markdown notes, after the heading. */
  body?: string;
}

export interface Created {
  task: Task;
  text: string;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

export async function createTask(
  loaded: LoadedConfig,
  input: NewTaskInput,
  options: { dryRun?: boolean } = {},
): Promise<Created> {
  const { config } = loaded;
  const template = config.id.template;
  if (!template)
    throw new CreateError(
      'boardmd new needs id.template in the config (for example "TASK-{n}") to make the next id.',
    );
  const title = input.title.trim();
  if (!title) throw new CreateError('A task needs a title.');

  const { tasks, invalid } = await readTasks(loaded);
  const next = Math.max(0, ...tasks.map((t) => t.num ?? 0)) + 1;
  const id = template.replaceAll('{n}', String(next));
  if (invalid.length && invalid.some((f) => f.error.includes(`duplicate id ${id} `)))
    throw new CreateError(`${id} is already used by more than one file; fix that first.`);

  // Values: what was asked for, then the configured defaults, then blanks.
  const isList = (key: string) =>
    config.fields[key]?.list ??
    tasks.filter((t) => Array.isArray(t.data[key])).length > tasks.length / 2;
  const given: Record<string, Scalar | Scalar[]> = {};
  for (const [key, value] of Object.entries({ ...config.newTask.defaults, ...input.values })) {
    if (value === undefined) continue;
    given[key] =
      isList(key) && !Array.isArray(value)
        ? isBlank(value)
          ? []
          : [value as Scalar]
        : (value as Scalar);
  }
  given[config.titleField] = title;
  given[config.statusField] ??= config.statuses[0]!;

  const problems: string[] = [];
  for (const [key, value] of Object.entries(given)) {
    if (Array.isArray(value)) continue;
    const problem = invalidValue(config, key, value);
    if (problem) problems.push(problem);
  }
  const missing = Object.entries(config.fields)
    .filter(([key, f]) => f.required && !f.list && isBlank(given[key]))
    .map(([key, f]) => (f.values ? `${key} (${Object.keys(f.values).join(', ')})` : key));
  const by = config.newTask.folderBy;
  if (by && isBlank(given[by]) && !missing.some((m) => m.startsWith(`${by} `) || m === by))
    missing.unshift(by);
  if (missing.length) problems.push(`set ${missing.join(', ')} with --set <field>=<value>`);
  if (problems.length) throw new CreateError(`Can't create the task: ${problems.join('; ')}.`);

  // Keys in the order most task files use, so the new file looks like the others.
  const order = keyOrder(tasks, [config.id.field, config.titleField, config.statusField]);
  for (const key of Object.keys(given)) if (!order.includes(key)) order.push(key);
  const eol = await lineEnding(tasks);
  const lines: string[] = [];
  for (const key of order) {
    const value =
      key === config.id.field ? id : key in given ? given[key] : isList(key) ? [] : null;
    if (Array.isArray(value)) {
      lines.push(value.length ? `${key}:` : `${key}: []`);
      for (const item of value) lines.push(`  - ${formatScalar(item)}`);
    } else
      lines.push(
        value === null || value === undefined ? `${key}:` : `${key}: ${formatScalar(value)}`,
      );
  }
  const notes = input.body?.trim() ?? '';
  const body = config.newTask.heading ? `# ${id} ${title}${notes ? `\n\n${notes}` : ''}` : notes;
  const text = ['---', ...lines, '---', '', ...(body ? body.split(/\r?\n/) : [])].join(eol) + eol;

  // Folder and file name
  let dir = loaded.tasksDir;
  if (by) {
    const value = String(given[by]);
    const label = config.fields[by]?.values?.[value];
    const folder =
      folderNames(loaded, tasks).get(value) ??
      (label && label !== value ? `${value.toLowerCase()}-${slugify(label)}` : value.toLowerCase());
    dir = join(dir, folder);
  }
  const name = (config.newTask.fileName ?? '{id-lower}-{slug}.md')
    .replaceAll('{id-lower}', id.toLowerCase())
    .replaceAll('{id}', id)
    .replaceAll('{n}', String(next))
    .replaceAll('{slug}', slugify(title));
  const absPath = join(dir, name);

  if (!options.dryRun) {
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(absPath, text, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new CreateError(`${absPath} already exists.`);
      throw error;
    }
  }
  return { task: taskFromBytes(Buffer.from(text, 'utf8'), absPath, loaded), text };
}

/** The frontmatter keys most task files have, in their usual order, starting with `first`. */
function keyOrder(tasks: Task[], first: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tasks)
    for (const k of Object.keys(t.data)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const common = (k: string) => (counts.get(k) ?? 0) >= tasks.length / 2;
  // The order of the task file with the most common keys.
  const sample =
    [...tasks]
      .map((t) => Object.keys(t.data).filter(common))
      .sort((a, b) => b.length - a.length)[0] ?? [];
  return [...first, ...sample.filter((k) => !first.includes(k))];
}

async function lineEnding(tasks: Task[]): Promise<string> {
  const sample = tasks[0];
  if (!sample) return '\n';
  const text = await readFile(sample.absPath, 'utf8').catch(() => '');
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

/** "Decide: hosting provider" → "decide-hosting-provider", at most about 48 characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= 48) return slug || 'task';
  const cut = slug.slice(0, 48);
  return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : 48);
}
