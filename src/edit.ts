// Changes task fields: finds the file by id, checks its version, rewrites only the changed lines
// and writes the file atomically. The board uses it for status; `boardmd set` for any field.
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Config, LoadedConfig } from './config.js';
import { replaceFrontmatterValue, setFrontmatterValue, type Scalar } from './frontmatter.js';
import { readTasks, taskFromBytes, versionOf, type Task } from './tasks.js';

export class EditError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    message: string,
    /** The task as it is on disk now, for a 409. */
    readonly task?: Task,
  ) {
    super(message);
  }
}

export interface EditResult {
  task: Task;
  changed: boolean;
  /** The frontmatter before the edit. */
  before: Record<string, unknown>;
  /** Output of a failing checkCommand. Never blocks the edit. */
  warning?: string;
}

export interface EditOptions {
  /** The version the caller last saw; a different one on disk is a 409. */
  version?: string;
  /** Add a `key:` line when the file has none (the board refuses instead). */
  addMissing?: boolean;
  /** Run checkCommand afterwards. */
  runCheck?: boolean;
}

/** Why `value` isn't allowed for `key`, or null when it is. */
export function invalidValue(config: Config, key: string, value: unknown): string | null {
  if (key === config.id.field) return `"${key}" is the task's id and can't be changed`;
  if (key === config.statusField)
    return typeof value === 'string' && config.statuses.includes(value)
      ? null
      : `${key} must be one of: ${config.statuses.join(', ')}`;
  if (key === config.titleField && (typeof value !== 'string' || !value.trim()))
    return `${key} can't be empty`;
  const field = config.fields[key];
  if (field?.required && (value === null || value === ''))
    return `${key} is required`;
  if (field?.values && value !== null && !Object.hasOwn(field.values, String(value)))
    return `${key} must be one of: ${Object.keys(field.values).join(', ')}`;
  if (key === config.live?.prField && value !== null && !Number.isInteger(value))
    return `${key} must be a PR number`;
  return null;
}

/** Changes the given fields of one task, each on its own line. */
export async function editTask(
  loaded: LoadedConfig,
  id: string,
  changes: Record<string, Scalar>,
  options: EditOptions = {},
): Promise<EditResult> {
  for (const [key, value] of Object.entries(changes)) {
    const problem = invalidValue(loaded.config, key, value);
    if (problem) throw new EditError(400, `${problem}.`);
  }

  // The file comes from our own index, never from a path the client sent.
  const { tasks } = await readTasks(loaded);
  const found = tasks.find((t) => t.id === id);
  if (!found) throw new EditError(404, `No task with id ${id}.`);

  const bytes = await readFile(found.absPath);
  const current = taskFromBytes(bytes, found.absPath, loaded);
  if (options.version !== undefined && versionOf(bytes) !== options.version)
    throw new EditError(409, `${id} changed on disk since the page loaded it. Nothing was written.`, current);

  const original = bytes.toString('utf8');
  if (!Buffer.from(original, 'utf8').equals(bytes))
    throw new EditError(422, `${current.file} isn't valid UTF-8, so it can't be edited safely.`);
  let text = original;
  for (const [key, value] of Object.entries(changes)) {
    const result = options.addMissing
      ? setFrontmatterValue(text, key, value)
      : replaceFrontmatterValue(text, key, value);
    if (!result.ok) throw new EditError(422, `Can't change ${id}: ${result.reason}.`);
    text = result.text;
  }
  if (text === original) return { task: current, changed: false, before: current.data };

  await writeAtomic(found.absPath, text);
  const task = taskFromBytes(Buffer.from(text, 'utf8'), found.absPath, loaded);
  const { checkCommand } = loaded.config;
  const warning = options.runCheck && checkCommand ? await runCheck(checkCommand, loaded.root) : undefined;
  return { task, changed: true, before: current.data, ...(warning ? { warning } : {}) };
}

/** The board's PATCH: `{ status, version }`. */
export async function editStatus(loaded: LoadedConfig, id: string, body: unknown): Promise<EditResult> {
  const { config } = loaded;
  const { status, version } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof status !== 'string' || !config.statuses.includes(status))
    throw new EditError(400, `Unknown status ${JSON.stringify(status)}. Use one of: ${config.statuses.join(', ')}.`);
  if (typeof version !== 'string' || version === '')
    throw new EditError(400, 'Missing "version": send the version the page last saw.');
  return editTask(loaded, id, { [config.statusField]: status }, { version, runCheck: true });
}

/** Writes a temporary file next to the original, then renames it over the original. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.boardmd-tmp`);
  const { mode } = await stat(path);
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Runs checkCommand in the config's folder. Returns its output if it fails. */
function runCheck(command: string, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (!error) return resolve(undefined);
        const output = `${stderr}\n${stdout}`.trim();
        const limit = 4000;
        resolve(
          output
            ? output.length > limit
              ? `${output.slice(0, limit)}…`
              : output
            : `checkCommand failed: ${error.killed ? 'timed out' : `exit code ${error.code}`}`,
        );
      },
    );
  });
}
