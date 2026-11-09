# Events (时间线事件)

The timeline is the work log the weekly reports are built from: one event per
unit of work, with an id, a time, a source (`manual` or a collect-source name),
single-line content, and an importance flag. `wrp events list|create|update|delete`
manages manual events; auto-collected events come from git history.

## Content is the source of truth

Every write re-parses the content server-side: tags, event references and
plan-item references exist only as tokens inside the text, never as a separate
index the client maintains. Rewriting an event's content therefore rewrites its
links too — passing `--content` replaces the whole line, so carry every token
you mean to keep over verbatim.

Content must be **single-line plain text**. Replace newlines with spaces before
passing it (the client shows a stray newline as `↵` in list output rather than
splitting the line, but the app expects one line).

## Tags — `#name`

`#` followed by Han characters, letters, or digits, with at least one letter.
`#123` parses as no tag, which keeps numeric ids out of the tag namespace. The
tag charset stops at punctuation: `#my-tag`, `#my_tag`, and `fixed it.#done` are
plain text.

The token must start at the beginning of the content or after whitespace, and
end before whitespace or the end of the content. Incidental `#word` tokens in
drafted content become tags on write — quote them (`"#tag"`) or rephrase when
the `#` is meant literally. House style is to append tags at the end of the
line.

```
wrp events create "fixed login timeout and added regression tests #工作 #个人"
```

Renaming or removing a tag across every event belongs to `wrp tags
rename|remove`, not to per-event edits.

## Event references — `@id`

`@` followed by a pure numeric event id (`@6999`) links this event to that one;
the timeline renders it as a clickable reference. Ids come from the `#<id>` token
that starts every `wrp events list` line, or from the `✓ event created: #<id>`
feedback line.

- Manual events are written by `wrp events create`, and references parse in
  manual content — so `@id` tokens written through wrp are always live. Any
  event can be referenced, manual or auto-collected; inside auto-collected
  content `@` stays plain text.
- `@` followed by anything but digits (emails, handles) is plain text.
- A reference to a nonexistent id writes fine and renders as a dangling link,
  which the app leaves in place. Check the id against list output first.
- When rewriting an event's content on update, carry `@id` tokens over
  verbatim; the id is the data.

## Plan-item references — `%id`

`%` followed by a pure numeric plan-item id (`%42`) marks this event as
fulfilling that item; the plans page and the timeline plan panel render the
reference as a clickable token. Ids come from `wrp plans list` (each item is
shown as `%<id>`) and `wrp plans add|defer` output.

- Manual content parses `%id` too, so tokens written through wrp are always
  live; inside auto-collected content `%` stays plain text. Any plan item, from
  any period (past week, future week, monthly parent, deferred original), can
  be referenced.
- The boundary rule is identical to tags and event references: the character
  before `%` must be whitespace or the start of content, and the character after
  the digits must be whitespace or the end of content. `50%42` (no whitespace
  before `%`) parses as no reference.
- A reference to a nonexistent item id writes fine and renders as a dangling
  link. Check the id against `wrp plans list` first. Writing a reference never
  changes the item's status — the reference is evidence, not a state transition.
- When rewriting an event's content on update, carry `%id` tokens over
  verbatim; the id is the data.

## Boundary failures are silent

Tags, event references and plan-item references are orthogonal — `finished %42
review for @6999 #工作` parses all three. But a token that fails the boundary
rule is silently plain text, with no error on write:

- `see @6999, then ship` — the trailing comma disables the reference.
- `(#@7008)` — neither token parses (the opening paren disables both).
- `fixed it.#done` — the tag is plain text.
- `see %42, then ship` — the trailing comma disables the plan-item reference.
- `(%42)` — the opening paren disables it too.

Because the failure is silent, verify token boundaries before writing when a
link or tag matters.

## The four verbs

### `wrp events list`

```bash
wrp events list [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD>] [--week-end <YYYY-MM-DD>] \
  [--tags <tag1,tag2>] [--source <manual|auto>] [--limit <n>] [--cursor <id>@<millis>]
```

- `--date` — single local day.
- `--week-start` + `--week-end` — inclusive date range.
- `--tags` — comma-separated tag filter; when present it overrides the
  date/week filters (full-timeline semantics).
- `--source` — `manual`, or `auto` (any collect source).
- `--limit` — page size (server default 50, max 200).
- `--cursor` — continue a page: pass the token printed in the `next page:` hint
  of the previous page.

No flags lists the latest 50 events. Output is one id-first line per event:

```
#6991 [2026-11-09 14:02] [manual] ★ fixed login timeout #工作 #个人
— 1 event(s)
next page: --cursor 6991@1794232920000
```

The id token comes first so it can be fed straight into `update`/`delete`, or
quoted as `@id` in another event. The footer counts the page and, when more
events exist, prints the cursor hint.

When nothing matches, the command prints an explicit empty-state line (widen the
`--date`/week/tag filters) and exits `0`.

An event referenced by others (`@<id>` appears in their content) deletes cleanly
and leaves those links dangling — surface that during delete confirmation when
you know it is referenced.

### `wrp events create`

```bash
wrp events create "<content>" [--time <ISO8601>]
```

Preview the content to the user and get approval before running. `--time`
defaults to now; pass it when the user specifies when the work happened. On
success: `✓ event created: #<id>`.

### `wrp events update`

```bash
wrp events update <id> [--content <text>] [--time <ISO8601>] [--important <true|false>]
```

At least one flag is required. `--content` replaces the event text (carry
`#tag`/`@id`/`%id` tokens over verbatim), `--time` changes the timestamp,
`--important` sets or clears the ★ flag (`false` is a real update, not "leave
unchanged"). On success: `✓ event updated: #<id>`. A missing id surfaces as
`✗ event not found (HTTP 404)` with a pointer to `wrp events list`.

Ids are **strict digits**: pass the numeric id exactly as printed after `#`
(the retired script's `parseInt` tolerated prefixes such as `12abc`; wrp does
not, so `✗ invalid event id: …` is a typo, not an id to truncate). An empty
`--time ''` is refused client-side as a missing value, like an empty
`--content` — checked before any request is sent.

### `wrp events delete`

```bash
wrp events delete <id>
```

Only manual events can be deleted. Auto-collected events mirror git history and
the API refuses the delete with `403`; the client surfaces it as
`✗ delete refused (HTTP 403): Cannot delete non-manual event → auto-collected
events mirror git history — fix the commit or the collect source instead`.
Confirm with the user before deleting anything, and never delete a real event
during a smoke test — use a clearly labeled throwaway one.

## Errors

Every failure is one `✗ <cause>: <message> → <fix>` stderr line with a non-zero
exit. The fixes point at the actual next step:

| Symptom | Fix |
| --- | --- |
| `✗ unauthorized (HTTP 401)` | provision credentials: `! node "{baseDir}/scripts/wrp.mjs" init` |
| `✗ Cannot reach weekly-reporter` | start the server (`npm run dev`) or set `WEEKLY_REPORTER_BASE_URL` |
| `✗ event not found (HTTP 404)` | check the id against `wrp events list` |
| `✗ delete refused (HTTP 403)` | the event is auto-collected; fix the commit or the collect source |
| `✗ invalid --important: …` | pass `--important true` or `--important false` |
| `✗ invalid cursor: …` | pass the token from the `next page:` hint, or drop `--cursor` |
| `✗ invalid event id: …` | pass the numeric id printed after `#` |
