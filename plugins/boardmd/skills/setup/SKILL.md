---
name: setup
description: Set up board.md in this repo by installing the package, working out its config from the existing markdown task files, and adding the instructions coding agents need. Use when the user asks to set up, install or try board.md or boardmd, or wants a board for their markdown task files.
---

# Set up board.md

[board.md](https://github.com/anojanst/board.md) shows the markdown task files in a repo as a
board. Setting it up installs one dev dependency and writes a config file. It doesn't convert or
move any task files.

## 1. Check the repo

- If `boardmd.config.json` already exists in the project root, it is set up: say so and offer
  `/boardmd:board`. Only run the steps below again if the user wants to redo the setup, and then
  pass `--force` to `init`.
- board.md needs Node 20 or later (`node --version`).

## 2. Install it

Use the repo's package manager, as a dev dependency:

| Repo has | Install with | Run boardmd as |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm add -D board.md` (add `-w` when there is a `pnpm-workspace.yaml`) | `pnpm boardmd` |
| `yarn.lock` | `yarn add -D board.md` | `yarn boardmd` |
| `bun.lock` or `bun.lockb` | `bun add -d board.md` | `bunx boardmd` |
| `package.json` only | `npm install --save-dev board.md` | `npx boardmd` |
| no `package.json` | nothing to install | `npx board.md` |

Then check `<boardmd> --version` prints 0.2.0 or later. pnpm holds back versions published in the
last day and quietly installs an older one; if that happened, tell the user rather than working
around it.

## 3. Work out the config

```bash
<boardmd> init --yes
```

`init` finds the task files, works out the id format, statuses, columns, badges, filters and
branch naming, and writes `boardmd.config.json`. With `--yes` it also adds a `board` script to
`package.json`, a short section to `CLAUDE.md` or `AGENTS.md`, and a project skill in
`.claude/skills/boardmd/`. With no task files in the repo, it creates `tasks/` with one example
task.

Show the user the summary `init` printed. If the task folder or anything else it found looks
wrong, run it again with `--force --tasks-dir <folder>`, or edit `boardmd.config.json`.

## 4. Check and hand over

1. Run `<boardmd> check`. Report any problems it lists; they are in the task files, not in the
   setup.
2. List what changed with `git status --short`. Nothing is committed: leave that to the user.
3. Offer to open the board with `/boardmd:board`.
