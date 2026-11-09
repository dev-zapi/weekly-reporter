# sources — collect sources (采集源)

Manage the repo records the app pulls commits from. Nine verbs exist today:

```
wrp sources list   [--name] [--type] [--status] [--scope] [--sync]
wrp sources show   <ref>
wrp sources create [--type <type>] --name <text> (--path <dir> | --owner <o> --repo <r> --token <t> [--base-url <url>]) --email <a> [--email <b>...] [--branch <b>...] [--alias <x>...] [--scope <work|personal>]
wrp sources update <ref> [--name] [--scope] [--email | --add-email] [--alias | --add-alias] [--branch] [--path] [--owner] [--repo] [--base-url] [--token]
wrp sources enable <ref> [--off]
wrp sources delete <ref> [--confirm]
wrp sources lookup --path <repo root>
wrp sources emails --path <repo root>
wrp sources sync   <ref> [--enable]
```

`lookup`/`emails`/`sync` are the collection half: find a source by directory,
list its commit authors, and trigger a sync. They are the building blocks of the
onboarding flow. For the full flow of registering and syncing the repository the
user is working in, read the `collect-git-source` flow document; the semantics it
relies on are below.

## What a source actually is

A collect source (采集源) is a repo the app pulls commits from.

- **type** — `git-local` (a repo directory on this machine) or one of
  `git-remote-github` / `git-remote-gitlab` / `git-remote-gitee`.
- **location** — `git-local` stores the absolute local directory in
  `config.owner`; remote types store the org/user in `config.owner`, the repo in
  `config.repo`, the access token in `config.token`, and optionally a
  self-hosted API root in `config.baseUrl`. `wrp sources create` takes `--path`
  for the former and `--owner`/`--repo`/`--token`/`--base-url` for the latter.
- **name** — display only, 1–100 characters, **not unique**. `--name` search in
  `list` matches the display name OR any alias, server-side.
- **aliases** — up to 20, each 1–100 characters. Aliases **must be unique across
  sources**; a collision is rejected with `别名已被使用 [DUPLICATE_ALIAS]`.
  `show`/`update`/`enable`/`delete` resolve `<ref>` against names and aliases.
- **authorEmails** — the commit-author emails whose commits get collected; at
  least one is required (the API rejects an empty list).
- **status** — derived, not free text: `enabled` (has emails and is on),
  `disabled` (manually off), `unavailable` (no author emails or a broken local
  path). A source can briefly be `enabled` with `enabled=false`; that stale mix
  is surfaced in `list`/`show`.
- **branches** — an empty branch config is meaningful: `git-local` collects
  **all local branches**, remote types follow the repo's **default branch**
  (ADR-0017). A non-empty list pins collection to exactly those branches.
- **sync cursors** — each branch carries its own cursor (`config.branchCursors`,
  committer-date based, ADR-0001/0017). Cursors are only ever displayed by
  `show`; they are never accepted in a request.
- **last sync status** — `lastSyncStatus` is written as `failure` by the retired
  TypeScript server and as `failed` by the Go server. The `--sync failure` filter
  matches both spellings; either value means the last run failed.
- **token** — responses always mask it as `[ENCRYPTED]`; `git-local` never uses
  one. Never copy the masked value into a request body: omitting `token` keeps
  the stored one (ADR-0011), and `--token` is the only way to replace it.

Deleting a source keeps already-collected events on the timeline — they fall
into the "other" group. The source record and its sync cursors are gone for good.

## `<ref>` resolution

A numeric ID (`7` or `#7`), a display name, or an alias:

1. numeric → fetched directly by ID;
2. otherwise an exact case-insensitive match on a name or alias;
3. otherwise a substring match on names and aliases;
4. more than one candidate → one `✗ '<ref>' matches N collect sources: #1 a, #2 b`
   line; pass one of those IDs. Nothing matches → `✗ no collect source matches '<ref>'`.

## Query

`wrp sources list` applies `--name`, `--type`, `--status`, `--scope` and
`--sync` server-side and prints one line per source:

```
#7 [git-local] [work] [enabled] acme (alias: acme-local) — 2 emails, 1 branches, sync 2026-11-07 10:00:00
— 1 source(s) (work 1 / personal 0)
```

