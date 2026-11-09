# sources — collect sources (采集源)

Manage the repo records the app pulls commits from. Six verbs exist today:

```
wrp sources list   [--name] [--type] [--status] [--scope] [--sync]
wrp sources show   <ref>
wrp sources create [--type <type>] --name <text> (--path <dir> | --owner <o> --repo <r> --token <t> [--base-url <url>]) --email <a> [--email <b>...] [--branch <b>...] [--alias <x>...] [--scope <work|personal>]
wrp sources update <ref> [--name] [--scope] [--email | --add-email] [--alias | --add-alias] [--branch] [--path] [--owner] [--repo] [--base-url] [--token]
wrp sources enable <ref> [--off]
wrp sources delete <ref> [--confirm]
```

`lookup`, `emails` and `sync` are not built yet (ticket #128). For onboarding the
repository the user is working in, the collect-git-source flow is the better path:
it walks lookup/emails/sync interactively.

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

## Out of scope here

- Triggering a sync (同步) or onboarding the current directory's repo →
  the collect-git-source flow (`lookup`/`emails`/`sync`, ticket #128).
- Single timeline events → `wrp events`.
- Bulk delete / bulk scope update and `removeBranch` — loop the single-source
  verbs instead.
