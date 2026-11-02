---
name: period-plans
description: >-
  Manage period plans (周计划/月度计划) and plan items (计划条目). Use this skill whenever the user wants to create, view, update, defer (顺延), or delete weekly or monthly plans and their items. Triggers on phrases like "周计划", "月度计划", "计划条目", "顺延", "周期计划", "list plan items", "defer an item", "weekly plan", "monthly plan", "plan items for this week", "what's planned for next month", "mark this item as done", "move this to next week".
---

Manage period plans via five Node.js scripts. All scripts use built-in `fetch` (Node 18+) and read credentials from the env (`WEEKLY_REPORTER_PAT` for the token; `WEEKLY_REPORTER_BASE_URL`, or its alias `WEEKLY_REPORTER_URL`, for the base URL) or from the machine credential at `~/.config/weekly-reporter/auth.json`; the base URL defaults to `http://localhost:6868`. Without a PAT every `/api/**` call returns 401 — run the **configure-pat** skill to set one up.

## Boundary

This skill covers the independent period-plan entity (week and month plans with items, statuses, deferral). It does NOT cover:

- The "下周计划" (next week plan) section inside weekly reports — that is plain report prose, not a plan mechanism; it belongs to the `weekly-reports` / `write-weekly-report` skill
- Single timeline events — those belong to the `timeline-events` skill

Period plans are independent entities that exist before, during, and after reports. They are not attached to any report.

## Concepts

A **period plan** covers a specific week (Monday-start natural week) or month (calendar month). Each plan has **items** with:

