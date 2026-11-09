---
name: weekly-reporter
description: >-
  Unified Node.js client (wrp) for the weekly-reporter app: manage collect sources (采集源),
  timeline events (时间线事件) and tags (标签), period plans (周计划/计划条目/评论), report templates
  (周报模板) and weekly reports (周报/原稿/终版), plus interactive init (PAT 配置). Use for any read
  or change of these entities — 列表/查询/创建/修改/删除/顺延/启用禁用/同步 — even when the user
  doesn't name them.
---

# weekly-reporter (wrp)

One client, one entry point: `wrp <module> <verb> [args]`, run as
`node {baseDir}/scripts/wrp.mjs …`. Zero npm dependencies, no build step, Node 18+.
Every command is self-documenting — `wrp --help` enumerates the whole surface,
`wrp <module> --help` the verbs of one module, `wrp <module> <verb> --help` the flags.

## Auth and environment

Credentials are resolved in this order, first hit wins:

1. `WEEKLY_REPORTER_PAT` (token) and `WEEKLY_REPORTER_BASE_URL` (alias: `WEEKLY_REPORTER_URL`) — base URL only.
2. Machine credentials in `~/.config/weekly-reporter/auth.json`, `machine.pat` and `machine.baseUrl`.
3. Base URL falls back to `http://localhost:6868`, the dev and systemd port of this app.

A missing credential never crashes the client — it just means the API answers `401`.

**On any `401`**, tell the user to provision credentials and hand them this exact
command to run in-session (the `!` prefix runs it without leaving the session):

```
! node {baseDir}/scripts/wrp.mjs init
```

`wrp init` also takes `--pat <token> [--base-url <url>]` (store a PAT created in the
web UI), `--show` (verify, token masked) and `--clear` (decommission the machine).

## Common contract

Every command obeys one output contract; agents parse it, so treat it as an interface.

- **Exit codes**: `0` success; `1` failure or an unconfirmed preview; `3` `sources lookup`
  found no source — a clean "not onboarded" signal, branch on it without parsing text.
- **Feedback** (stdout): `✓ <entity> <past-tense>: <identity>`, e.g. `✓ event created: #6991`.
- **Lists** (stdout): `<id-token> [<metadata>] <body>` per item, then a `— N <entity>(s)`
  footer, plus a cursor hint when more pages exist.
- **Errors** (stderr, non-zero exit): one line, `✗ <cause|API code>: <message> → <fix>`.
  Read the fix hint and retry; do not re-read this document instead.
- **Previews** (stdout): `PLAN:` header, affected counts and warnings, then
  `NOT EXECUTED — re-run with --confirm`. Destructive verbs (tag rename/remove, source,
  template and report delete) **print the plan and exit `1` without `--confirm`** — show
  the plan to the user, get approval, then re-run the same command with `--confirm`.
- **Payloads**: multi-line content (template bodies, report drafts and finals) is only
  printed by `show`, under an explicit `--part`/`--variant` mode. Never reconstruct it
  from a list line.

## Modules

Each task type has exactly one module reference doc. Pick the row for the entity you
are about to touch and read that doc before running the verb — the docs carry the
domain rules (token parsing boundaries, snapshot immutability, confirmation gates)
that the commands assume.

| Task | Reference | Scope |
| ---- | --------- | ----- |
| Timeline work log: list/create/update/delete events | `references/events.md` | event content, `#tag`/`@id`/`%id` parsing boundaries, auto-collected delete refusal |
| Tags (标签) | [references/tags.md](references/tags.md) | `#name` tokens inside manual event content: inventory, global rename (merges), global remove. |
| Period plans (周计划/月度计划), plan items (计划条目), defer/顺延, item comments (计划项评论) | [references/plans.md](references/plans.md) | list/add/update/defer/delete items; chain-aggregated comments |
