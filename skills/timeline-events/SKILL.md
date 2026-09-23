---
name: timeline-events
description: Query, create, update, and delete events on the weekly-reporter timeline. Use this skill whenever the user wants to log work, check what happened on a date, edit a past event, mark something important, remove a wrong entry, or interact with the timeline in any way — even if they don't say "timeline" or "event". Triggers on phrases like "log this", "what did I do on Tuesday", "change that event", "mark as important", "delete #123", "show this week's events", "add a tag to that event", "log this with a reference to #6999", or any reference to daily work history.
---

Manage timeline events via four Node.js scripts. All scripts use built-in `fetch` (Node 18+) and read `WEEKLY_REPORTER_URL` from env (defaults to `http://localhost:6868`).

Content passed to create/update must be single-line plain text. Replace newlines with spaces before passing.

## Tags and references in content

Two token types in event content carry meaning beyond plain text: tags (`#name`) and references (`@id`). Both are re-parsed by the API from the content on every create and update — the content is the source of truth, so the scripts never maintain tag or reference indexes separately. Both share the same whitespace-boundary rule: a token starts at the beginning of the content or after whitespace, and ends before whitespace or the end of the content.

### Tags — `#name`

`#` followed by Han characters, letters, or digits, with at least one letter (`#123` parses as no tag, which keeps numeric ids out of the tag namespace). The tag charset stops at punctuation — `#my-tag`, `#my_tag`, and `fixed it.#done` are plain text. Incidental `#word` tokens in drafted content become tags on write; quote them (`"#tag"`) or rephrase when the `#` is meant literally.

**Example:** `fixed login timeout and added regression tests #工作 #个人`

Tags parse anywhere the boundary holds; the house style is to append them at the end of the line. Renaming or removing a tag across every event at once belongs to the timeline-tags skill, not per-event edits here.

### References — `@id`

`@` followed by a pure numeric event id (`@6999`) links this event to that one; the timeline renders it as a clickable reference. Ids come from query output (each line starts with `#<id>`) or from the create confirmation `✓ Event created: #<ID>`.

- These scripts create manual events, and references parse in manual content — so `@id` tokens written here are always live. Any event can be referenced, manual or auto-collected; in auto-collected content `@` stays plain text.
- `@` followed by anything but digits (emails, handles) is plain text.
- A reference to a nonexistent id writes fine and renders as a dangling link, which the app leaves in place — check the id against query output first.
- When rewriting an event's content on update, carry `@id` tokens over verbatim; the id is the data.

Tags and references are orthogonal — `code review for @6999 #工作` parses both. Boundary failures are silent: in `see @6999, then ship` the trailing comma disables the reference, and in `(#@7008)` neither token parses.

## Query

List events with optional filters. Output is one event per line with id, time, source, importance marker (★), content, and tags.

```bash
node {baseDir}/scripts/query.mjs [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD>] [--week-end <YYYY-MM-DD>] [--tags <tag1,tag2>] [--source <manual|auto>] [--limit <n>]
```

- `--date` — single day (e.g. `2026-09-15`)
- `--week-start` + `--week-end` — date range
- `--tags` — comma-separated tag filter (overrides date/week filters)
- `--source` — `manual` or `auto`
- `--limit` — max results (default 50, max 200)

No flags = latest 50 events. The last line shows count and pagination cursor if `hasMore` is true.

## Create

Add a new work entry. Preview the content to the user and get approval before running.

```bash
node {baseDir}/scripts/post.mjs "<content>" [--time <ISO8601-timestamp>]
```

- `--time` — optional; defaults to now. Use when the user specifies when the work happened.
- On success: `✓ Event created: #<ID>`

## Update

Modify an existing event. At least one flag is required.

```bash
node {baseDir}/scripts/update.mjs <id> [--content <text>] [--time <ISO8601>] [--important <true|false>]
```

- `--content` — replace event text
- `--time` — change event timestamp
- `--important` — toggle the ★ importance flag
- On success: `✓ Event #<id> updated`

## Delete

Remove a manually-created event. Auto-collected events cannot be deleted.

```bash
node {baseDir}/scripts/delete.mjs <id>
```

- Confirm with the user before deleting. An event referenced by others (`@<id>` appears in their content) deletes cleanly and leaves those links dangling — surface that during confirmation when you know it's referenced.
- On success: `✓ Event #<id> deleted`
- On 403: event is auto-collected and cannot be deleted.

## Error handling

All scripts exit 0 on success, non-zero on failure. Common errors:

| Message | Cause | Fix |
|---|---|---|
| `Cannot reach weekly-reporter` | Server not running | Start with `npm run dev` |
| `Invalid request (HTTP 4xx)` | Bad input | Check the error detail and retry |
| `Server error (HTTP 5xx)` | Backend issue | Check server logs |
