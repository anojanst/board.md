# board.md plugin for Claude Code

Lets Claude Code set up and use [board.md](https://github.com/anojanst/board.md), a local board
for the markdown task files already in your repo.

## Install

Inside Claude Code:

```
/plugin marketplace add anojanst/board.md
/plugin install boardmd@board-md
```

## Skills

| Skill | What it does |
| --- | --- |
| `/boardmd:setup` | Installs board.md in the current repo with its package manager, runs `boardmd init` to work out the config from your task files, and reports what was written. |
| `/boardmd:board` | Starts the board for the current repo and opens it in your browser. |
| `/boardmd:tasks` | Used by Claude when you ask to add, update, list or check tasks. It runs `boardmd guide` for the repo's rules, then `boardmd new`, `set`, `list` and `check`. |

## What it needs

- Node 20 or later.
- The `board.md` npm package, which `/boardmd:setup` installs as a dev dependency. The plugin
  itself contains only instructions: no scripts, hooks or servers.
- Optional: git and the GitHub CLI (`gh`), for live branch and pull request state on the board.

## What it changes

Only what board.md itself does: `setup` adds a dev dependency, `boardmd.config.json`, a
`package.json` script, a section in `CLAUDE.md` or `AGENTS.md`, and a project skill. `tasks`
creates and edits task files through `boardmd new` and `boardmd set`. Nothing is committed or
pushed.

MIT licensed.
