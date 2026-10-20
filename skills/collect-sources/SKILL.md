---
name: collect-sources
description: >-
  Manage collect sources (采集源) in the weekly-reporter app via Node.js scripts — list and filter them, show one source's full config, create a source of any type (git-local or remote GitHub/GitLab/Gitee), update fields safely (rename, add or replace author emails, aliases, branches, project scope, owner/repo), enable or disable, and delete with confirmation. Use this skill whenever the user mentions collect source records themselves: "有哪些采集源", "看下这个源的配置", "改一下采集源的名字", "删掉那个采集源", "给采集源加个邮箱", "启用/禁用采集源", "采集源列表", "list collect sources", "rename a source" — even if they never say the words "collect source". Two boundaries: triggering a sync (同步) or onboarding the current directory's repo is the collect-git-source skill; timeline events belong to timeline-events.
---

Manage collect sources through six Node.js scripts under `{baseDir}/scripts/`. They use built-in `fetch` (Node 18+), take no dependencies, and read credentials from the env (`WEEKLY_REPORTER_PAT` for the token; `WEEKLY_REPORTER_BASE_URL`, or its alias `WEEKLY_REPORTER_URL`, for the base URL) or from the machine credential at `~/.config/weekly-reporter/auth.json`; the base URL defaults to `http://localhost:6868`, the dev and systemd port for this app. Without a PAT every `/api/**` call returns 401 — run the **configure-pat** skill to set one up. Most scripts take a `<ref>` — a numeric ID or a source name/alias (exact match first, substring as fallback); ambiguous names fail listing candidates.

## What a source actually is

A collect source (采集源) is a repo the app pulls commits from. Fields that matter:

- **type** — `git-local` (a repo directory on this machine, located by `config.owner` = absolute local path) or `git-remote-github` / `git-remote-gitlab` / `git-remote-gitee` (located by `owner` = org, `repo`, `token`).
- **name** — display only, 1–100 chars, not unique. **aliases** (≤20) are what name-search matches beyond the name itself; only aliases must be unique across sources.
- **authorEmails** — the emails whose commits get collected; ≥1 is required. **status** is derived: `enabled` (has emails), `disabled` (manually off), `unavailable` (no emails or a broken path — check, don't just flip it).
- **branches** — empty config is meaningful: git-local collects *all* local branches, remote follows the default branch. Each branch carries its own sync cursor (committer-date based, ADR-0001/0017).
- **token** — always masked `[ENCRYPTED]` in responses; never copy it into a request body (omitting it keeps the stored one, ADR-0011).
- Deleting a source keeps already-collected events on the timeline — they fall into the "other" group.

## Query

```bash
node {baseDir}/scripts/list.mjs [--name <text>] [--type <t>] [--status <enabled|disabled|unavailable>] [--scope <work|personal>] [--sync <success|failure|never>]
```
One line per source (id, name + aliases, type, scope, status, email count, branch mode, last sync) plus a count footer. `--name` matches the display name OR any alias.

```bash
node {baseDir}/scripts/show.mjs <ref>
```
Full detail: config, per-branch sync cursors, timestamps.

## Change

The API's PUT replaces the *whole* record, so `update.mjs` fetches the current source first and backfills every field you did not pass — only what you name changes. Sync cursors and the stored token are never sent (the server preserves both).

```bash
node {baseDir}/scripts/update.mjs <ref> [--name <text>] [--scope <work|personal>]
                                        [--email <a>... | --add-email <a>...]
                                        [--alias <x>... | --add-alias <x>...]
                                        [--branch <b>...] [--path <dir>] [--repo <r>] [--baseUrl <url>] [--token <t>]
```
`--email`/`--alias` replace the whole list; `--add-email`/`--add-alias` append (emails dedupe case-insensitively). `--branch` replaces the branch list — a branch that disappears (including a renamed one) loses its sync cursor and re-collects from scratch. `--path` (or `--owner`) is the git-local repo directory / remote org. Print the planned change and get user approval before running — this edits live config.

```bash
node {baseDir}/scripts/enable.mjs <ref> [--off]
```
Enable (default) or disable. Sends `enabled` and `status` together — a bare `enabled` flip leaves a stale status. Refuses to enable an `unavailable` source: that state means missing emails or a broken path, and enabling would not fix either (use `update.mjs --add-email` or fix the path first).

## Create / delete

```bash
node {baseDir}/scripts/create.mjs [--type <type>] --name <text> (--path <dir> | --owner <o> --repo <r> --token <t> [--baseUrl <url>]) --email <a> [--email <b>...] [--branch <b>...] [--alias <x>...] [--scope <work|personal>]
```
`--type` defaults to `git-local`. Without `--branch` the source starts in all-branches (git-local) / default-branch (remote) mode. Confirm the details with the user before creating. Note: for onboarding *the repo the user is working in*, the collect-git-source skill is the better path — it walks lookup/emails/sync interactively.

```bash
node {baseDir}/scripts/delete.mjs <ref> --confirm
```
Without `--confirm` prints what was matched (and that collected events survive, moving to the "other" group) and exits 1. Always surface that preview to the user before re-running with `--confirm`.

## Errors

| Message | Cause | Fix |
|---|---|---|
| `Unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | Run the **configure-pat** skill (`node scripts/configure-pat.mjs`) |
| `Cannot reach weekly-reporter at …` | Server down / wrong URL | Start it (`npm run dev`) or set `WEEKLY_REPORTER_URL` |
| `no collect source matches '<ref>'` | Nothing by that ID/name/alias | Run `list.mjs` to see what exists |
| `'…' matches N collect sources` | Name/alias is ambiguous | Pass one of the listed `#id`s instead |
| `别名已被使用: … [DUPLICATE_ALIAS]` | An alias already exists on another source | Pick a different alias |
| `数据验证失败 [VALIDATION_ERROR]` | Body failed server-side zod | Read the detail line; check types/enums/lengths |
| `refusing to enable unavailable` | Source has no emails or broken path | `update.mjs --add-email` or fix the path, then enable |
| `nothing to update — pass at least one field` | No change flags given | Pass at least one field flag |

## Out of scope

- Triggering a sync (同步) or onboarding the current directory's repo → **collect-git-source** skill.
- Single timeline events → **timeline-events** skill.
- Bulk delete / bulk scope update and `removeBranch` — loop the single-source verbs instead (the API has bulk endpoints, but chat usage rarely needs them).
