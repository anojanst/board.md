// The commands agents and scripts use: list, show, new, set, check and guide.
import { readFile, rename, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { buildBoard, type Board } from './board.js';
import { checkTasks, folderMatches, folderNames } from './check.js';
import type { LoadedConfig } from './config.js';
import { CreateError, createTask, slugify } from './create.js';
import { EditError, editTask } from './edit.js';
import type { Scalar } from './frontmatter.js';
import { guideText, installAgentFiles } from './guide.js';
import { prNumber, defaultRunner, GitState, type Runner } from './live.js';
import { boardTable, filterTasks, legacyTask, statusLabel, type ListFilter } from './list.js';
import { readTasks, type Task } from './tasks.js';

export interface CommandContext {
  loaded: LoadedConfig;
  runner?: Runner;
  offline?: boolean;
  json?: boolean;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function loadBoard(ctx: CommandContext): Promise<Board> {
  const git = new GitState(ctx.runner ?? defaultRunner, ctx.loaded.tasksDir, ctx.loaded.root);
  return buildBoard(ctx.loaded, git, { offline: ctx.offline ?? false, waitForPrs: true });
}

/** A task file's fields as JSON, without live state (for new and set). */
function taskJson(task: Task): Record<string, unknown> {
  return {
    ...task.data,
    file: task.file,
    folder: basename(dirname(task.absPath)),
    filename: basename(task.absPath),
  };
}

export async function listCommand(ctx: CommandContext, filter: ListFilter): Promise<number> {
  const board = await loadBoard(ctx);
  const shown = filterTasks(board, ctx.loaded.config, filter);
  if (ctx.json) print(shown.map(legacyTask));
  else console.log(boardTable(board, shown, ctx.loaded.config));
  return 0;
}

export async function showCommand(ctx: CommandContext, id: string): Promise<number> {
  const board = await loadBoard(ctx);
  const task = board.tasks.find((t) => t.id === id);
  if (!task) {
    console.error(`No task with id ${id}.`);
    return 1;
  }
  const text = await readFile(task.absPath, 'utf8');
  if (ctx.json) {
    const { body } = (await readTasks(ctx.loaded)).tasks.find((t) => t.id === id)!;
    print({ ...legacyTask(task), body });
    return 0;
  }
  console.log(`${task.id} ${task.title}`);
  console.log(`  status: ${statusLabel(task)}`);
  console.log(`  file:   ${task.file}`);
  console.log('');
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

/** `field=value` arguments, typed the way the file needs them. */
export function parseAssignments(
  ctx: CommandContext,
  args: string[],
  current: Record<string, unknown> = {},
): Record<string, Scalar | Scalar[]> {
  const { config } = ctx.loaded;
  const values: Record<string, Scalar | Scalar[]> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 1) throw new CreateError(`Expected <field>=<value>, got "${arg}".`);
    const key = arg.slice(0, eq).trim();
    const raw = arg.slice(eq + 1);
    const before = current[key];
    let value: Scalar;
    if (raw === '') value = null;
    else if ((key === config.live?.prField || typeof before === 'number') && /^#?\d+$/.test(raw))
      value = prNumber(raw);
    else if (typeof before === 'boolean' && /^(true|false)$/.test(raw)) value = raw === 'true';
    else value = raw;
    const existing = values[key];
    if (config.fields[key]?.list)
      values[key] = [
        ...(Array.isArray(existing) ? existing : []),
        ...(value === null ? [] : [value]),
      ];
    else values[key] = value;
  }
  return values;
}

export async function newCommand(
  ctx: CommandContext,
  title: string,
  assignments: string[],
  options: { status?: string; body?: string; dryRun?: boolean },
): Promise<number> {
  const { config } = ctx.loaded;
  try {
    const values = parseAssignments(ctx, assignments);
    if (options.status) values[config.statusField] = options.status;
    const { task, text } = await createTask(
      ctx.loaded,
      { title, values, ...(options.body === undefined ? {} : { body: options.body }) },
      { dryRun: options.dryRun ?? false },
    );
    if (ctx.json) print(taskJson(task));
    else if (options.dryRun) {
      console.log(`Would create ${task.id}: ${task.file}\n`);
      process.stdout.write(text);
    } else console.log(`Created ${task.id}: ${task.file}`);
    return 0;
  } catch (error) {
    if (error instanceof CreateError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

export async function setCommand(
  ctx: CommandContext,
  id: string,
  assignments: string[],
): Promise<number> {
  const { config } = ctx.loaded;
  if (!assignments.length) {
    console.error(`Nothing to set. Use: boardmd set ${id} <field>=<value> …`);
    return 1;
  }
  const { tasks } = await readTasks(ctx.loaded);
  const found = tasks.find((t) => t.id === id);
  if (!found) {
    console.error(`No task with id ${id}.`);
    return 1;
  }
  let changes: Record<string, Scalar>;
  try {
    const parsed = parseAssignments(ctx, assignments, found.data);
    const list = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    if (list) throw new CreateError(`${list} is a list; edit it in the file.`);
    changes = parsed as Record<string, Scalar>;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  // Warn (but carry on) when git says the task is in progress or in review.
  if (config.statusField in changes && config.live && !ctx.offline) {
    const board = await loadBoard(ctx);
    const task = board.tasks.find((t) => t.id === id);
    if (task?.live)
      console.error(
        `Warning: ${id} is ${statusLabel(task)}, so the board shows it from git, and its ` +
          `${config.statusField} usually changes in its own PR. Changing it anyway.`,
      );
  }

  let result;
  try {
    result = await editTask(ctx.loaded, id, changes, { addMissing: true });
  } catch (error) {
    if (error instanceof EditError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  // A new folderBy value moves the file to its folder.
  let task = result.task;
  const by = config.newTask.folderBy;
  if (by && by in changes && changes[by] !== null) {
    const value = String(changes[by]);
    const top = relative(ctx.loaded.tasksDir, task.absPath).split(/[\\/]/);
    if (top.length < 2 || !folderMatches(top[0]!, value)) {
      const others = (await readTasks(ctx.loaded)).tasks;
      const label = config.fields[by]?.values?.[value];
      const folder =
        folderNames(ctx.loaded, others).get(value) ??
        (label && label !== value
          ? `${value.toLowerCase()}-${slugify(label)}`
          : value.toLowerCase());
      const target = join(ctx.loaded.tasksDir, folder, basename(task.absPath));
      await mkdir(dirname(target), { recursive: true });
      await rename(task.absPath, target);
      task = (await readTasks(ctx.loaded)).tasks.find((t) => t.id === id) ?? task;
      if (!ctx.json) console.log(`Moved ${id} to ${task.file}`);
    }
  }

  if (ctx.json) print(taskJson(task));
  else if (!result.changed) console.log(`${id}: nothing to change`);
  else {
    const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(none)' : String(v));
    const parts = Object.entries(changes).map(
      ([k, v]) => `${k} ${show(result.before[k])} → ${show(v)}`,
    );
    console.log(`${id}: ${parts.join(', ')}`);
  }
  return 0;
}

export async function checkCommand(ctx: CommandContext): Promise<number> {
  const { count, problems } = await checkTasks(ctx.loaded);
  if (ctx.json) print({ count, problems });
  else if (problems.length)
    console.error(problems.map((p) => `${p.file}: ${p.message}`).join('\n'));
  else console.log(`${count} task files OK`);
  return problems.length ? 1 : 0;
}

export async function guideCommand(
  ctx: CommandContext,
  options: {
    install?: boolean;
    force?: boolean;
    yes: (q: string, fallback?: boolean) => Promise<boolean>;
  },
): Promise<number> {
  const { tasks } = await readTasks(ctx.loaded);
  if (!options.install) {
    process.stdout.write(await guideText(ctx.loaded, tasks));
    return 0;
  }
  await installAgentFiles(ctx.loaded, tasks, {
    yes: options.yes,
    log: (line) => console.log(line),
    ...(options.force ? { force: true } : {}),
  });
  return 0;
}
