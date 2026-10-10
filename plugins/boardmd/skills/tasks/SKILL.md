---
name: tasks
description: Read, create and update a repo's markdown task files through boardmd (board.md). Use when the user asks to add or file a task, change a task's status, branch or PR, list or find tasks, see what is in progress or in review, or check the task files, in a repo that has a boardmd.config.json.
---

# Tasks with boardmd

This repo keeps its tasks as markdown files, one per task, and
[board.md](https://github.com/anojanst/board.md) reads and changes them. Use its commands; don't
edit frontmatter by hand.

## First

1. Check that `boardmd.config.json` exists in the project root. If it doesn't, the repo isn't set
   up: say so, offer `/boardmd:setup`, and stop.
2. Work out how to run boardmd here, and use that for every command below:
   - `pnpm boardmd` when there is a `pnpm-lock.yaml`
   - `yarn boardmd` when there is a `yarn.lock`
   - `bunx boardmd` when there is a `bun.lock` or `bun.lockb`
   - `npx boardmd` otherwise (`npx board.md` when the package isn't installed)
3. Run `<boardmd> guide` and follow it. It prints this repo's own rules: where tasks live, the
   next id, each field's allowed values, how branches are named, and any extra checks.

## Commands

| To | Run |
| --- | --- |
| List open tasks with live branch and PR state | `<boardmd> list --json` (add `--all` for finished ones; filter with `--status <s>` or `--<field> <value>`) |
| Read one task | `<boardmd> show <id>` |
| Create a task | `<boardmd> new "<title>" --set <field>=<value> …` (add `--body "<markdown notes>"`) |
| Change fields | `<boardmd> set <id> <field>=<value> …` (`<field>=` clears a value) |
| Validate the files | `<boardmd> check` |

## Rules

- **Creating:** `new` picks the id, the folder and the file name. If it reports a missing or
  disallowed field, take the value from similar tasks (`list --json`) or ask the user, then run it
  again. Never invent an id or create the file yourself.
- **Updating:** `set` changes only the lines you name. Edit the notes, the markdown body below the
  frontmatter, directly in the file.
- **In progress and in review come from git**, not from the file: a task's branch shows it as in
  progress and its open pull request shows it in review. If `set` warns that a task is live, its
  status normally changes in that task's own pull request, so check with the user before forcing
  a different one.
- After any change, run `<boardmd> check` and fix what it reports.
- Don't reuse or renumber ids, and don't move task files yourself; changing the folder field with
  `set` moves the file.
- boardmd never commits. Leave committing to the user or to the repo's own workflow.
