# Plans (周计划 / 月度计划 / 计划条目 / 计划项评论)

Period plans are independent entities: they exist before, during and after any
weekly report, and are never attached to one. A plan covers one natural week
(Monday start) or one calendar month; plan items carry the work, and plan-side
comments carry context *about* that work.

This module does **not** cover the "下周计划" section inside a weekly report
(plain report prose) or timeline events (the `events` module). Express work that
was actually done as a timeline event with a `%id` reference — never as a plan
comment.

## Concepts

An **item** (`%<id>`) has:

- **Text** — plain text, no `@id` / `%id` / `#tag` parsing.
- **Status** — `planned` | `in_progress` | `done` | `cancelled` | `deferred`.
- **Project scope** — `work` (default) | `personal`.
- **优先级 (Priority)** — `high` | `normal` (default) | `low`. This is the
  item's execution weight and the **only grouping/sorting dimension**: `list`
  prints high → normal → low, preserving manual position inside each group. The
  API performs that ordering; change it only through `--priority`, never through
  `--position`.
- **重要标记 (Important Flag)** — `true` | `false` (default `false`), the
  "important" axis of the four-quadrant judgement. A semantic annotation only:
  it does **not** affect grouping or sorting.
- **紧急标记 (Urgent Flag)** — `true` | `false` (default `false`), the "urgent"
  axis. Also annotation-only.

The two markers are orthogonal to priority and to each other — any combination
is valid, including `low` + important + urgent — and both are inherited when an
item is deferred. They are a **different entity** from the timeline event
importance toggle (`events update --important` in the `events` module): the
names sound alike, but they are different records with independent values.
Never assume marking one marks the other.

An item may have a **parent** (a week item pointing at a month item) and a
**deferral link** (`deferredFromItemId`, pointing at the item this one was
deferred from). Position is the manual order inside a priority group.

## list

```bash
wrp plans list --scope week --date <YYYY-MM-DD>
wrp plans list --scope week --week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>
wrp plans list --scope month --month <YYYY-MM>
wrp plans list --scope month --date <YYYY-MM-DD>
```

- `--scope` is required: `week` or `month`.
- Week scope takes either `--date` (any day inside the week) or **both**
  `--week-start` and `--week-end`; the API canonicalizes the pair to the Monday
  week, so a within-week start and any date of that week address the same plan.
- Month scope takes either `--month YYYY-MM` or `--date`.

Output:

```json
{"plan":{"id":3,"scope":"week","periodStart":"2026-10-12","periodEnd":"2026-10-18","monthKey":null},"items":[{"id":5,"periodPlanId":3,"text":"Ship the feature","status":"planned","priority":"high","isImportant":true,"isUrgent":false,"projectScope":"work","parentItemId":null,"deferredFromItemId":null,"position":1,"createdAt":"2026-10-12T00:00:00.000Z","updatedAt":"2026-10-12T00:00:00.000Z"},{"id":6,"periodPlanId":3,"text":"Review design","status":"planned","priority":"normal","isImportant":false,"isUrgent":false,"projectScope":"work","parentItemId":9,"deferredFromItemId":null,"position":2,"createdAt":"2026-10-12T00:00:00.000Z","updatedAt":"2026-10-12T00:00:00.000Z"}]}
```

The API response body is printed verbatim as one line of compact JSON — every
field, with no curation. The API's ordering survives (priority group, then manual
position), and every marker is present including `false`; parent and deferral
links are just fields (`parentItemId`, `deferredFromItemId`). A period with no
plan prints `{"plan":null,"items":[]}` and a plan with no items has `"items":[]`
— both are empty answers with exit 0, not errors.

## add

```bash
wrp plans add --scope week --week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD> --text <text> [flags]
wrp plans add --scope month --month <YYYY-MM> --text <text> [flags]
```

The plan is **auto-created** when the period has none; there is no separate
"create plan" verb. Flags: `--project`, `--parent`, `--priority`, `--important`
and `--urgent` as described above. Priority and both markers are validated
**client-side before the request**: anything other than `high|normal|low` or a
literal `true`/`false` is rejected without touching the API.

