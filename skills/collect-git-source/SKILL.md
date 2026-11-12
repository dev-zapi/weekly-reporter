---
name: collect-git-source
description: >-
  Trigger collection (同步) of the current directory's local Git repo as a
  weekly-reporter collect source, including one-shot first-time onboarding.
  Use when the user says things like "收集一下这个仓库", "触发采集",
  "把这个仓库接入周报系统", "同步这个 repo 的提交", or wants the cwd's
  repo registered and synced as a git-local source. NOT for single timeline
  events (use the weekly-reporter skill's `wrp events`) or for remote hosted
  sources (GitHub/GitLab repos not on this machine — out of scope).
---

Collect (同步) the local Git repo at the current working directory into the
weekly-reporter timeline. This skill is a flow document only — it ships no
scripts of its own. Every data access below is a command of the
**weekly-reporter** skill's wrp client, written shorthand as `wrp …` and run as
`node <weekly-reporter>/scripts/wrp.mjs …` (Node 18+, no dependencies). That
skill documents credential resolution and the output contract; without a PAT
every call returns 401 — run `wrp init` from the weekly-reporter skill.

The repo is located solely by its normalized absolute path (`config.owner`);
`name` is display-only. Branch config is empty on create, which means
all-branches collection (ADR-0017).

## Flow

Run these steps in order. **Do not auto-create or auto-enable** — both need
explicit user confirmation first.

1. `git rev-parse --show-toplevel` in cwd (subdirectories auto-resolve to the
   repo root). Not a repo → clear error, stop.
2. `wrp sources lookup --path <toplevel>` (stdout is the source record as one line
   of JSON; `JSON.parse` it):
   - **Found** (exit 0): read `status` and `id` from the body.
     - `enabled` → `wrp sources sync <id>`.
     - `disabled` → ask user "启用并同步？" → `wrp sources sync <id> --enable`.
     - `unavailable` → report likely cause (no emails / local path gone),
       stop, point to web UI. Never manage emails/branches of an existing
       source here.
   - **Not found** (exit 3): the stderr JSON envelope carries
     `status: 404` and a `no collect source for path '…'` message; one
     confirmation — "要把这个仓库接入并立即
     同步吗？"
     - No → stop.
     - Yes → `wrp sources emails --path <toplevel>` (body: `authors[]` with
       `name`, `email`, `count`) → present `name + email + count`
       multi-select (≥1 required) and pick `projectScope` in the same round
       (default `personal`) → `wrp sources create --path <toplevel> --name <name>
       --scope <work|personal> --email <a> [--email <b> ...]` (name = repo
       directory basename) → immediately `wrp sources sync <new id>`.
   - **Any other exit** → a real error; surface the stderr JSON envelope and stop.
3. Report the sync summary to the user.

## lookup — find an existing source by repo path

```bash
wrp sources lookup --path <repo root>
```

Exit 0 prints the source record verbatim as one line of compact JSON, including
`id`, `name`, `status`, `enabled`, `projectScope`, `config.authorEmails`,
`config.branches` and `config.branchCursors`. Exit codes: `0` found, `3` not
found (clean, the skill branches on this; the stderr JSON envelope still carries
`status: 404`), `1` other error.

## emails — list commit authors for a path

```bash
wrp sources emails --path <repo root>
```

Prints the API body verbatim as one line of compact JSON, in the server's order
(commit count desc, last 300 commits only):

```json
{"authors":[{"email":"a@example.com","name":"Alice","count":12}]}
```

Read `authors[]` (`name`, `email`, `count`) to drive the multi-select when
onboarding. `{"authors":[]}` is a valid empty answer, not a failure.

## create — register a new git-local source

```bash
wrp sources create --path <p> --name <n> --scope work|personal --email <a> [--email <b> ...]
```

Prints `✓ source created: #<id> <name> (git-local, <scope>) — status <status>` on
success. Errors:
`VALIDATION_ERROR` (name too long, bad scope, missing email) and
`DUPLICATE_ALIAS` both arrive in the single stderr JSON error envelope, as its
`code` and `message`.

## sync — trigger a sync

```bash
wrp sources sync <ref> [--enable]
```

`<ref>` is the numeric `id` from `lookup`'s JSON body (or the id in `create`'s
`✓` feedback line). If `--enable` is passed, the command PATCHes `enabled: true`
(and `status`) first, then POSTs to the universal sync endpoint. Prints
`✓ source synced: #<id> <name> — X commits scanned, Y new events` plus
per-branch lines.

## Errors

Every failure is one JSON envelope on stderr with a non-zero exit:
`{"error":{"status":…,"code":…,"message":…,"fix":…}}`. Branch on `status`/`code`
and follow `fix`.

| Envelope | Cause | Fix |
|---|---|---|
| `status: 401` | PAT missing, invalid, expired, or revoked | Provision credentials with `wrp init` (`fix` carries the exact `! node "…/wrp.mjs" init` command) |
| `status: 409`, `code: SOURCE_BUSY` | Another sync/fetch is running for this source | Retry in a few seconds |
| `status: 500`, `code: SYNC_FAILED`, `message` names auto-disable | Repo path gone or unreadable during sync | Check the path exists and is readable, fix it with `wrp sources update`, then re-enable |
| `status: 404`, `message` starts `no collect source for path` (exit 3) | No git-local source registered for that path | Normal onboarding path — not an error |
| `status: null`, `message` starts `Cannot reach weekly-reporter at` | Server not running | `npm run dev` or set `WEEKLY_REPORTER_BASE_URL` |

## Out of scope

- Managing emails or branches of an existing source — use the web UI (only
  touch it from `wrp sources update` when the user explicitly asks; this flow
  never does).
- Remote hosted sources (GitHub/GitLab/Gitee repos not cloned locally) — they
  are created and updated with `wrp sources create/update` from the
  weekly-reporter skill, not by this onboarding flow.
- Manual fetch (手动仓库 Fetch, ADR-0009) — different concept, same UI area.
- Eval harness, viewer, and install — handled separately.
