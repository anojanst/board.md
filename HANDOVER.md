# Handover: board.md, a browser board for markdown task files

**board.md** is a small npm package that serves a project board on localhost. It reads a folder of markdown task
files with YAML frontmatter and shows them as columns by status. It adds live state from git
branches and GitHub pull requests, and lets you drag a card to change its `status`.

It's built in its own repository, then installed into EduStrux as a dev dependency. EduStrux is
the first user and the reference setup throughout this plan.

Written 2026-10-07 from EduStrux at commit `12bd297`.

## Decisions (owner, 2026-10-07)

| Topic          | Decision                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Package name   | **`board.md`** on npm (free on 2026-10-07)                                                                                         |
| CLI command    | **`boardmd`** (`npx board.md` also works). The config file is `boardmd.config.json`.                                               |
| Publishing     | **Public on npm from v0.1.** The owner runs `npm publish` from their own npm account.                                              |
| License        | **MIT**                                                                                                                            |
| Editing        | **Drag a card to change its `status`** (§5.4)                                                                                      |
| Later (v0.2)   | **Replace EduStrux's `scripts/board.mjs`** with `boardmd list --json` and `boardmd check`, so EduStrux has one board tool (§9) |
| Still open     | Whether dropping a card into In progress is allowed. This plan allows it (§10).                                                    |

---

## 1. Why build it, and what makes it different

Similar tools exist (checked 2026-10-07):

- **Backlog.md** (`backlog browser --port 8080`): markdown task manager with a web board.
- **Kandown** (`npx kandown`): file-based kanban with a local HTTP server.
- **Markdown Task Manager**: single-file drag-and-drop board over markdown.
- **sprintmagic** (v0.1, June 2026): moves issues as branches and PRs happen, the same idea as
  live state here. All tasks live in one `board.md` file, which a GitHub Action rewrites and
  commits, and the board is viewed on sprintmagic.app.
- **planr** (v2.0, October 2026): markdown task files for projects built by coding agents, with a
  CLI, a board and a Claude Code plugin. It uses its own file format.

Each one requires its own file layout and fields. sprintmagic also calls its board file
`board.md`, so the README must make clear that this package is a tool, not a file format.

This package should instead:

1. **Read your existing files as they are.** A config file maps your frontmatter fields to the
   board, so nothing has to be converted.
2. **Show what's happening in git.** A local branch for a task shows it as in progress, and an
   open PR shows it as in review, with draft, approved and changes-requested labels. EduStrux's
   `scripts/board.mjs` already does this in the terminal.
3. **Change only the `status:` line.** An edit from the browser rewrites that one line and leaves
   every other byte of the file alone, so the git diff is one line.
4. **Show git state live, without committing.** sprintmagic writes column changes into the file
   and commits them; this board works them out from branches and PRs each time it loads, so the
   files only change when someone means them to.