**Parent containment**: a parent link must be a *week item → month item*
relationship, and the parent month must contain the week's start date. The API
enforces existence, month scope and containment; a violation comes back as
HTTP 400 and the client prints the API detail (so "the parent's month does not
contain the week start" is visible, not a generic failure). Month items cannot
have parents.

Success: `✓ plan item created: %<itemId> (plan <planId>)`.

## update

```bash
wrp plans update <id> [--text] [--status] [--project] [--position] [--parent] [--priority] [--important] [--urgent]
```

At least one flag is required; omitted fields keep their current values.

- `--text` is trimmed; an empty result is refused.
- `--parent <id>` sets the link; `--parent ""` **clears** it (sends `null`).
  The same containment rules as `add` apply.
- `--important false` / `--urgent false` are **real updates** — this is how a
  marker is cleared. The flags take explicit `true`/`false` values precisely so
  that `false` can reach the API.
- `--position` only reorders inside the item's current priority group; use
  `--priority` to move between groups.

Success: `✓ plan item updated: %<id>`.

Ids are **strict digits**: pass the numeric id exactly as printed after `%`
(plan items) or `#` (comments) — either prefix is tolerated. The retired
script's `parseInt` tolerated suffixes such as `12abc`; wrp does not, so an
`invalid item id` in the JSON error envelope means a typo, not an id to truncate.

## defer (顺延)

```bash
wrp plans defer <id>
```

Explicitly moves an incomplete item to the **next period of the same scope**
(next week / next month); the target period is not configurable. Deferral
creates a successor with `status=planned`, the same text, priority and markers,
and a `deferredFromItemId` link back to the original; the original is marked
`deferred`. A parent link is inherited only while it still satisfies month
containment for the new week (otherwise it is dropped silently, so the deferral
itself still succeeds).

Only `planned` or `in_progress` items can be deferred; `done`, `cancelled` and
`deferred` items are refused by the API with HTTP 400, carried in the JSON error
envelope. Confirm with the user first: a deferral changes two items.

Success: `✓ plan item deferred: %<newId> (from %<originalId>)`.

**Deferral chains** are the backbone of plan-side history: each successor knows
its original, and reads that aggregate (comments, fulfillment counts) walk the
whole chain. This is why `defer` is preferable to delete-and-recreate.

## delete

```bash
wrp plans delete <id>
```

A hard delete — the item is gone permanently. Deleting a parent **unparents** its
children (they are kept, not deleted); `deferredFromItemId` links pointing at the
deleted item remain as stale historical references. Mention both facts when
confirming. There is no `--confirm` gate here (matching the pre-wrp behavior);
ask the user before running it.

Success: `✓ plan item deleted: %<id>`. A missing item is a 404 in the JSON
error envelope.

Server drift note: the retired TypeScript route answered `204 No Content`; the
Go server answers `200 {deleted:true}`. The client accepts both, so the success
line is identical either way.

## Comments (计划项评论)

Comments are append-only plan-side context: blockers, scope adjustments,
decisions. **Comments are not work facts.** They never enter the timeline, event
snapshots, report source drafts, or AI generation. Work that happened is a
manual event with a `%id` reference, not a comment.

Token boundaries inside comment content:

- `@<eventId>` is the **only live token**: it renders as a citation to that
  timeline event (and arms that event's deletion warning).
- `%<itemId>` and `#tag` are plain text in comments — they never create
  fulfillment associations or timeline tags. Say so when a user expects them to
  link.

Comments are deletable but never editable; append a correction instead.
**Authorship is attribution, not a security boundary**: browser comments render
as `user`; PAT comments are stamped with the caller's self-reported agent
identity (`X-Weekly-Reporter-Agent`, i.e. `weekly-reporter/<runtime>`), falling
back to the token name, then `pat`.

### comments list

```bash
wrp plans comments list <item-id>
```

List the item's own comments **plus its deferral-chain ancestors' comments**,
oldest-first (the API aggregates them; `createdAt`, then id). The response body is
printed verbatim as one line of compact JSON:

```json
{"commentCount":2,"comments":[{"id":7,"planItemId":9,"content":"Original blocker","author":"weekly-reporter/claude-code","createdAt":"2026-10-13T09:00:00.000Z","sourcePeriod":{"scope":"week","periodStart":"2026-10-12","periodEnd":"2026-10-18","monthKey":null,"label":"Week 2026-10-12 - 2026-10-18"}},{"id":8,"planItemId":12,"content":"Successor follow-up","author":null,"createdAt":"2026-10-20T09:00:00.000Z","sourcePeriod":{"scope":"week","periodStart":"2026-10-19","periodEnd":"2026-10-25","monthKey":null,"label":"Week 2026-10-19 - 2026-10-25"}}]}
```

Timestamps stay in the API's wire form (`createdAt`); the client does no
system-zone formatting, so `TZ` has no effect on this verb. `author: null` means a
browser comment; render it as `user`.

Each comment's `planItemId` is the item it is **pinned to**, which is not
necessarily the item you queried — that pair is what `comments delete` needs.
Here `id` is the **comment** id, not a timeline tag or an event id:
`references/events.md` uses `#<id>` as the event token, so read the enclosing
section to know which entity a `#` token names. With no comments the body is
`{"commentCount":0,"comments":[]}`, exit 0 — an empty answer, not an error.

### comments add

```bash
wrp plans comments add <item-id> --text <text>
```

The text is required and non-empty (the API trims it). The comment is visible
immediately on the item's plans page and is never added to the timeline or a
report.

Success: `✓ comment created: #<commentId> on %<itemId> (author: <author>)` —
the id and the API-stamped authorship, so attribution is observable.

### comments delete

```bash
wrp plans comments delete <item-id> <comment-id>
```

`<item-id>` is the item the comment is **pinned to** (the `%<itemId>` on its
list line), not the item you are viewing. Deletion is permanent and also removes
the comment's `@id` citation index rows. Confirm with the user first.

Success: `✓ comment deleted: #<commentId> on %<itemId>`.

## Error handling

One JSON error envelope on stderr and a non-zero exit for every failure:
`{"error":{"status":…,"code":…,"message":…,"fix":…}}`. The `fix` field names the
next command. Common cases: invalid `--priority`/`--important`/`--urgent`
(client-side, no request sent), missing period flags, a 400 for parent
containment or a non-deferrable status, a 404 for a missing item/plan/comment,
and 401 (provision credentials with `wrp init`).
