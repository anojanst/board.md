// What coding agents need to know: `boardmd guide` (this repo's task rules, made from the
// config), a short block for CLAUDE.md or AGENTS.md, and a Claude Code skill.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { LoadedConfig } from './config.js';
import type { Task } from './tasks.js';

/** How to run a package binary and a script with the repo's package manager. */
export interface PackageManager {
  name: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** `pnpm boardmd`, `npx boardmd`, … */
  bin: string;
  script: (name: string) => string;
}

export function packageManager(root: string, declared?: string): PackageManager {
  const has = (file: string) => existsSync(join(root, file));
  if (declared?.startsWith('pnpm') || has('pnpm-lock.yaml'))
    return { name: 'pnpm', bin: 'pnpm boardmd', script: (s) => `pnpm ${s}` };
  if (declared?.startsWith('yarn') || has('yarn.lock'))
    return { name: 'yarn', bin: 'yarn boardmd', script: (s) => `yarn ${s}` };
  if (declared?.startsWith('bun') || has('bun.lock') || has('bun.lockb'))
    return { name: 'bun', bin: 'bunx boardmd', script: (s) => `bun run ${s}` };
  return { name: 'npm', bin: 'npx boardmd', script: (s) => `npm run ${s}` };
}

export async function repoPackageManager(root: string): Promise<PackageManager> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8').then(
    (t) => JSON.parse(t) as { packageManager?: string },
    () => ({}) as { packageManager?: string },
  );
  return packageManager(root, pkg.packageManager);
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

/** The command that starts the board: a package.json script if there is one. */
async function boardCommand(root: string, pm: PackageManager): Promise<string> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8').then(
    (t) => JSON.parse(t) as { scripts?: Record<string, string> },
    () => ({}) as { scripts?: Record<string, string> },
  );
  const script = Object.entries(pkg.scripts ?? {}).find(([, cmd]) => /\bboardmd serve\b/.test(cmd));
  return script ? pm.script(script[0]) : `${pm.bin} serve --open`;
}

interface Examples {
  tasksDir: string;
  id: string;
  nextId: string;
  branch: string | null;
  setFlags: string;
}

function examples(loaded: LoadedConfig, tasks: Task[]): Examples {
  const { config } = loaded;
  const tasksDir = `${relative(loaded.root, loaded.tasksDir).split('\\').join('/') || '.'}/`;
  const nums = tasks.map((t) => t.num ?? 0);
  const next = Math.max(0, ...nums) + 1;
  const id =
    tasks.find((t) => t.status !== null)?.id ??
    config.id.template?.replace('{n}', '12') ??
    'TASK-12';
  const nextId = config.id.template?.replaceAll('{n}', String(next)) ?? '(next id)';
  const branch =
    config.live && config.id.template
      ? `task/${config.id.template.replace('{n}', String(tasks[0]?.num ?? 12)).toLowerCase()}-<slug>`
      : null;
  const required = Object.entries(config.fields).filter(([, f]) => f.required && !f.list);
  const by = config.newTask.folderBy;
  const keys = [...new Set([...(by ? [by] : []), ...required.map(([k]) => k)])];
  const sample = (key: string) => {
    const values = Object.keys(config.fields[key]?.values ?? {});
    return (
      values[Math.min(1, values.length - 1)] ??
      tasks.map((t) => t.data[key]).find((v) => !isBlank(v) && typeof v !== 'object') ??
      '…'
    );
  };
  const setFlags = keys.map((k) => `--set ${k}=${sample(k)}`).join(' ');
  return { tasksDir, id, nextId, branch, setFlags };
}

