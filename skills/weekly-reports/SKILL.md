---
name: weekly-reports
description: >-
  Read and manage weekly report (周报) data in this repo via Node.js scripts — list and search reports, inspect a report's source draft and adopted final for either audience variant, preview what a date range would produce, create a report, rebuild its source drafts, save a final, or delete one. Use this skill whenever the user asks about weekly reports rather than individual timeline events: "show me last week's report", "写一份上周的周报", "what's in the leadership version", "创建第 38 周周报", "find the report that mentioned Nexus", "save this as the final", "重新生成原稿", "delete report 23", or any request to read or change 周报/report/原稿/终版/受众版本 data. For single work-log entries on the timeline, use the timeline-events skill instead.
---

Manage weekly report data through seven Node.js scripts under `{baseDir}/scripts/`. They use built-in `fetch` (Node 18+), take no dependencies, and read `WEEKLY_REPORTER_URL` from env (defaults to `http://localhost:6868`, the dev and systemd port for this app).

## The data model you're working with

Getting this wrong is the main way to produce a confidently useless answer, so it's worth 30 seconds:

A **report** covers a date range and holds an immutable **event snapshot** taken at creation time. Editing or deleting timeline events afterwards does not change an existing report — only `regenerate-source.mjs` re-reads events.

Each report has exactly two **audience variants**: `leadership` (work-scope events plus manual entries) and `personal` (everything). Each variant independently holds:

- **source draft** (`原稿`) — deterministic event inventory, no template and no AI. This is the factual input for everything downstream; treat it as the source of truth when the user asks "what actually happened".
- **final** (`终版`) — the AI-generated, human-edited report body that gets sent out. `finalStatus` is `none`, `current`, or `stale`. **`stale` means the source draft was regenerated after this final was adopted**, so the text no longer reflects its inputs — say so instead of quoting it as current.

A source draft reading `- No events this week` is an **empty source draft**. It saves fine but cannot produce a meaningful final; if the user expected content there, the real problem is usually a missing collect-source sync or the wrong date range, not the report.

## Reading

Start here for almost every request. `list.mjs` shows one report per line with each variant's final status, which usually tells you which report and variant to open next.

```bash
node {baseDir}/scripts/list.mjs [--page <n>] [--page-size <n>]
node {baseDir}/scripts/list.mjs --query <text> [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
```

`--query` searches titles, source drafts and finals; combined with `--start`/`--end` it filters by covered week. Any of the three switches to search mode (unpaginated, newest first).

```bash
node {baseDir}/scripts/show.mjs <id> [--variant <leadership|personal>] [--part <meta|source|final|both>]
```

`--part meta` (the default) prints metadata and per-variant sizes only — cheap, and enough to decide what to read. Ask for `source`, `final`, or `both` when you actually need the text; a source draft can run to 9,000 characters, so pass `--variant` to avoid pulling both.

## Previewing a range

Before creating a report, check what the range would capture:

```bash
node {baseDir}/scripts/preview.mjs --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--variant <leadership|personal>] [--full]
```

Prints the first 12 lines per variant with a line and character count; `--full` prints everything. This creates nothing, so it's the safe way to confirm the date range is right — worth doing whenever the user gives a vague range like "last week".

## Writing

These change stored data. Confirm the specifics with the user first — dates and title for a create, the content for a final.

```bash
node {baseDir}/scripts/create.mjs --title <text> --start <YYYY-MM-DD> --end <YYYY-MM-DD>
```

Creates the report, snapshots the events in range, and builds both source drafts. Output flags an empty draft explicitly. Note that nothing prevents two reports covering the same week, so check `list.mjs` first if the user might already have one.

```bash
node {baseDir}/scripts/regenerate-source.mjs <id>
```

Re-reads current events, bumps `sourceRevision`, and rebuilds both source drafts. Use it after events were added or corrected for a week that already has a report. Any adopted final becomes `stale` — that's the intended signal, not a failure, and the script tells you which variants it affected.

```bash
node {baseDir}/scripts/save-final.mjs <id> --variant <leadership|personal> \
  (--content <text> | --file <path>) [--source-revision <n>] \
  [--template-id <id>] [--ai-style-key <key>]
```

Prefer `--file` for anything longer than one line; shell quoting mangles multi-line markdown. Pass `--source-revision` with the value you read from `show.mjs` to get a 409 instead of silently overwriting a final that was rebuilt from a newer draft in the meantime. `--template-id` / `--ai-style-key` snapshot the template and AI style onto the variant, mirroring what proposal acceptance records — pass the ones the content was actually written with (the write-weekly-report skill relies on this). Omitted, they leave existing snapshots untouched.

```bash
node {baseDir}/scripts/delete.mjs <id> --confirm
```

Removes the report, both variants, the event snapshots, and the generation history. Nothing restores it. Without `--confirm` the script prints what would be lost and exits 1 — run it that way first and show the user before confirming. A report whose final came from an accepted AI proposal is refused with `AUDIT_RECORD_REQUIRED`, because the generation audit trail has to be kept; that's a real constraint, so don't try to work around it.

## Out of scope

These scripts cover `/api/reports/*` only. Multi-turn AI final generation (`generation-sessions`, proposals, plan overrides) is a streaming NDJSON interface driven from the app UI at `/edit/[id]` — do it there, not here. Timeline events belong to the timeline-events skill; templates (周报模板) belong to the report-templates skill. AI styles and collect sources have no script coverage yet, so use the app or hit the API directly.

## Errors

All scripts exit 0 on success and non-zero on failure, printing one actionable line to stderr.

| Message | Cause | What to do |
|---|---|---|
| `Cannot reach weekly-reporter` | Server not running, or wrong port | `npm run dev`, or set `WEEKLY_REPORTER_URL` |
| `Report not found [NOT_FOUND]` | Bad ID | Confirm with `list.mjs` |
| `SOURCE_REVISION_CONFLICT` (409) | Draft changed since you read it | Re-read with `show.mjs`, rebuild the final from the current draft |
| `AUDIT_RECORD_REQUIRED` (409) | Delete blocked by accepted-proposal audit trail | Keep the report; archive its sessions in the app if needed |
| `Validation failed [VALIDATION_ERROR]` | Bad dates, empty title, `weekStart` after `weekEnd` | Fix the input and retry |
