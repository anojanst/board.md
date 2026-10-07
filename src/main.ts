// The boardmd command line. src/cli.ts runs it; tests call main() directly.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `boardmd ${version}

Usage:
  boardmd serve [--port 4600] [--open] [--offline] [--config boardmd.config.json]

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    console.log(version);
    return 0;
  }
  const [command] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  if (command === 'serve') {
    console.error('boardmd serve is not built yet (HANDOVER.md, milestone 1).');
    return 1;
  }
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
