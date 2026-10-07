// Reads every markdown task file under tasksDir. A file that can't be read as a task still shows
// up, in the "invalid files" list, rather than stopping the board.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Config, LoadedConfig } from './config.js';
import { hasEditableLine, parseFrontmatter } from './frontmatter.js';

export interface Task {
  id: string;
  /** The number from `id.pattern`, used to sort cards. */
  num: number | null;
  title: string;
  status: string | null;
  data: Record<string, unknown>;
  /** Path relative to the config file's folder, with forward slashes. */
  file: string;
  absPath: string;
  /** SHA-1 of the file's bytes, to detect conflicting edits. */
  version: string;
  /** Whether the status line can be rewritten in place. */
  editable: boolean;
  body: string;
}

export interface InvalidFile {
  file: string;
  error: string;
}

export interface TaskSet {
  tasks: Task[];
  invalid: InvalidFile[];
}

export function versionOf(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export async function readTasks(loaded: LoadedConfig): Promise<TaskSet> {
  const paths = await listMarkdownFiles(loaded.tasksDir);
  const parsed: Task[] = [];
  const invalid: InvalidFile[] = [];
  const files = await Promise.all(
    paths.map(async (absPath) => ({ absPath, bytes: await readFile(absPath).catch(() => null) })),
  );
  for (const { absPath, bytes } of files) {
    const file = displayPath(loaded.root, absPath);
    if (!bytes) {
      invalid.push({ file, error: "couldn't read the file" });
      continue;
    }
    try {
      parsed.push(taskFromBytes(bytes, absPath, loaded));
    } catch (error) {
      invalid.push({ file, error: (error as Error).message });
    }
  }
  // Two files with one id would make an edit ambiguous, so neither goes on the board.
  const byId = new Map<string, Task[]>();
  for (const t of parsed) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  const tasks = parsed.filter((t) => byId.get(t.id)!.length === 1);
  for (const t of parsed) {
    const others = byId.get(t.id)!.filter((o) => o !== t);
    if (others.length)
      invalid.push({ file: t.file, error: `duplicate id ${t.id} (also in ${others.map((o) => o.file).join(', ')})` });
  }
  invalid.sort((a, b) => a.file.localeCompare(b.file));
  return { tasks: tasks.sort(compareTasks), invalid };
}

export function taskFromBytes(bytes: Buffer, absPath: string, loaded: LoadedConfig): Task {
  const text = bytes.toString('utf8');
  const { config } = loaded;
  const { data, body } = parseFrontmatter(text);
  const rawId = data[config.id.field];
  if (rawId === undefined || rawId === null || rawId === '')
    throw new Error(`no "${config.id.field}" field in the frontmatter`);
  if (typeof rawId !== 'string' && typeof rawId !== 'number')
    throw new Error(`"${config.id.field}" must be a string or a number`);
  const id = String(rawId);
  const title = data[config.titleField];
  const status = data[config.statusField];
  return {
    id,
    num: idNumber(id, config),
    title: typeof title === 'string' || typeof title === 'number' ? String(title) : id,
    status: status === null || status === undefined ? null : String(status),
    data,
    file: displayPath(loaded.root, absPath),
    absPath,
    version: versionOf(bytes),
    editable: hasEditableLine(text, config.statusField),
    body,
  };
}

function idNumber(id: string, config: Config): number | null {
  const m = config.id.pattern ? config.id.pattern.exec(id) : /(\d+)$/.exec(id);
  const n = m?.[1] === undefined ? NaN : Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function compareTasks(a: Task, b: Task): number {
  if (a.num !== null && b.num !== null && a.num !== b.num) return a.num - b.num;
  if ((a.num === null) !== (b.num === null)) return a.num === null ? 1 : -1;
  return a.id.localeCompare(b.id) || a.file.localeCompare(b.file);
}

/** Every `*.md` file under `dir`, sorted, skipping dot folders and node_modules. */
async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

export function displayPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}
