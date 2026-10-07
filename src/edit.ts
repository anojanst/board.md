// Changes a task's status: finds the file by id, checks its version, rewrites the one status line
// and writes the file atomically. Then runs the optional checkCommand.
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LoadedConfig } from './config.js';
import { replaceFrontmatterValue } from './frontmatter.js';
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
  /** Output of a failing checkCommand. Never blocks the edit. */
  warning?: string;
}

export async function editStatus(loaded: LoadedConfig, id: string, body: unknown): Promise<EditResult> {
  const { config } = loaded;
  const { status, version } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof status !== 'string' || !config.statuses.includes(status))
    throw new EditError(400, `Unknown status ${JSON.stringify(status)}. Use one of: ${config.statuses.join(', ')}.`);
  if (typeof version !== 'string' || version === '')
    throw new EditError(400, 'Missing "version": send the version the page last saw.');

  // The file comes from our own index, never from a path the client sent.
  const { tasks } = await readTasks(loaded);
  const found = tasks.find((t) => t.id === id);
  if (!found) throw new EditError(404, `No task with id ${id}.`);

  const bytes = await readFile(found.absPath);
  const current = taskFromBytes(bytes, found.absPath, loaded);
  if (versionOf(bytes) !== version)
    throw new EditError(409, `${id} changed on disk since the page loaded it. Nothing was written.`, current);

  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new EditError(422, `${current.file} isn't valid UTF-8, so it can't be edited safely.`);
  const replaced = replaceFrontmatterValue(text, config.statusField, status);
  if (!replaced.ok) throw new EditError(422, `Can't change ${id}: ${replaced.reason}.`);
  if (replaced.text === text) return { task: current, changed: false };

  await writeAtomic(found.absPath, replaced.text);
  const task = taskFromBytes(Buffer.from(replaced.text, 'utf8'), found.absPath, loaded);
  const warning = config.checkCommand ? await runCheck(config.checkCommand, loaded.root) : undefined;
  return { task, changed: true, ...(warning ? { warning } : {}) };
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
