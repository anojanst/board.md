// The boardmd command line. src/cli.ts runs it; tests call main() directly.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig } from './config.js';
import { runInit, terminalPrompter } from './init.js';
import { DEFAULT_PORT, startServer } from './server.js';
import { readTasks } from './tasks.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `boardmd ${version}

Usage:
  boardmd init  [--yes] [--force] [--tasks-dir <folder>] [--config ${DEFAULT_CONFIG_FILE}]
  boardmd serve [--port ${DEFAULT_PORT}] [--open] [--offline] [--config ${DEFAULT_CONFIG_FILE}]

Commands:
  init           Look at your task files and write ${DEFAULT_CONFIG_FILE}
  serve          Serve the board on http://127.0.0.1:${DEFAULT_PORT}

Options:
  -y, --yes        init: accept every suggestion without asking
      --force      init: replace an existing config
      --tasks-dir  init: the folder that holds the task files (found by itself otherwise)
  -p, --port       serve: port to listen on (default ${DEFAULT_PORT})
  -o, --open       serve: open the board in a browser
      --offline    serve: skip git branch and GitHub PR lookups
  -c, --config     Config file (default ${DEFAULT_CONFIG_FILE})
  -h, --help       Show this help
  -v, --version    Show the version
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        port: { type: 'string', short: 'p' },
        open: { type: 'boolean', short: 'o' },
        offline: { type: 'boolean' },
        config: { type: 'string', short: 'c' },
        yes: { type: 'boolean', short: 'y' },
        force: { type: 'boolean' },
        'tasks-dir': { type: 'string' },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(version);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  if (command !== 'serve' && command !== 'init') {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }
  if (extra.length) {
    console.error(`Unexpected argument: ${extra[0]}\n\n${HELP}`);
    return 1;
  }

  if (command === 'init') {
    const prompter = interactive() && !values.yes ? terminalPrompter() : undefined;
    try {
      const { code } = await runInit({
        ...(values.config ? { config: values.config } : {}),
        ...(values['tasks-dir'] ? { tasksDir: values['tasks-dir'] } : {}),
        yes: values.yes ?? false,
        force: values.force ?? false,
        ...(prompter ? { prompter } : {}),
      });
      return code;
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    } finally {
      prompter?.close();
    }
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a number from 0 to 65535, not "${values.port}".`);
    return 1;
  }

  const configPath = values.config ?? DEFAULT_CONFIG_FILE;
  let loaded;
  try {
    loaded = await loadConfig(configPath);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // No config yet: offer to set one up, then carry on serving.
    if (!(error.notFound && values.config === undefined && interactive() && (await setUpFirst()))) {
      console.error(error.message);
      return 1;
    }
    loaded = await loadConfig(configPath);
  }
  const dirStat = await stat(loaded.tasksDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    console.error(`${configPath}: tasksDir: ${loaded.tasksDir} is not a folder.`);
    return 1;
  }

  let server;
  try {
    server = await startServer({ loaded, port, offline: values.offline ?? false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try another one: boardmd serve --port ${port + 1}`);
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
  if (values.open) openBrowser(server.url);
  return 0;
}

function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Asks whether to run init before serving. True when a config was written. */
async function setUpFirst(): Promise<boolean> {
  const prompter = terminalPrompter();
  try {
    const answer = await prompter.ask(`No ${DEFAULT_CONFIG_FILE} here yet. Set one up now? (Y/n) `, 'y');
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
