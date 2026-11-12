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

Every read verb prints the API response body **verbatim** as one line of compact
JSON on stdout. Parse it once: there is no wrapper object, and no field is
renamed or dropped.

```bash
wrp reports list [--page <n>] [--page-size <n>]
wrp reports list [--query <text>] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
```

Page mode prints the body as returned, for example:

```json
{"reports":[{"id":12,"title":"…","weekStart":"2026-02-09","weekEnd":"2026-02-15","variants":[…]}],"total":12,"page":1,"pageSize":10}
```

Paging state lives in the body: `page`, `pageSize` and `total`. Continue while
`page * pageSize < total`; there are no `page x/y` or `next: --page N` hint
lines. Each report carries its full `variants` array, so the per-variant
`finalStatus` is available without a second call.

Any of `--query`/`--start`/`--end` switches to **search mode**: unpaginated,
newest first, returning `{"reports":[…]}`. `--query` matches titles, source
drafts and finals; `--start`/`--end` filter by covered week. An empty result is
`{"reports":[]}` and still exits `0` — zero results is a successful read, not a
failure.

```bash
wrp reports show <id> [--variant leadership|personal] [--part meta|draft|final|both]
```

`show` prints the whole report body by default, including the `variants` array,
each variant's `sourceDraft` and `finalContent`, and `snapshots`. One call
yields the draft and final together.

`--variant` narrows the `variants` array to one audience variant. `--part`
projects out the payload fields you do not need:

| `--part` | Variant fields kept | Use when |
|---|---|---|
| `both` (default) | everything | you want the whole body |
| `meta` | all except `sourceDraft` and `finalContent` | you only need ids, statuses, `sourceRevision`, template/style provenance |
| `draft` / `source` | all except `finalContent` | you need the source draft text |
| `final` | all except `sourceDraft` | you need the adopted final text |

The selected projection prints verbatim, so drafts and finals stay reachable at
`variants[].sourceDraft` / `variants[].finalContent` in every mode. `--part meta`
is the cheap read that still carries `sourceRevision` for a later `save-final`
conflict check. Report instants are the API's own ISO strings; the client never
reformats them.

Ids are **strict digits**: pass the numeric id exactly as it appears in the
body's `id` field. A leading `#` is tolerated for convenience. The retired
script's `parseInt` tolerated suffixes such as `12abc`; wrp does not, so
`a numeric report id is required` means fix the id, do not truncate it.

## Previewing a range

```bash
wrp reports preview --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--variant …]
```

Prints the API preview body verbatim as one line of compact JSON:

```json
{"variants":[{"variant":"leadership","sourceDraft":"- …"},{"variant":"personal","sourceDraft":"- …"}]}
```

Every draft is **complete**: the old 12-line head truncation and its `--full`
escape hatch are gone. `--variant` narrows the variants array. **This creates
nothing**, so it is the safe way to confirm a date range — worth doing whenever
the user gives a vague range like "last week". An empty source draft (the
`- No events this week` or legacy `- 本周暂无事件` literal) shows up as such in
`sourceDraft`, so the mistake surfaces before anything is written.

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

A failure prints one compact JSON envelope on stderr and exits non-zero; stdout
stays empty. Branch on `status` and `code`, never on prose:

```json
{"error":{"status":404,"code":"NOT_FOUND","message":"Report not found","fix":"find the id with wrp reports list"}}
```

`status` is the HTTP status, or `null` for a client-side fault (bad flags, bad
ids, an unreachable server). `code` appears only when the API or the client
supplies one. `fix` names the actionable next step. Exit codes stay `0`/`1`/`3`.

| `status` / `code` | Cause | What to do |
|---|---|---|
| `401` | PAT missing, invalid, expired, or revoked | run the `wrp init` command the envelope's `fix` names |
| `null` / message starts `cannot reach` | Server not running, or wrong port | start the server, or set `WEEKLY_REPORTER_BASE_URL` |
| `404` `NOT_FOUND` | Bad id | confirm it with `wrp reports list` |
| `409` `SOURCE_REVISION_CONFLICT` | Draft changed since you read it | re-read `show`, rebuild the final from the current draft |
| `409` `AUDIT_RECORD_REQUIRED` | Delete blocked by an accepted-proposal audit trail | keep the report; archive its sessions in the app if needed |
| `400` `VALIDATION_ERROR` | Bad dates, empty title, `weekStart` after `weekEnd` | fix the input and retry |

## Out of scope

These verbs cover `/api/reports/*` only. Multi-turn AI final generation
(generation sessions, proposals) is a streaming NDJSON interface driven from the
app UI at `/edit/[id]` — do it there. Timeline events belong to
`references/events.md`; templates (周报模板) and AI styles belong to
`references/templates.md`.