/** `boardmd guide`: this repo's rules for reading, creating and changing tasks. */
export async function guideText(loaded: LoadedConfig, tasks: Task[]): Promise<string> {
  const { config } = loaded;
  const pm = await repoPackageManager(loaded.root);
  const ex = examples(loaded, tasks);
  const cmd = pm.bin;
  const out: string[] = [];
  const by = config.newTask.folderBy;

  out.push(
    '# Tasks in this repo (board.md)',
    '',
    `Tasks are markdown files in \`${ex.tasksDir}\`, one per task, with YAML frontmatter. ` +
      `\`${await boardCommand(loaded.root, pm)}\` shows them as a board. Use these commands ` +
      'from the repo root to read and change them, rather than editing the frontmatter by hand.',
    '',
    '## Read',
    '',
    `- \`${cmd} list --json\`: open tasks, with live branch and PR state. \`--all\` adds the ` +
      `finished ones; filter with \`--status <status>\`${by ? ` or \`--${by} <value>\`` : ''}.`,
    `- \`${cmd} show ${ex.id}\`: one task, with its notes. \`--json\` for the fields.`,
    '',
    '## Create',
    '',
    '```bash',
    `${cmd} new "<title>" ${ex.setFlags}`.trimEnd(),
    '```',
    '',
    `- It picks the next id (now ${ex.nextId})${by ? `, the folder (from \`${by}\`)` : ''} and the file name, ` +
      'and writes the frontmatter in the same order as the other task files.',
    '- Add notes with `--body "<markdown>"`, or edit the new file\'s body afterwards.',
    '- If it says a field is missing, look at similar tasks (`list --json`) or ask the user, then run it again.',
    '- It prints the id and the file; `--json` prints the whole task.',
    '',
    '## Update',
    '',
    '```bash',
    `${cmd} set ${ex.id} ${config.statusField}=${config.statuses.at(-2) ?? config.statuses[0]}${config.live?.prField ? ` ${config.live.prField}=41` : ''}`,
    '```',
    '',
    '- Only those lines of the frontmatter change. A field the file lacks is added.',
    `- Setting a value to nothing: \`${config.live?.branchField ?? 'field'}=\`.`,
    ...(by ? [`- Changing \`${by}\` also moves the file to the matching folder.`] : []),
    '- Edit the notes (the markdown body) directly.',
  );
  if (config.live) {
    out.push(
      `- **In progress and in review come from git, not the file.** A local branch named like ` +
        `\`${ex.branch}\` shows the task as in progress, and an open PR shows it in review. ` +
        '`set` warns when you change the status of such a task; the status usually changes in ' +
        "the task's own PR.",
    );
  }
  out.push(
    '',
    '## Check',
    '',
    `Run \`${cmd} check\` after changing task files. It lists problems and exits 1 if there are any.`,
  );

  out.push('', '## Fields', '', '| Field | Values |', '|---|---|');
  const describe = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([k, v]) => (v === k ? `\`${k}\`` : `\`${k}\` ${v}`))
      .join(', ');
  out.push(
    `| \`${config.id.field}\` | ${config.id.template ? `\`${config.id.template.replace('{n}', '<n>')}\`, ` : ''}unique; never reuse or change an id |`,
  );
  out.push(`| \`${config.titleField}\` | short plain text (required) |`);
  out.push(`| \`${config.statusField}\` | ${config.statuses.map((s) => `\`${s}\``).join(', ')} |`);
  for (const [key, field] of Object.entries(config.fields)) {
    const notes: string[] = [];
    if (field.values) notes.push(describe(field.values));
    else if (field.list) notes.push('a list (`[]` when empty)');
    else {
      const seen = [
        ...new Set(
          tasks
            .map((t) => t.data[key])
            .filter((v) => !isBlank(v) && typeof v !== 'object')
            .map(String),
        ),
      ];
      notes.push(
        seen.length
          ? `in use: ${seen
              .slice(0, 12)
              .map((v) => `\`${v}\``)
              .join(', ')}${seen.length > 12 ? ', …' : ''}`
          : 'free text',
      );
    }
    if (field.required) notes.push('required');
    if (key === by) notes.push('picks the folder');
    out.push(`| \`${key}\` (${field.label}) | ${notes.join('; ')} |`);
  }
  if (config.live?.branchField)
    out.push(`| \`${config.live.branchField}\` | the branch the work was done on |`);
  if (config.live?.prField) out.push(`| \`${config.live.prField}\` | the PR number |`);

  const condition = (tests: Record<string, unknown>) =>
    Object.entries(tests)
      .map(([k, v]) =>
        v === '*'
          ? `${k} is set`
          : v === null
            ? `${k} is empty`
            : `${k} is ${[v].flat().join(' or ')}`,
      )
      .join(' and ');
  const rules = config.rules.map(
    (r) =>
      `- If ${condition(r.if)}${r.unless ? ` (unless ${condition(r.unless)})` : ''}: ` +
      `${r.require.join(' and ')} ${r.require.length > 1 ? 'are' : 'is'} required.`,
  );
  if (rules.length || config.afterEditHint) {
    out.push('', '## Rules', '', ...rules);
    if (config.afterEditHint) out.push(`- ${config.afterEditHint}`);
  }
  return `${out.join('\n')}\n`;
}

export const BLOCK_START = '<!-- boardmd:start -->';
export const BLOCK_END = '<!-- boardmd:end -->';

/** The short section for CLAUDE.md or AGENTS.md. */
export async function agentBlock(loaded: LoadedConfig, tasks: Task[]): Promise<string> {
  const pm = await repoPackageManager(loaded.root);
  const ex = examples(loaded, tasks);
  const cmd = pm.bin;
  return [
    BLOCK_START,
    '## Tasks (board.md)',
    '',
    `Tasks are markdown files in \`${ex.tasksDir}\`, shown as a board by ` +
      `\`${await boardCommand(loaded.root, pm)}\`. Before creating or changing tasks, run ` +
      `\`${cmd} guide\` for this repo's fields and rules. Use the CLI rather than editing ` +
      'frontmatter by hand:',
    '',
    `- \`${cmd} list --json\`: tasks with live branch and PR state`,
    `- \`${`${cmd} new "<title>" ${ex.setFlags}`.trimEnd()}\`: create a task (next id, folder and file name)`,
    `- \`${cmd} set ${ex.id} ${loaded.config.statusField}=…\`: change fields; only those lines change`,
    `- \`${cmd} check\`: validate the task files`,
    BLOCK_END,
  ].join('\n');
}

