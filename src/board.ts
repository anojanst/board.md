// Puts tasks into columns, with live state, notes and uncommitted files: everything the page shows.
import { basename } from 'node:path';
import type { Config, FieldConfig, LiveState, LoadedConfig } from './config.js';
import { computeLive, type GitState, type Live, type TaskLive, type Uncommitted } from './live.js';
import { displayPath, readTasks, type InvalidFile, type Task } from './tasks.js';

export interface BoardColumn {
  name: string;
  status?: string;
  live: LiveState[];
  collapsed: boolean;
  /** Whether a card can be dropped here (the column has a status). */
  droppable: boolean;
  count: number;
  /** The extra column for statuses that match no column. */
  other?: boolean;
}

export interface BoardTask extends Omit<Task, 'body'> {
  /** Index into `columns`. */
  column: number;
  live: Live | null;
  merged: { pr: number } | null;
  /** The file has uncommitted changes. */
  modified: boolean;
}

export interface Board {
  name: string;
  tasksDir: string;
  branch: string | null;
  baseBranch: string | null;
  repoUrl: string | null;
  idField: string;
  titleField: string;
  statusField: string;
  statuses: string[];
  columns: BoardColumn[];
  fields: Record<string, FieldConfig>;
  tasks: BoardTask[];
  invalid: InvalidFile[];
  notes: string[];
  uncommitted: Uncommitted[];
  afterEditHint: string | null;
  liveEnabled: boolean;
}

export const OTHER_COLUMN = 'Other';

export function placeTasks(
  tasks: Task[],
  config: Config,
  live: Map<string, TaskLive>,
  modified: Set<string> = new Set(),
): { columns: BoardColumn[]; tasks: BoardTask[] } {
  const columns: BoardColumn[] = config.columns.map((c) => ({
    name: c.name,
    ...(c.status === undefined ? {} : { status: c.status }),
    live: c.live,
    collapsed: c.collapsed,
    droppable: c.status !== undefined,
    count: 0,
  }));
  const other: BoardColumn = {
    name: OTHER_COLUMN,
    live: [],
    collapsed: false,
    droppable: false,
    count: 0,
    other: true,
  };
  const placed = tasks.map((task): BoardTask => {
    const { body: _body, ...rest } = task;
    const state = live.get(task.id);
    let column = state?.live ? columns.findIndex((c) => c.live.includes(state.live!.state)) : -1;
    if (column === -1) column = columns.findIndex((c) => c.status !== undefined && c.status === task.status);
    if (column === -1) column = columns.length;
    (columns[column] ?? other).count++;
    return {
      ...rest,
      column,
      live: state?.live ?? null,
      merged: state?.merged ?? null,
      modified: modified.has(task.file),
    };
  });
  if (other.count > 0) columns.push(other);
  return { columns, tasks: placed };
}

/** How long a page load waits for gh before showing the board without PR state. */
const PR_WAIT_MS = 500;

export async function buildBoard(
  loaded: LoadedConfig,
  git: GitState,
  options: { offline?: boolean; waitForPrs?: boolean } = {},
): Promise<Board> {
  const { config } = loaded;
  const [set, branch, repoUrl, uncommitted] = await Promise.all([
    readTasks(loaded),
    git.currentBranch(),
    git.repoUrl(),
    git.uncommitted(loaded.tasksDir),
  ]);

  const notes: string[] = [];
  let live = new Map<string, TaskLive>();
  if (config.live && options.offline) {
    notes.push('Offline: branch and PR state are switched off (--offline).');
  } else if (config.live) {
    const [branches, prs] = await Promise.all([
      git.branches(),
      options.waitForPrs ? git.pullRequests() : git.pullRequestsWithin(PR_WAIT_MS),
    ]);
    if (branches === null)
      notes.push('Branch state unavailable: this is not a git repository, or git is not installed.');
    if (prs === undefined) notes.push('Fetching PR state from GitHub…');
    if (prs === null) notes.push(`PR state unavailable: ${git.prProblem ?? 'gh failed'}.`);
    live = computeLive(set.tasks, config.live, config.id.template!, branches ?? [], prs ?? []);
  }

  const changed = uncommitted ?? [];
  const tasksDir = displayPath(loaded.root, loaded.tasksDir);
  const { columns, tasks } = placeTasks(set.tasks, config, live, new Set(changed.map((u) => u.file)));
  return {
    name: basename((await git.repoRoot()) ?? loaded.root),
    tasksDir: tasksDir.startsWith('..') ? loaded.tasksDir : tasksDir || '.',
    branch,
    baseBranch: config.live?.baseBranch ?? null,
    repoUrl,
    idField: config.id.field,
    titleField: config.titleField,
    statusField: config.statusField,
    statuses: config.statuses,
    columns,
    fields: config.fields,
    tasks,
    invalid: set.invalid,
    notes,
    uncommitted: changed,
    afterEditHint: config.afterEditHint ?? null,
    liveEnabled: !!config.live && !options.offline,
  };
}
