// The boardmd command line. src/cli.ts runs it; tests call main() directly.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig } from './config.js';
import { DEFAULT_PORT, startServer } from './server.js';
import { readTasks } from './tasks.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `boardmd ${version}

Usage:
  boardmd serve [--port ${DEFAULT_PORT}] [--open] [--offline] [--config ${DEFAULT_CONFIG_FILE}]

Commands:
  serve          Serve the board on http://127.0.0.1:${DEFAULT_PORT}

Options:
  -p, --port     Port to listen on (default ${DEFAULT_PORT})
  -o, --open     Open the board in a browser
      --offline  Skip git branch and GitHub PR lookups
  -c, --config   Config file (default ${DEFAULT_CONFIG_FILE})
  -h, --help     Show this help
  -v, --version  Show the version
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
  if (command !== 'serve') {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }
  if (extra.length) {
    console.error(`Unexpected argument: ${extra[0]}\n\n${HELP}`);
    return 1;
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a number from 0 to 65535, not "${values.port}".`);
    return 1;
  }

  let loaded;
  try {
    loaded = await loadConfig(values.config ?? DEFAULT_CONFIG_FILE);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const dirStat = await stat(loaded.tasksDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    console.error(`${values.config ?? DEFAULT_CONFIG_FILE}: tasksDir: ${loaded.tasksDir} is not a folder.`);
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