/** The Claude Code skill. */
export async function skillText(loaded: LoadedConfig): Promise<string> {
  const pm = await repoPackageManager(loaded.root);
  const tasksDir = `${relative(loaded.root, loaded.tasksDir).split('\\').join('/') || '.'}/`;
  const cmd = pm.bin;
  return `---
name: boardmd
description: Read, create and update this repo's tasks (markdown files in ${tasksDir}, shown as a board by board.md). Use when the user asks to add or file a task, change a task's status, branch or PR, find or list tasks, or check the task files.
---

<!-- Written by boardmd. Run "${cmd} guide --install --force" to rewrite it. -->

# Tasks with boardmd

1. Run \`${cmd} guide\` and follow it. It has this repo's fields, allowed values and rules.
2. Read tasks with \`${cmd} list --json\` (add \`--all\` for finished ones) or \`${cmd} show <id>\`.
3. Create a task with \`${cmd} new "<title>" --set <field>=<value> …\`. If it reports a missing
   field, infer it from similar tasks or ask the user, then run it again.
4. Change fields with \`${cmd} set <id> <field>=<value> …\` (status, branch, pr, …). Edit the
   notes, the markdown body, directly.
5. Run \`${cmd} check\` after any change, and fix what it reports.

Don't edit frontmatter by hand, reuse or renumber ids, or move task files yourself.
`;
}

/** Puts the block in a file, replacing an earlier one. Returns what happened. */
export async function writeBlock(
  path: string,
  block: string,
): Promise<'created' | 'updated' | 'added' | 'unchanged'> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    await writeFile(path, `${block}\n`);
    return 'created';
  }
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    const next = text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
    if (next === text) return 'unchanged';
    await writeFile(path, next);
    return 'updated';
  }
  await writeFile(path, `${text.replace(/\s*$/, '')}\n\n${block}\n`);
  return 'added';
}

export interface InstallOptions {
  /** Answers a yes/no question. */
  yes: (question: string, fallback?: boolean) => Promise<boolean>;
  log: (line: string) => void;
  /** Rewrite a skill that already exists. */
  force?: boolean;
}

/** Offers to add the instructions block to CLAUDE.md / AGENTS.md and to write the skill. */
export async function installAgentFiles(
  loaded: LoadedConfig,
  tasks: Task[],
  options: InstallOptions,
): Promise<void> {
  const { root } = loaded;
  const { yes, log } = options;
  const block = await agentBlock(loaded, tasks);
  const targets = ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(join(root, f)));
  if (!targets.length) {
    if (await yes('Create AGENTS.md with instructions for coding agents?'))
      targets.push('AGENTS.md');
  } else {
    for (const file of [...targets]) {
      const current = await readFile(join(root, file), 'utf8');
      const has = current.includes(BLOCK_START);
      if (
        !(await yes(
          has
            ? `Update the board.md section in ${file}?`
            : `Add a board.md section to ${file} for coding agents?`,
        ))
      )
        targets.splice(targets.indexOf(file), 1);
    }
  }
  for (const file of targets) {
    const result = await writeBlock(join(root, file), block);
    log(
      result === 'unchanged'
        ? `${file}: the board.md section is up to date.`
        : `${file}: ${result === 'created' ? 'created with' : result === 'updated' ? 'updated' : 'added'} the board.md section.`,
    );
  }

  const skillPath = join(root, '.claude', 'skills', 'boardmd', 'SKILL.md');
  const skill = await skillText(loaded);
  const existing = await readFile(skillPath, 'utf8').catch(() => null);
  if (existing === skill) {
    log('.claude/skills/boardmd/SKILL.md is up to date.');
  } else if (existing !== null && !options.force) {
    log(
      '.claude/skills/boardmd/SKILL.md exists and differs; left as it is (use --force to rewrite it).',
    );
  } else if (
    await yes(
      existing === null
        ? 'Add a Claude Code skill for managing tasks (.claude/skills/boardmd)?'
        : 'Rewrite .claude/skills/boardmd/SKILL.md?',
    )
  ) {
    await mkdir(join(root, '.claude', 'skills', 'boardmd'), { recursive: true });
    await writeFile(skillPath, skill);
    log(`${existing === null ? 'Added' : 'Rewrote'} .claude/skills/boardmd/SKILL.md.`);
  }
}
