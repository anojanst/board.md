# board.md

A local web board for the markdown task files already in your repo.

> **Not released yet.** The plan is in [HANDOVER.md](HANDOVER.md).

board.md is a tool, not a file format. You keep one markdown file per task, with YAML
frontmatter in whatever shape you already use. A small config file tells the board which fields
mean what, and `boardmd serve` shows the tasks as columns on localhost:

- **Your files as they are.** Nothing to convert or migrate.
- **Live git state.** A local branch for a task shows it as in progress, and an open pull
  request shows it as in review, with draft, approved and changes-requested labels. Nothing is
  written to your files to do this.
- **Drag to change status.** Only the `status:` line changes, so the git diff is one line.

It suits repos where a coding agent keeps the task files: the board reads the agent's files and
shows its branches and pull requests as they happen.

## Planned usage

```bash
npm install --save-dev board.md
npx boardmd serve --open
```

## Development

```bash
pnpm install
pnpm test        # Vitest
pnpm typecheck
pnpm build       # dist/cli.js
```

`test/fixtures/basic/` holds a made-up project in the reference format.

## License

[MIT](LICENSE)