The body carries the name (+ aliases), email count, branch mode
(`all-branches` for a local source with no branch list, `default-branch` for a
remote one) and the last sync time or `never synced`. Empty results print
`No collect sources match.` with no footer.

`wrp sources show <ref>` is the only place the full config, per-branch cursors
and timestamps are printed. Multi-line output is deliberately confined to
`show`.

## Create

`--type` defaults to `git-local`. Without `--branch` the new source starts in
all-branches (local) / default-branch (remote) mode. `--scope` defaults to
`personal`. Confirm the details with the user before creating, and prefer the
collect-git-source flow when onboarding the current working repository.

Client-side checks: type/scope enums, name 1–100, at least one syntactically
valid `--email`, at most 20 aliases, `--path` required for `git-local` and
rejected for remote types, and owner+repo+token all required for remote types.

## Update

The API's `PUT /api/collect/sources/<id>` replaces the **whole record**, so
`update` fetches the current source first and backfills every field you did not
pass — only what you name changes. The payload always carries `type`, `name`,
`projectScope` and `config`; `aliases` travel top-level only when non-empty.

- `--email` / `--alias` **replace** the list; `--add-email` / `--add-alias`
  **append** (emails dedupe case-insensitively, aliases do not dedupe).
  The two forms are mutually exclusive per field.
- `--branch` replaces the branch list. A branch that disappears (including a
  renamed one) loses its sync cursor and re-collects from scratch — the command
  prints a warning when this happens. Without `--branch`, the current branch
  names are resent so cursors survive; a source with no branch list keeps that
  sentinel (the key is omitted).
- `--path` and `--owner` are synonyms for `config.owner`.
- Sync cursors are never sent. The stored token is never sent either: only an
  explicit `--token` replaces it.
- With no field flags at all the command fails with `nothing to update`.

Print the planned change and get approval before running — this edits live
config.

## Enable

`wrp sources enable <ref>` enables, `--off` disables. It sends `enabled` and
`status` **together** via PATCH: a bare `enabled` flip leaves `status` stale
(the server does not recompute it on PATCH). Enabling an `unavailable` source is
refused — that state means missing emails or a broken path, and enabling would
not fix either. Fix the cause first (`--add-email`, or correct `--path`), then
enable. Disabling an unavailable source is allowed.

## Delete

Without `--confirm` the command prints a `PLAN:` preview of the matched source
(owner, email count, last sync) and the reminder that collected events survive
in the "other" group, then exits non-zero with `NOT EXECUTED — re-run with
--confirm`. Surface that preview to the user before re-running with `--confirm`.
Name resolution means the caller may not have looked at what they matched, so
never skip the preview.

## Onboarding & sync (lookup / emails / sync)

The collection half of the module. The repository directory is the **only**
locator for a git-local source: `lookup` matches the normalized absolute path in
`config.owner` (exact, then realpath-equivalent so symlinked or `~` forms
resolve), and `name` is display-only. A renamed source is still found by path;
two directories are never matched by name.

### Onboarding flow

1. Resolve the repo root (a subdirectory auto-resolves to it).
2. `wrp sources lookup --path <repo root>` and branch on the outcome:
   - **exit 0** — a source exists. Read `status`:
     - `enabled` → `wrp sources sync <id>`.
     - `disabled` → ask the user "启用并同步？", then
       `wrp sources sync <id> --enable`.
     - `unavailable` → report the likely cause (see below) and stop. Do not
       manage emails/branches of an existing source from this flow; fix it with
       `wrp sources update` only after the user asks.
   - **exit 3** — no source for that path. This is the clean "not onboarded"
     branch of the flow: branch on the exit code, never on the error text. Ask
     once — "要把这个仓库接入并立即同步吗？" — and only on yes continue to
     step 3.
   - any other exit — a real error; surface the one `✗` line.
3. `wrp sources emails --path <repo root>` — present the
   `commits`/`email`/`name` table and have the user pick at least one author
   email plus the `projectScope` (default `personal`).
4. `wrp sources create --type git-local --path <repo root> --name <repo dir
   basename> --email <a> [...] --scope <work|personal>` — path is the locator,
   the name is only a label.
5. `wrp sources sync <new id>` and report the summary.

**Never auto-create and never auto-enable.** Both write live configuration, so
each needs explicit user confirmation first. Do not guess emails either — offer
the table and let the user choose.

