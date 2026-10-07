// The boardmd command line. src/cli.ts runs it; tests call main() directly.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buffer } from 'node:stream/consumers';
import {
  checkCommand,
  guideCommand,
  listCommand,
  newCommand,
  setCommand,
  showCommand,
  type CommandContext,
} from './commands.js';
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type LoadedConfig } from './config.js';
import { runInit, terminalPrompter, type Prompter } from './init.js';
import type { Runner } from './live.js';
import { DEFAULT_PORT, startServer } from './server.js';
import { readTasks } from './tasks.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `boardmd ${version}: a board for the markdown task files in your repo

Set up and serve:
  boardmd init                  Look at your task files and write ${DEFAULT_CONFIG_FILE}
  boardmd serve [--open]        Serve the board on http://127.0.0.1:${DEFAULT_PORT}

Read and change tasks (for you, scripts and coding agents):
  boardmd [list]                Open tasks with live branch and PR state, as tables
  boardmd show <id>             One task, with its notes
  boardmd new "<title>"         Create a task with the next id, in the right folder
  boardmd set <id> f=v [f=v…]   Change fields; only those lines of the file change
  boardmd check                 Validate the task files (exits 1 on problems)
  boardmd guide [--install]     This repo's task rules for agents; --install adds them
                                to CLAUDE.md or AGENTS.md and writes a Claude Code skill

Options:
  list:   --all  --json  --status <s>  --<field> <value>  --where <field>=<value>
  show:   --json
  new:    --set <field>=<value> (repeatable)  --status <s>  --body <markdown>
          --body-file <file|->  --dry-run  --json
  set:    --json
  check:  --json
  init:   -y, --yes  --force  --tasks-dir <folder>
  serve:  -p, --port <n>  -o, --open
  any:    -c, --config <file>  --offline (skip git and gh)  -h, --help  -v, --version
`;

const COMMANDS = ['serve', 'init', 'list', 'show', 'new', 'set', 'check', 'guide'] as const;
type Command = (typeof COMMANDS)[number] | '';

const BOOLEAN = new Set([
  'help',
  'version',
  'open',
  'offline',
  'yes',
  'force',
  'all',
  'json',
  'check',
  'dry-run',
  'install',
]);
const SHORT: Record<string, string> = {
  h: 'help',
  v: 'version',
  p: 'port',
  o: 'open',
  c: 'config',
  y: 'yes',
};
const ALLOWED: Record<Command, string[]> = {
  serve: ['port', 'open', 'offline'],
  init: ['yes', 'force', 'tasks-dir'],
  list: ['all', 'json', 'status', 'where', 'offline'],
  '': ['all', 'json', 'status', 'where', 'offline', 'check'],
  show: ['json', 'offline'],
  new: ['set', 'status', 'body', 'body-file', 'json', 'dry-run'],
  set: ['json', 'offline'],
  check: ['json'],
  guide: ['install', 'force', 'yes'],
};

interface Args {
  positionals: string[];
  options: Map<string, string[]>;
  /** Options given last, without the value they need. */
  missing: string[];
}

/** Splits arguments into positionals and options. Unknown `--name value` pairs are kept, for field filters. */
function parseArgv(argv: string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const missing: string[] = [];
  const add = (name: string, value: string) =>
    options.set(name, [...(options.get(name) ?? []), value]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const long = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
    const short = /^-([A-Za-z])$/.exec(arg);
    if (!long && !short) {
      positionals.push(arg);
      continue;
    }
    const name = long ? long[1]! : SHORT[short![1]!];
    if (!name) throw new Error(`Unknown option '${arg}'.`);
    const inline = long?.[2];
    if (BOOLEAN.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} doesn't take a value.`);
      add(name, 'true');
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined) missing.push(name);
      else add(name, value);
    }
  }
  return { positionals, options, missing };
}

