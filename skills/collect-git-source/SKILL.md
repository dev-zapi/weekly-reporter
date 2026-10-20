---
name: collect-git-source
description: >-
  Trigger collection (同步) of the current directory's local Git repo as a
  weekly-reporter collect source, including one-shot first-time onboarding.
  Use when the user says things like "收集一下这个仓库", "触发采集",
  "把这个仓库接入周报系统", "同步这个 repo 的提交", or wants the cwd's
  repo registered and synced as a git-local source. NOT for single timeline
  events (use timeline-events) or for remote hosted sources (GitHub/GitLab
  repos not on this machine — out of scope).
---

Collect (同步) the local Git repo at the current working directory into the
weekly-reporter timeline. Four Node.js scripts under `{baseDir}/scripts/` —
they use built-in `fetch` (Node 18+), take no dependencies, and read
credentials from the env (`WEEKLY_REPORTER_PAT` for the token;
`WEEKLY_REPORTER_BASE_URL`, or its alias `WEEKLY_REPORTER_URL`, for the base
URL) or from the machine credential at `~/.config/weekly-reporter/auth.json`;
the base URL defaults to `http://localhost:6868`. Without a PAT every `/api/**`
call returns 401 — run the **configure-pat** skill to set one up.

The repo is located solely by its normalized absolute path (`config.owner`);
`name` is display-only. Branch config is empty on create, which means
all-branches collection (ADR-0017).

## Flow

Run these steps in order. **Do not auto-create or auto-enable** — both need
explicit user confirmation first.

1. `git rev-parse --show-toplevel` in cwd (subdirectories auto-resolve to the
   repo root). Not a repo → clear error, stop.
2. `lookup.mjs --path <toplevel>`:
   - **Found** (exit 0): check `status`.
     - `enabled` → `sync.mjs --id <id>`.
     - `disabled` → ask user "启用并同步？" → `sync.mjs --id <id> --enable`.
     - `unavailable` → report likely cause (no emails / local path gone),
       stop, point to web UI. Never manage emails/branches of an existing
       source here.
   - **Not found** (exit 3): single confirmation — "要把这个仓库接入并立即
     同步吗？"
     - No → stop.
     - Yes → `emails.mjs --path <toplevel>` → present `name + email + commits`
       multi-select (≥1 required) and pick `projectScope` in the same round
       (default `personal`) → `create.mjs` (name = repo directory basename)
       → immediately `sync.mjs --id <new id>`.
3. Report the sync summary to the user.

## lookup — find an existing source by repo path

```bash
node {baseDir}/scripts/lookup.mjs --path <repo root>
```

Prints `id`, `name`, `status`, `enabled`, `scope`, `emails`, `branches`. Exit
codes: `0` found, `3` not found (clean, the skill branches on this), `1`
other error.

## emails — list commit authors for a path

```bash
node {baseDir}/scripts/emails.mjs --path <repo root>
```

Prints `commits  email  name` per line, in the server's order (count desc,
last 300 commits only). Use the output to drive the multi-select when
onboarding.

## create — register a new git-local source

```bash
node {baseDir}/scripts/create.mjs --path <p> --name <n> --scope work|personal --email <a> [--email <b> ...]
```

Prints `✓ Source created: #<id> <name>` on success. Errors: `VALIDATION_ERROR`
(name too long, bad scope, missing email) and `DUPLICATE_ALIAS` both surface
via `failResponse`.

## sync — trigger a sync

```bash
node {baseDir}/scripts/sync.mjs --id <n> [--enable]
```

If `--enable` is passed, PATCHes `enabled: true` first, then POSTs to the
universal sync endpoint. Prints `✓ Synced <name> (#<id>): X commits scanned,
Y new events` plus per-branch lines.

## Errors

| Message | Cause | Fix |
|---|---|---|
| `Unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | Run the **configure-pat** skill (`node scripts/configure-pat.mjs`) |
| `source is busy [SOURCE_BUSY]` | Another sync/fetch is running for this source | Retry in a few seconds |
| `sync failed and the source was auto-disabled` | Repo path gone or unreadable during sync | Check path exists and is readable |
| `Source not found for path '...'` (exit 3) | No git-local source registered for that path | Normal onboarding path — not an error |
| `Cannot reach weekly-reporter` | Server not running | `npm run dev` or set `WEEKLY_REPORTER_URL` |

## Out of scope

- Managing emails or branches of an existing source — use the web UI.
- Remote hosted sources (GitHub/GitLab repos not cloned locally).
- Manual fetch (手动仓库 Fetch, ADR-0009) — different concept, same UI area.
- Eval harness, viewer, and install — handled separately.
