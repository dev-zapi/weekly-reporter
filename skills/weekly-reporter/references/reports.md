# reports — weekly reports (周报/原稿/终版)

Read this before running any `wrp reports …` verb. The commands assume the data
model below, and getting it wrong is the main way to produce a confidently
useless answer.

## The data model

A **report** covers a date range (`weekStart ~ weekEnd`) and holds an
**immutable event snapshot** taken at creation time. Editing or deleting timeline
events afterwards does **not** change an existing report — only
`wrp reports regenerate-source` re-reads events. Treat the snapshot as what the
report actually knows about that week.

Each report has exactly two **audience variants**:

- `leadership` — work-scope events plus manual entries.
- `personal` — everything.

Each variant independently holds:

- **source draft** (`原稿`) — a deterministic event inventory; no template, no
  AI. It is the factual input for everything downstream. When the user asks
  "what actually happened", read the source draft; treat it as the source of
  truth.
- **final** (`终版`) — the AI-generated, human-edited body that gets sent out.
  `finalStatus` is `none`, `current`, or `stale`.

A source draft reading `- No events this week` (or the legacy `- 本周暂无事件`)
is an **empty source draft**. It saves fine but cannot produce a meaningful
final. If the user expected content, the real problem is usually a missing
collect-source sync or the wrong date range — not the report.

**Stale semantics.** `stale` means the source draft was regenerated *after* this
final was adopted, so the final no longer reflects the inputs it was built from.
Report it as such; never quote a stale final as current. `none` means no final
has been adopted yet; `current` means the final matches its source revision.

## Reading

```bash
wrp reports list [--page <n>] [--page-size <n>]
wrp reports list [--query <text>] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
```

One line per report: `#id` first, then bracketed metadata (the covered week and
each variant's final status), then the title. The per-variant status usually
tells you which report and variant to open next.

Any of `--query`/`--start`/`--end` switches to **search mode**: unpaginated,
newest first. `--query` matches titles, source drafts and finals; `--start`/
`--end` filter by covered week. Page mode prints `page N/M of T reports, newest
first` and a `next: --page N+1` hint while more pages exist.

```bash
wrp reports show <id> [--variant leadership|personal] [--part meta|draft|final|both]
```

`--part meta` (the default) prints metadata and per-variant sizes only — cheap,
and enough to decide what to read. Ask for `draft`, `final`, or `both` only when
you actually need the text: a source draft can run to thousands of characters,
so pass `--variant` to avoid pulling both. `source` is accepted anywhere `draft`
is (an alias for the same part), including on the command line. Multi-line
drafts and finals are only ever printed by `show` under one of these explicit
modes; never reconstruct them from a list line.

## Previewing a range

```bash
wrp reports preview --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--variant …] [--full]
```

Prints the first 12 non-empty lines per variant with line and character counts;
`--full` prints everything. **This creates nothing**, so it is the safe way to
confirm a date range — worth doing whenever the user gives a vague range like
"last week". An empty draft is marked `(EMPTY)` here so the mistake surfaces
before anything is written.

## Writing

These verbs change stored data. Confirm the specifics with the user first —
dates and title for a create, the content for a final.

```bash
wrp reports create --title <text> --start <YYYY-MM-DD> --end <YYYY-MM-DD>
```

Creates the report, snapshots the events in range, and builds both source
drafts. Output flags an empty draft explicitly (it can be saved but no final can
be generated from it). Nothing prevents two reports covering the same week, so
create also nudges when a report already covers the range — a warning, not a
block; check `list` first if the user might already have one, and delete the
accidental duplicate if so. The check is containment: an existing report whose
range fits inside the new range (an exact duplicate included) is caught; partial
overlaps, and a larger report that contains the new range, are not.

```bash
wrp reports regenerate-source <id>
```

Re-reads current events, bumps `sourceRevision`, and rebuilds both source
drafts. Use it after events were added or corrected for a week that already has
a report. Any adopted final becomes `stale` — that is the intended signal, not a
failure. The output names the variants it marked stale so you can tell the user
which finals must be rewritten before the report goes out.

```bash
wrp reports save-final <id> --variant leadership|personal \
  (--content <text> | --file <path>) [--source-revision <n>] \
  [--template-id <id>] [--ai-style-key <key>]
```

Prefer `--file` for anything longer than one line; shell quoting mangles
multi-line markdown. Pass `--source-revision` with the value you read from
`show` to get a **409 `SOURCE_REVISION_CONFLICT`** instead of silently
overwriting a final that was rebuilt from a newer draft in the meantime — on
that 409, re-read the current revision and rebuild the final from the current
draft, never retry blindly. `--template-id` / `--ai-style-key` snapshot the
template and AI style onto the variant, mirroring what proposal acceptance
records; pass the ones the content was actually written with. Omitted, they
leave the variant's existing snapshots untouched.

```bash
wrp reports delete <id> --confirm
```

Removes the report, both variants, the event snapshots, and the generation
history. Nothing restores it. Without `--confirm` the command prints a `PLAN:`
naming everything lost and exits `1` — run it that way first and show the user
before confirming.

A report whose final came from an **accepted AI proposal** is refused with
`409 AUDIT_RECORD_REQUIRED`, because the generation audit trail has to be kept.
That is a real constraint, not a bug: surface it to the user and keep the report.
Never work around it (there is no flag that does).

## Errors

| Line | Cause | What to do |
|---|---|---|
| `✗ unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | hand the user the `wrp init` command the line prints |
| `✗ Cannot reach weekly-reporter …` | Server not running, or wrong port | start the server, or set `WEEKLY_REPORTER_BASE_URL` |
| `✗ NOT_FOUND: Report not found` | Bad id | confirm it with `wrp reports list` |
| `✗ SOURCE_REVISION_CONFLICT: …` (409) | Draft changed since you read it | re-read `show`, rebuild the final from the current draft |
| `✗ AUDIT_RECORD_REQUIRED: …` (409) | Delete blocked by an accepted-proposal audit trail | keep the report; archive its sessions in the app if needed |
| `✗ VALIDATION_ERROR: …` | Bad dates, empty title, `weekStart` after `weekEnd` | fix the input and retry |

## Out of scope

These verbs cover `/api/reports/*` only. Multi-turn AI final generation
(generation sessions, proposals) is a streaming NDJSON interface driven from the
app UI at `/edit/[id]` — do it there. Timeline events belong to
`references/events.md`; templates (周报模板) and AI styles belong to
`references/templates.md`.