export interface MainDeps {
  /** Runs git and gh; tests pass a fake. */
  runner?: Runner;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  let args: Args;
  try {
    args = parseArgv(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 1;
  }
  const has = (name: string) => args.options.has(name);
  const value = (name: string) => args.options.get(name)?.at(-1);
  const values = (name: string) => args.options.get(name) ?? [];

  if (has('version')) {
    console.log(version);
    return 0;
  }
  if (has('help')) {
    console.log(HELP);
    return 0;
  }
  const [first, ...rest] = args.positionals;
  if (first !== undefined && !(COMMANDS as readonly string[]).includes(first)) {
    console.error(`Unknown command: ${first}\n\n${HELP}`);
    return 1;
  }
  const command = (first ?? '') as Command;
  const configPath = value('config') ?? DEFAULT_CONFIG_FILE;

  // Unknown options are only field filters for list.
  const fieldFilters: string[] = [];
  for (const name of [...args.options.keys(), ...args.missing]) {
    if (name === 'config' || ALLOWED[command].includes(name)) continue;
    if (command === 'list' || command === '') fieldFilters.push(name);
    else {
      console.error(`Unknown option '--${name}' for boardmd ${command}.\n\n${HELP}`);
      return 1;
    }
  }

  if (args.missing.length) {
    console.error(`--${args.missing[0]} needs a value.`);
    return 1;
  }

  // Plain `boardmd` before there's a config: say what to do.
  if (command === '' && args.options.size === 0 && !existsSync(configPath)) {
    console.log(`${HELP}\nNo ${DEFAULT_CONFIG_FILE} here yet: run boardmd init to set one up.`);
    return 0;
  }

  const takes = (count: number, usage: string) => {
    if (rest.length < count) throw new UsageError(`Usage: ${usage}`);
  };
  try {
    if (command === 'init') {
      takes(0, 'boardmd init');
      if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
      return await initCommand(configPath, args, has, value);
    }
    if (command === 'serve') {
      if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
      return await serveCommand(configPath, has, value);
    }

    const loaded = await loadOrExplain(configPath);
    if (!loaded) return 1;
    const ctx: CommandContext = {
      loaded,
      ...(deps.runner ? { runner: deps.runner } : {}),
      offline: has('offline'),
      json: has('json'),
    };

    switch (command) {
      case '':
      case 'list': {
        if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
        if (has('check')) return await checkCommand(ctx);
        const where: Record<string, string[]> = {};
        for (const pair of values('where')) {
          const eq = pair.indexOf('=');
          if (eq < 1) throw new UsageError(`--where takes <field>=<value>, not "${pair}"`);
          (where[pair.slice(0, eq)] ??= []).push(pair.slice(eq + 1));
        }
        for (const name of fieldFilters) {
          if (!(name in loaded.config.fields))
            throw new UsageError(
              `Unknown option '--${name}' (not a field in ${DEFAULT_CONFIG_FILE})`,
            );
          (where[name] ??= []).push(...values(name));
        }
        return await listCommand(ctx, { all: has('all'), statuses: values('status'), where });
      }
      case 'show':
        takes(1, 'boardmd show <id>');
        if (rest.length > 1) throw new UsageError(`Unexpected argument: ${rest[1]}`);
        return await showCommand(ctx, rest[0]!);
      case 'new': {
        takes(1, 'boardmd new "<title>" [--set <field>=<value> …]');
        const bodyFile = value('body-file');
        const body =
          bodyFile === undefined
            ? value('body')
            : bodyFile === '-'
              ? (await buffer(process.stdin)).toString('utf8')
              : await readFile(bodyFile, 'utf8');
        return await newCommand(ctx, rest.join(' '), values('set'), {
          ...(value('status') ? { status: value('status')! } : {}),
          ...(body === undefined ? {} : { body }),
          dryRun: has('dry-run'),
        });
      }
      case 'set':
        takes(1, 'boardmd set <id> <field>=<value> [<field>=<value> …]');
        return await setCommand(ctx, rest[0]!, rest.slice(1));
      case 'check':
        if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
        return await checkCommand(ctx);
      case 'guide': {
        if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
        const prompter =
          has('install') && !has('yes') && interactive() ? terminalPrompter() : undefined;
        try {
          return await guideCommand(ctx, {
            install: has('install'),
            force: has('force'),
            yes: yesNo(prompter),
          });
        } finally {
          prompter?.close();
        }
      }
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}

class UsageError extends Error {}

/** Asks yes/no on the terminal, or takes the default without one. */
function yesNo(prompter: Prompter | undefined) {
  return async (question: string, fallback = true) =>
    prompter
      ? /^y/i.test(
          await prompter.ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `, fallback ? 'y' : 'n'),
        )
      : fallback;
}

async function loadOrExplain(configPath: string): Promise<LoadedConfig | null> {
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return null;
    }
    throw error;
  }
  if (!(await stat(loaded.tasksDir).catch(() => null))?.isDirectory()) {
    console.error(`${configPath}: tasksDir: ${loaded.tasksDir} is not a folder.`);
    return null;
  }
  return loaded;
}

async function initCommand(
  configPath: string,
  args: Args,
  has: (name: string) => boolean,
  value: (name: string) => string | undefined,
): Promise<number> {
  const prompter = interactive() && !has('yes') ? terminalPrompter() : undefined;
  try {
    const { code } = await runInit({
      ...(args.options.has('config') ? { config: configPath } : {}),
      ...(value('tasks-dir') ? { tasksDir: value('tasks-dir')! } : {}),
      yes: has('yes'),
      force: has('force'),
      ...(prompter ? { prompter } : {}),
    });
    return code;
  } finally {
    prompter?.close();
  }
}

async function serveCommand(
  configPath: string,
  has: (name: string) => boolean,
  value: (name: string) => string | undefined,
): Promise<number> {
  const portArg = value('port');
  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a number from 0 to 65535, not "${portArg}".`);
    return 1;
  }

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig(configPath);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // No config yet: offer to set one up, then carry on serving.
    if (!(error.notFound && !has('config') && interactive() && (await setUpFirst()))) {
      console.error(error.message);
      return 1;
    }
    loaded = await loadConfig(configPath);
  }
  if (!(await stat(loaded.tasksDir).catch(() => null))?.isDirectory()) {
    console.error(`${configPath}: tasksDir: ${loaded.tasksDir} is not a folder.`);
    return 1;
  }

  let server;
  try {
    server = await startServer({ loaded, port, offline: has('offline') });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. Try another one: boardmd serve --port ${port + 1}`,
      );
      return 1;
    }
    throw error;
  }

  const { tasks, invalid } = await readTasks(loaded);
  console.log(
    `boardmd: ${tasks.length} tasks from ${loaded.config.tasksDir}` +
      (invalid.length ? ` (${invalid.length} invalid files)` : ''),
  );
  console.log(`  ${server.url}`);
  console.log('Press Ctrl+C to stop.');
  if (has('open')) openBrowser(server.url);
  return 0;
}

function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Asks whether to run init before serving. True when a config was written. */
async function setUpFirst(): Promise<boolean> {
  const prompter = terminalPrompter();
  try {
    const answer = await prompter.ask(
      `No ${DEFAULT_CONFIG_FILE} here yet. Set one up now? (Y/n) `,
      'y',
    );
    if (!/^y/i.test(answer)) return false;
    const { code } = await runInit({ prompter, thenServe: true });
    return code === 0;
  } finally {
    prompter.close();
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => console.error(`Couldn't open a browser. Go to ${url}`));
    child.unref();
  } catch {
    console.error(`Couldn't open a browser. Go to ${url}`);
  }
}