A good way to describe it in the README: it fits repos where a coding agent keeps the task files
(as EduStrux's Claude Code skills do). The board reads the agent's files as they are and shows
its branches and PRs as they happen.

## 2. Name

**`board.md`**, with the CLI command **`boardmd`** (see Decisions). The name was free on npm on
2026-10-07; claim it with the first publish.

## 3. Scope of v0.1

**In:**

- `boardmd serve`: starts a local web server and prints the URL (`--port`, `--open`,
  `--offline`, `--config`).
- Columns by status, with live git and PR state.
- Drag a card to another column to change its `status` in the file.
- Filters: phase, module, priority, size, and text search. Swimlanes by phase can be toggled.
- Detail panel: the task's rendered markdown and its frontmatter.
- Auto-refresh when task files change on disk.
- A banner listing task files that have uncommitted changes.

**Out (for later, if ever):**

- Creating, renaming or deleting tasks, or editing fields other than `status`.
- Running git commands that change anything: committing, branching, pushing.
- Logins, several users, or hosting anywhere other than localhost.
- Replacing `pnpm board --json` and `--check` in EduStrux. Its skills depend on them, so
  `scripts/board.mjs` stays for now (see §9).

## 4. Configuration

The config is a JSON file in the consuming repo, by default `boardmd.config.json` at the root.
It's JSON rather than JavaScript so that loading it never runs code. Here is the full config for
EduStrux, which v0.1 must support:

```json
{
  "tasksDir": "docs/project/tasks",
  "id": { "field": "id", "pattern": "^TUI-(\\d+)$", "template": "TUI-{n}" },
  "titleField": "title",
  "statusField": "status",
  "statuses": ["todo", "in-progress", "blocked", "done", "deferred"],
  "columns": [
    { "name": "Todo", "status": "todo" },
    { "name": "In progress", "status": "in-progress", "live": ["in-progress"] },
    { "name": "In review", "live": ["in-review"] },
    { "name": "Blocked", "status": "blocked" },
    { "name": "Done", "status": "done" },
    { "name": "Deferred", "status": "deferred", "collapsed": true }
  ],
  "fields": {
    "phase": {
      "label": "Phase",
      "swimlane": true,
      "values": {
        "P0": "Decisions",
        "P1": "Foundation",
        "P2": "Vertical slice",
        "P3": "Core modules",
        "P4": "Background & comms",
        "P5": "SaaS layer",
        "P6": "Launch hardening",
        "P7": "UI"
      }
    },
    "module": { "label": "Module", "filter": true },
    "priority": {
      "label": "Priority",
      "badge": true,
      "values": { "P0": "Must", "P1": "Should", "P2": "Could" }
    },
    "size": { "label": "Size", "badge": true, "values": { "S": "S", "M": "M", "L": "L" } },
    "endpoints": { "label": "Endpoints", "list": true }
  },
  "live": {
    "baseBranch": "main",
    "branchPattern": "^(?:task|docs|fix)/tui-(\\d+(?:-\\d+)*)-[a-z]",
    "rangePrefixes": ["docs/"],
    "branchField": "branch",
    "prField": "pr",
    "ignoreStatuses": ["done", "deferred"]
  },
  "checkCommand": "pnpm -s board --check",
  "afterEditHint": "Commit status changes in a chore/board-<slug> PR (see docs/project/README.md)."
}
```

What each part means:

- **`tasksDir`:** the package reads every `*.md` file under it, recursively. In EduStrux the
  subfolders are phase folders, such as `p2-vertical-slice/`.
- **`id`:** which frontmatter field holds the id, and the pattern that extracts its number. Cards
  sort by that number. `template` turns a number found in a branch name back into an id.
- **`columns`:** each column shows cards whose file has that `status`, or whose live state is
  listed in `live`. A column with a `status` is a drop target; a column with only `live` (In
  review) is not.
- **`fields`:** extra frontmatter fields. They can be shown as card badges, used as filters or
  swimlanes, and given display labels for their values.
- **`live`:** how to match branches and PRs to tasks (§5.2). Omit it to switch live state off.
- **`checkCommand`:** an optional command to run after each edit. Its output is shown as a
  warning; it never blocks the edit.
- **`afterEditHint`:** text shown in the uncommitted-changes banner.

Validate the config when the server starts, and fail with a clear message that names the bad key.

## 5. How it works

### 5.1 Reading tasks

- Parse frontmatter with the `yaml` package. EduStrux uses a small subset (`key: value`,
  `key: []`, `- item` lists, single-quoted titles that contain `: `), but other repos won't.
- Keep each file's raw text and a version string (a SHA-1 of the content) in memory. That
  version is used to detect conflicting edits (§5.4).
- A file with no frontmatter, or one that doesn't parse, still loads. Show it in an "Invalid
  files" list instead of crashing.

### 5.2 Live state (port this from `scripts/board.mjs`)

Live state applies only to tasks whose status isn't in `ignoreStatuses`.

1. **Local branches:** run `git for-each-ref --format=%(refname:short) refs/heads`. A branch that
   matches `branchPattern` names one or more task numbers, separated by `-`:
   - `task/tui-27-…` names TUI-27.
   - `task/tui-27-29-…` names TUI-27 and TUI-29. (Bundles list their numbers.)
   - `docs/tui-1-10-…` names TUI-1 to TUI-10. A branch whose prefix is in `rangePrefixes` and has
     two numbers, with the second more than one above the first, is a range.

   Each task named this way shows as in progress, with the branch name.
2. **Pull requests:** run
   `gh pr list --state all --limit 200 --json number,state,headRefName,baseRefName,isDraft,reviewDecision`.
   A PR belongs to a task when:
   - its head branch names the task (same rules as above), or
   - its number equals the task's `pr` field, or
   - its head branch equals the task's `branch` field.

   For each task it belongs to:
   - **Open PR:** the task shows as in review, with a note: `draft`, `changes requested` or
     `approved`. This takes precedence over in progress.
   - **Merged into `baseBranch` and equal to the task's `pr`, with the file not marked done or
     blocked:** add a "merged, file not updated" badge to the card. It stays in its column.
3. **Missing tools:** without git, or without `gh` (or not signed in), the board still works.
   Show a note such as "PR state unavailable", as `board.mjs` does. `--offline` skips both.
4. **Caching:** `gh` takes about a second, so cache its result for 60 seconds. A Refresh button
   fetches it again straight away.

Every git and `gh` call goes through one injectable runner function, so tests can fake it.

### 5.3 Where a card appears

- If the task has live state, it goes in the column whose `live` list includes that state.
  Otherwise it goes in the column whose `status` equals the file's status.
- A task whose status matches no column goes in an "Other" column, so nothing is hidden.
- Counts in each column header must match what `pnpm board --all --json` reports.

### 5.4 Dragging a card (editing `status`)

Rules:

- Only cards **without** live state can be dragged. A card that's in progress on a branch or in
  review has its status set by its own PR, so its tooltip says that instead.
- Only columns with a `status` accept a drop. The new status must be in `statuses`.
- Show the current branch in the header. If it isn't `baseBranch`, warn before the first edit:
  "You're on `task/tui-27-…`; edits will land on that branch."

The write:

1. The client sends `PATCH /api/tasks/:id` with `{ "status": "blocked", "version": "<sha1>" }`.
2. The server finds the file by **id** from its own index. It never accepts a path from the
   client.
3. It re-reads the file. If the SHA-1 no longer matches `version`, it returns **409**, the page
   reloads that card, and nothing is written.
4. It replaces only the value on the `status:` line inside the frontmatter, keeping the line's
   original key, spacing and line ending. Every other byte stays the same. If there's no
   `status:` line, it returns **422** rather than inventing one.
5. It writes atomically: write a temporary file next to the original, then rename it over.
6. If `checkCommand` is set, it runs it and returns the output as a warning, for example
   "done with a branch but no pr".
7. It returns the updated task, including its new version.

### 5.5 Uncommitted-changes banner

Run `git status --porcelain -- <tasksDir>` after each edit, and when files change on disk. If any
task files are modified, show a banner listing them, plus `afterEditHint`. For EduStrux that
reminds you that status changes ship in a `chore/board-<slug>` PR.

### 5.6 Server and API

The server uses Node's built-in `node:http`, with no framework. It listens on **127.0.0.1 only**,
default port **4600** (`--port` to change it). If the port is taken, it says so and suggests
`--port`.

| Method | Path              | Returns                                                                                                                                            |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`               | The board page                                                                                                                                     |
| GET    | `/assets/*`       | The page's JS and CSS                                                                                                                              |
| GET    | `/api/board`      | Every task (frontmatter, live state, version, relative file path), the columns, the field config, notes, uncommitted files, the current branch and the repo URL |
| GET    | `/api/tasks/:id`  | One task with its markdown body                                                                                                                    |
| PATCH  | `/api/tasks/:id`  | Changes `status`: 200, 400 (unknown status), 404, 409 (stale version), 422 (no `status:` line)                                                     |
| POST   | `/api/refresh`    | Fetches git and `gh` state again                                                                                                                   |
| GET    | `/api/events`     | Server-sent events: `changed` when a task file changes on disk (`fs.watch`, recursive), so the page reloads                                        |

Security. The server writes files, so even on localhost:

- **Host check:** reject any request whose `Host` header isn't `localhost:<port>` or
  `127.0.0.1:<port>`. This blocks DNS rebinding.
- **Write token:** writes need a random token, created at startup, embedded in the page and sent
  in a header. Also check that the `Origin` header matches. This stops other websites from
  posting to the server.
- **Markdown:** render task bodies with raw HTML escaped, so a task file can't inject scripts.

### 5.7 The page

- **Built in:** ship the page prebuilt in the package. Plain JS and CSS, or Preact bundled at
  publish time, so installing pulls in no front-end dependencies.
- **Cards:** id, title, priority and size badges, module, and a branch or PR badge. The PR badge
  links to GitHub; the repo URL comes from `git remote get-url origin`.
- **Detail panel:** rendered markdown, a table of the frontmatter, the file path with a copy
  button, and an "Open in VS Code" link (`vscode://file/<absolute path>`).
- **Filters and search** in the URL query string, so a filtered view can be bookmarked.
- **Keyboard:** a way to move a card without dragging (focus the card, then pick a column from a
  menu).
- **Dark mode** that follows the system setting.
- **Phone width** doesn't need to work well. Desktop width is the target.

## 6. Tech choices

- **Runtime:** Node 20 or later (EduStrux uses Node 24), ESM only.
- **Language:** TypeScript, built with `tsup` into `dist/`. The `bin` field points
  `boardmd` at `dist/cli.js`.
- **Dependencies:** keep them few. `yaml` for frontmatter and `marked` for markdown. Use Node's
  built-in `util.parseArgs` for CLI flags. Opening the browser is a one-line `xdg-open`, `open`
  or `start` call, so no package is needed for it.
- **Tests:** Vitest, against made-up fixture task files written in EduStrux's format. Don't copy
  real EduStrux tasks: the package is public, and they describe a private product. It needs
  these tests:
  - **One-line diffs:** dragging changes exactly one line. Compare bytes before and after,
    including CRLF files and quoted values.
  - **Live state:** branch and PR matching, including bundles, `docs/` ranges, drafts and the
    merged-but-not-done badge. Use a fake runner instead of real git and `gh`.
  - **API errors:** 400, 404, 409 and 422 from the API.
  - **Security:** a wrong `Host`, or a missing or wrong token, is rejected.
  - **No git or `gh`:** the board still loads, with a note.
  - **Config:** a bad config file fails at startup with the key named.
- **CI:** GitHub Actions running typecheck and tests on Node 20, 22 and 24.
- **License:** MIT (decided). Put the owner's name in `LICENSE`.

## 7. Milestones

1. **Read-only board:** config loading, reading tasks, columns, live state and `serve`. Done when
   the EduStrux column counts match `pnpm board --all --json`.
2. **Editing:** drag and drop, the version check, the one-line write, `checkCommand` warnings and
   the uncommitted-changes banner.
3. **Polish:** the detail panel, filters and search, swimlanes, server-sent events and keyboard
   moves.
4. **Release:** README with screenshots, then version 0.1.0 on npm. The owner runs
   `npm publish` from their account (`--provenance` when publishing from GitHub Actions).

## 8. Acceptance checks against EduStrux

Run from the EduStrux root with the config in §4:

- [ ] The board shows all 88 task files. Each column's count matches
      `pnpm board --all --json`, grouped by status and live state.
- [ ] TUI-3 is in Blocked; TUI-15, TUI-21 and TUI-88 are in In progress.
- [ ] While a task branch exists locally, that task is in In progress and can't be dragged. Once
      its PR is open, it's in In review with the PR number.
- [ ] Dragging TUI-35 from Todo to Blocked changes exactly one line (`git diff --stat` shows
      `1 insertion, 1 deletion`), and `pnpm board --check` still passes.
- [ ] Dragging a P1–P7 task that has a `branch` but no `pr` into Done shows the warning from
      `checkCommand` ("done with a branch but no pr").
- [ ] Editing a task file in an editor while the page is open updates the card within a couple
      of seconds.
- [ ] With `gh` signed out, the board loads and says PR state is unavailable.

## 9. Installing it in EduStrux

Do this in a `chore/board-web` PR in EduStrux:

1. Add the package as a root dev dependency: `pnpm add -Dw board.md`.

   This workspace enforces a minimum release age for new package versions (see
   `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`). A version published minutes ago may be
   refused: add it to that list, or wait.
2. Add `boardmd.config.json` at the root, with the config in §4.
3. Add a root script: `"board:web": "boardmd serve --open"`.
4. Document it:
   - `README.md` Commands table: a `pnpm board:web` row.
   - `docs/project/README.md` "See the board": a line for `pnpm board:web`, noting that drag
     edits still go out in a `chore/board-<slug>` PR.
5. Keep `scripts/board.mjs` for v0.1. The skills (`/mark-done`, `/recommend-next`,
   `/commander`, `/open-pr`) call `pnpm board --json` and `--check`.

**v0.2 replaces `scripts/board.mjs` (decided).** The package gains:

- `boardmd list --json`: the same JSON as `pnpm board --json`, with the same live state.
- `boardmd check`: validation rules from the config. EduStrux's rules are in `check()` in
  `scripts/board.mjs`: id format, the filename matching the id, unique ids, required fields,
  allowed values, the phase matching the folder, `pr` being a number, and "done with a branch
  but no pr" except in P0.
- `boardmd` with no arguments: the terminal table `pnpm board` prints today.

Then EduStrux points its `board` script at `boardmd`, deletes `scripts/board.mjs`, and checks
that every skill still works, all in one `chore/` PR.

## 10. Questions for the owner

Answered 2026-10-07: name, publishing, license and replacing `board.mjs` (see Decisions).

Still open:

1. **Dropping into In progress:** should it be allowed? In EduStrux, `in-progress` in a file
   means "partly built on main". This plan allows it, because it's a real status.