- Text (plain text, no @id/#tag parsing in Phase 1)
- Status: `planned` | `in_progress` | `done` | `cancelled` | `deferred`
- Project scope: `work` (default) | `personal`
- **优先级 (Priority)**: `high` | `normal` (default) | `low` — the item's execution weight and the only grouping/sorting dimension. Items are listed high → normal → low, with manual position preserved inside each group.
- **重要标记 (Important Flag)**: `true` | `false` (default `false`) — the "important" axis of the four-quadrant judgement. It is a semantic annotation only and does not affect sorting.
- **紧急标记 (Urgent Flag)**: `true` | `false` (default `false`) — the "urgent" axis of the four-quadrant judgement. It is a semantic annotation only and does not affect sorting.

  The two plan-item markers are orthogonal to priority and to each other (any combination is allowed, including `low` + important + urgent), and both are inherited when an item is deferred. They are a **different entity** from the timeline event importance toggle in the `timeline-events` skill: same-sounding "important", but different records with independent values.
- Optional parent item (week item → month item; the API enforces "month contains the week's start date" — see Add)
- Optional deferral link (tracks the chain when an item is deferred to the next period)
- Position (manual ordering inside a priority group)

**Deferral** is an explicit action that moves an incomplete item to the next period (same scope): it creates a new item in the next period with `status='planned'`, links back to the original via `deferredFromItemId`, and marks the original as `deferred`. Deferral never happens automatically.

## List

Query plans by scope and period. Output shows the plan metadata and all items with their status, scope, priority, important/urgent markers, and text.

```bash
node {baseDir}/scripts/list.mjs --scope <week|month> [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>]
```

- `--scope week` requires either `--date` (derives the week containing that date) or both `--week-start` and `--week-end`
- `--scope month` requires either `--date` (derives the month containing that date) or `--month YYYY-MM`
- No flags = error

Output format:
```
Plan: <scope> <periodStart> to <periodEnd> (id=<planId>)
  %<itemId> [<status>] [<scope>] [priority=<high|normal|low>] [important=<true|false>] [urgent=<true|false>] <text>
  %<itemId> [<status>] [<scope>] [priority=<...>] [important=<...>] [urgent=<...>] <text> (parent=<parentItemId>)
  %<itemId> [<status>] [<scope>] [priority=<...>] [important=<...>] [urgent=<...>] <text> (deferred from %<originalId>)
```

All three fields are printed for every item, including `false` markers, so the current quadrant position is always visible. Items are ordered by priority group (high, then normal, then low) and by manual position inside each group.

If no plan exists for the period, prints "No plan found for this period."

## Add

Add a new item to a plan. The plan is auto-created if it doesn't exist.

```bash
node {baseDir}/scripts/add.mjs --scope <week|month> [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>] --text <text> [--project <work|personal>] [--parent <itemId>] [--priority <high|normal|low>] [--important <true|false>] [--urgent <true|false>]
```

- `--scope` — plan scope: `week` or `month`
- For week scope: provide `--week-start` and `--week-end` (both required)
- For month scope: provide `--month YYYY-MM`
- `--text` — item text (required)
- `--project` — item project scope: `work` (default) or `personal`
- `--parent` — parent item ID (week item → month item). The API enforces that the parent exists, is a month item, and that its month contains the week's start day; invalid links are rejected with HTTP 400.
- `--priority` — 优先级 (Priority): `high`, `normal` (default), or `low`. Any other value is rejected by the script before the request.
- `--important` — 重要标记 (Important Flag): `true` or `false` (default `false`).
- `--urgent` — 紧急标记 (Urgent Flag): `true` or `false` (default `false`).

The two markers are independent of priority and of each other — for example `--priority low --important true --urgent true` is valid.

On success: `✓ Item created: %<ID> (plan=<planId>)`

## Update

Modify an existing item. At least one flag is required.

```bash
node {baseDir}/scripts/update.mjs <id> [--text <text>] [--status <status>] [--project <work|personal>] [--position <n>] [--parent <itemId>] [--priority <high|normal|low>] [--important <true|false>] [--urgent <true|false>]
```

- `--text` — replace item text
- `--status` — change status (one of: planned, in_progress, done, cancelled, deferred)
- `--project` — change project scope (work or personal)
- `--position` — change manual sort order inside the item's priority group
- `--parent` — change parent item ID (pass `--parent ""` to clear the parent link). The API enforces that the parent exists, is a month item, and that its month contains the week's start day; invalid links are rejected with HTTP 400.
- `--priority` — change 优先级 (Priority) to `high`, `normal`, or `low`. This is the only way to change priority; `--position` never does.
- `--important` — set the 重要标记 (Important Flag) with `true` or `false` (pass `false` to clear it)
- `--urgent` — set the 紧急标记 (Urgent Flag) with `true` or `false` (pass `false` to clear it)

Omitted fields keep their current values; `false` is a real update. Example clearing both markers: `--important false --urgent false`.

On success: `✓ Item %<id> updated`

## Defer

Explicitly defer an incomplete item to the next period (same scope). This creates a new item in the next period and marks the original as `deferred`.

```bash
node {baseDir}/scripts/defer.mjs <id>
```

- Confirm with the user before deferring. The original item will be marked `deferred` and a new item will appear in the next period with `status='planned'`, linked back via `deferredFromItemId`.
- Only items with status `planned` or `in_progress` can be deferred; the API rejects `done`, `cancelled`, and `deferred` items with HTTP 400.
- The target period is always the next one (week → next week, month → next month). You cannot defer to an arbitrary period.
- On success: `✓ Item deferred: %<newId> created in next period (original %<id> marked deferred)`

## Delete

Remove an item. This is a hard delete — the item is gone permanently.

```bash
node {baseDir}/scripts/delete.mjs <id>
```

- Confirm with the user before deleting. Deleting a parent clears the `parentItemId` of its children (they are kept, not deleted); any `deferredFromItemId` pointing at the deleted item is kept as a stale historical reference. Mention this during confirmation when relevant.
- On success: `✓ Item %<id> deleted`
- On 404: item not found

## Error handling

All scripts exit 0 on success, non-zero on failure. Common errors:

| Message | Cause | Fix |
|---|---|---|
| `Unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | Run the **configure-pat** skill (`node scripts/configure-pat.mjs`) |
| `Cannot reach weekly-reporter` | Server not running | Start with `npm run dev` |
| `Invalid request (HTTP 4xx)` | Bad input | Check the error detail and retry |
| `--priority must be one of: high, normal, low` | Invalid priority value | Use `high`, `normal`, or `low` |
| `--important/--urgent must be 'true' or 'false'` | Invalid marker value | Pass the literal `true` or `false` |
| `Server error (HTTP 5xx)` | Backend issue | Check server logs |
| `Period plan not found` | Plan ID doesn't exist | Check the plan ID from list output |
| `Plan item not found` | Item ID doesn't exist | Check the item ID from list output |
