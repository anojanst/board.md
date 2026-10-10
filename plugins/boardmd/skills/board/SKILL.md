---
name: board
description: Open this repo's task board (board.md) in the browser. Use when the user asks to see, open, start or show the board.
argument-hint: '[--port <number>]'
---

# Open the board

Start [board.md](https://github.com/anojanst/board.md) for this repo and tell the user where it is.

1. If there is no `boardmd.config.json` in the project root, the repo isn't set up: say so, offer
   `/boardmd:setup`, and stop.
2. Work out how to run boardmd here: `pnpm boardmd` when there is a `pnpm-lock.yaml`,
   `yarn boardmd` for a `yarn.lock`, `bunx boardmd` for a `bun.lock` or `bun.lockb`, otherwise
   `npx boardmd`.
3. Start the server in the background, because it keeps running:

   ```bash
   <boardmd> serve --open $ARGUMENTS
   ```

   If `package.json` already has a script that runs `boardmd serve`, use that script instead.
4. Read its output for the address (http://127.0.0.1:4600 unless a port was given). If it says the
   port is in use, a board may already be running there: tell the user, or start this one with
   `--port 4601`.
5. Tell the user the address, and that:
   - the page updates by itself when task files or branches change;
   - dragging a card changes only the `status:` line of that task's file, and nothing is committed;
   - cards in progress on a branch or in review on a pull request are locked, because their status
     changes in their own pull request.

Leave the server running until the user asks to stop it.