### lookup — find the source for a path

```bash
wrp sources lookup --path <repo root>
```

Exit 0 prints the record fields:

```
id:       7
name:     acme
status:   enabled
enabled:  true
scope:    work
emails:   a@example.com, b@example.com
branches: main, dev
```

`branches: all branches` means the branch config is empty, which for git-local
is the meaningful **all-branches** sentinel (ADR-0017) — not an error and not a
prompt to pin branches. `unavailable` means the source cannot be collected:
either no author emails or a local path the server cannot read. Enabling it
does not fix either cause.

Exit codes: `0` found, `3` not found (clean onboarding branch), `1` other
errors.

### emails — commit authors for a path

```bash
wrp sources emails --path <repo root>
```

Prints the fixed-width table in the server's order (commit count desc), off the
last 300 commits:

```
commits  email                          name
     12  a@example.com                   Alice
      3  b@example.com                   Bob
```

No authors prints `(no commit authors found in the last 300 commits)`. A repo
with no commits or an unreadable path can legitimately produce that empty
answer, so check the path before concluding the user has no history.

### sync — trigger collection

```bash
wrp sources sync <ref> [--enable]
```

`<ref>` resolves exactly like every other sources verb (ID, name or alias). The
source is read first so the summary can name it. `--enable` PATCHes
`enabled` **and** `status` together before syncing (a bare `enabled` flip leaves
`status` stale; only ask for it when the user wants a disabled source turned
back on).

Success prints the summary and one line per branch:

```
✓ source synced: #7 acme — 12 commits scanned, 3 new events
  main: ✓ 12 commits
  dev: ✓ 0 commits
```

Failure outcomes:

- **409 `SOURCE_BUSY`** — another sync or manual fetch holds the repo lock.
  Nothing is wrong; retry in a few seconds.
- **500 `SYNC_FAILED` with `autoDisabled`** — the server disabled the source
  because it cannot collect at all (no configured emails or a path that is gone
  or unreadable). The `✗` line names the auto-disable and prints the fix: check
  the stored path with `wrp sources show <id>`, fix it with
  `wrp sources update <id> --path <repo root> --add-email <address>`, then
  re-enable it.
- **500 `SYNC_FAILED` without `autoDisabled`** — at least one branch failed; the
  `✗` line lists the failed branches with their errors. Fix the cause and
  re-run.

Sync is the only verb here that writes timeline events. Run it only when the
user asked for a collection (or confirmed onboarding); never as a side effect.

## Errors

| Message | Cause | Fix |
|---|---|---|
| `unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | provision credentials with `wrp init` (exact command in the ✗ line) |
| `Cannot reach weekly-reporter at …` | server down / wrong URL | start it (`npm run dev`) or set `WEEKLY_REPORTER_BASE_URL` |
| `no collect source matches '<ref>'` | nothing by that ID/name/alias | `wrp sources list` |
| `'<ref>' matches N collect sources` | name/alias is ambiguous | pass one of the listed `#id`s |
| `DUPLICATE_ALIAS: 别名已被使用: …` | alias already exists on another source | pick a different alias |
| `VALIDATION_ERROR: 数据验证失败` | body failed server-side zod | read the message; check types/enums/lengths |
| `#N <name> is unavailable` (enable) | no emails or broken path | `--add-email` or fix the path, then enable |
| `nothing to update: pass at least one field` | no change flags given | pass at least one field flag |
| `no collect source for path '…'` (lookup, exit 3) | no source for that directory | normal onboarding branch — offer to create and sync |
| `SOURCE_BUSY: 该仓库正在操作中` (sync) | another sync/fetch holds the repo lock | retry in a few seconds |
| `sync failed and #N <name> was auto-disabled` (sync) | no emails or unreadable path at sync time | fix the path/emails, then re-enable |
| `sync failed for #N <name>` (sync) | at least one branch failed | fix the listed branch errors and re-run |

## Out of scope here

- Remote hosted sources (GitHub/GitLab/Gitee repos not cloned locally) are
  managed like any other source, but `lookup`/`emails` operate on git-local
  paths only.
- Single timeline events → `wrp events`.
- Bulk delete / bulk scope update and `removeBranch` — loop the single-source
  verbs instead.
