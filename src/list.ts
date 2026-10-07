// `boardmd list` and `boardmd show`: tasks with their live state, as JSON in the shape EduStrux's
// scripts/board.mjs --json printed (so its skills keep working), or as a terminal table.
import { basename, dirname } from 'node:path';
import type { Board, BoardTask } from './board.js';
import type { Config } from './config.js';

export interface ListFilter {
  /** Include tasks in ignored statuses (done, deferred) without live state. */
  all?: boolean;
  statuses?: string[];
  /** Field values to keep: any of the values for one field, every field. */
  where?: Record<string, string[]>;
}

/** A task as board.mjs printed it: its frontmatter, file, folder, filename and live state. */
export function legacyTask(t: BoardTask): Record<string, unknown> {
  const live =
    t.live?.state === 'in-review'
      ? { state: 'in-review', pr: t.live.pr, base: t.live.base, note: t.live.note ?? '' }
      : t.merged
        ? { state: 'merged', pr: t.merged.pr, note: 'merged; file not marked done' }
        : t.live
          ? { state: 'in-progress', branch: t.live.branch }
          : null;
  return {
    ...t.data,
    file: t.file,
    folder: basename(dirname(t.absPath)),
    filename: basename(t.absPath),
    ...(live ? { live } : {}),
  };
}

export function filterTasks(board: Board, config: Config, filter: ListFilter): BoardTask[] {
  const statuses = filter.statuses ?? [];
  const where = Object.entries(filter.where ?? {});
  let shown = board.tasks.filter(
    (t) =>
      (!statuses.length || (t.status !== null && statuses.includes(t.status))) &&
      where.every(([key, values]) => {
        const v = t.data[key];
        return (Array.isArray(v) ? v : [v]).some((x) => values.includes(String(x)));
      }),
  );
  const ignore = config.live?.ignoreStatuses ?? [];
  if (!filter.all && !statuses.length)
    shown = shown.filter(
      (t) => !(t.status !== null && ignore.includes(t.status)) || t.live || t.merged,
    );
  return shown;
}

export function statusLabel(t: BoardTask): string {
  if (t.live?.state === 'in-review')
    return `in review #${t.live.pr}${t.live.note ? ` (${t.live.note})` : ''}`;
  if (t.merged) return `merged #${t.merged.pr}, needs sync`;
  if (t.live?.state === 'in-progress') return `in progress (${t.live.branch})`;
  return t.status ?? '(none)';
}

/** The board as markdown tables, grouped by the swimlane field. */
export function boardTable(board: Board, shown: BoardTask[], config: Config): string {
  const counts = board.columns.map((c) => `${c.count} ${c.name.toLowerCase()}`);
  const next = config.id.template
    ? ` · next id ${config.id.template.replaceAll('{n}', String(Math.max(0, ...board.tasks.map((t) => t.num ?? 0)) + 1))}`
    : '';
  const out = [`# Board: ${board.tasks.length} tasks · ${counts.join(' · ')}${next}`];
  for (const note of board.notes) out.push(`> ${note}`);
  if (board.invalid.length) out.push(`> ${board.invalid.length} invalid files: run boardmd check`);

  const fields = Object.entries(config.fields);
  const badges = fields.filter(([, f]) => f.badge).map(([k]) => k);
  const lane = fields.find(([, f]) => f.swimlane)?.[0];
  const extra = fields
    .filter(([k, f]) => !f.badge && !f.list && f.filter && k !== lane)
    .map(([k]) => k);
  const prField = config.live?.prField;
  const header = [
    'ID',
    'Task',
    'Status',
    ...[...badges, ...extra].map((k) => config.fields[k]!.label),
    ...(prField ? ['PR'] : []),
  ];
  const cell = (v: unknown) =>
    (v === null || v === undefined ? '' : String(v)).replaceAll('|', '\\|');
  const table = (tasks: BoardTask[]) =>
    [
      `| ${header.join(' | ')} |`,
      `|${header.map(() => '---').join('|')}|`,
      ...tasks.map((t) => {
        const row = [
          t.id,
          t.title,
          statusLabel(t),
          ...[...badges, ...extra].map((k) => t.data[k]),
          ...(prField ? [t.data[prField] ? `#${t.data[prField]}` : ''] : []),
        ];
        return `| ${row.map(cell).join(' | ')} |`;
      }),
    ].join('\n');

  if (!shown.length) {
    out.push('', 'No tasks to show. Use --all to include done and deferred tasks.');
    return out.join('\n');
  }
  if (!lane) {
    out.push('', table(shown));
    return out.join('\n');
  }
  const labels = config.fields[lane]!.values ?? {};
  const values = [
    ...new Set(
      shown
        .map((t) => t.data[lane])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map(String),
    ),
  ];
  const order = [
    ...Object.keys(labels).filter((v) => values.includes(v)),
    ...values.filter((v) => !(v in labels)).sort(),
  ];
  for (const value of order) {
    const label = labels[value];
    out.push(
      '',
      `## ${value}${label && label !== value ? ` ${label}` : ''}`,
      '',
      table(shown.filter((t) => String(t.data[lane]) === value)),
    );
  }
  const none = shown.filter((t) => [null, undefined, ''].includes(t.data[lane] as null));
  if (none.length)
    out.push('', `## No ${config.fields[lane]!.label.toLowerCase()}`, '', table(none));
  return out.join('\n');
}
