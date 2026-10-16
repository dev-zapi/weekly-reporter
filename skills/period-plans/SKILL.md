---
name: period-plans
description: >-
  Manage period plans (周计划/月度计划) and plan items (计划条目). Use this skill whenever the user wants to create, view, update, defer (顺延), or delete weekly or monthly plans and their items. Triggers on phrases like "周计划", "月度计划", "计划条目", "顺延", "周期计划", "list plan items", "defer an item", "weekly plan", "monthly plan", "plan items for this week", "what's planned for next month", "mark this item as done", "move this to next week".
---

Manage period plans via five Node.js scripts. All scripts use built-in `fetch` (Node 18+) and read `WEEKLY_REPORTER_URL` from env (defaults to `http://localhost:6868`).

## Boundary

This skill covers the independent period-plan entity (week and month plans with items, statuses, deferral). It does NOT cover:

- The "下周计划" (next week plan) section inside weekly reports — that belongs to the `weekly-reports` / `write-weekly-report` skill
- Single timeline events — those belong to the `timeline-events` skill

Period plans are independent entities that exist before, during, and after reports. They are not attached to any report.

## Concepts

A **period plan** covers a specific week (Monday-start natural week) or month (calendar month). Each plan has **items** with:

- Text (plain text, no @id/#tag parsing in Phase 1)
- Status: `planned` | `in_progress` | `done` | `cancelled` | `deferred`
- Project scope: `work` (default) | `personal`
- Optional parent item (week item → month item, constrained by month containing the week's start date)
- Optional deferral link (tracks the chain when an item is deferred to the next period)
- Position (manual ordering for priority)

**Deferral** is an explicit action that moves an incomplete item to the next period (same scope): it creates a new item in the next period with `status='planned'`, links back to the original via `deferredFromItemId`, and marks the original as `deferred`. Deferral never happens automatically.

## List

Query plans by scope and period. Output shows the plan metadata and all items with their status, scope, and text.

```bash
node {baseDir}/scripts/list.mjs --scope <week|month> [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>]
```

- `--scope week` requires either `--date` (derives the week containing that date) or both `--week-start` and `--week-end`
- `--scope month` requires either `--date` (derives the month containing that date) or `--month YYYY-MM`
- No flags = error

Output format:
```
Plan: <scope> <periodStart> to <periodEnd> (id=<planId>)
  #<itemId> [<status>] [<scope>] <text>
  #<itemId> [<status>] [<scope>] <text> (parent=<parentItemId>)
  #<itemId> [<status>] [<scope>] <text> (deferred from #<originalId>)
```

If no plan exists for the period, prints "No plan found for this period."

## Add

Add a new item to a plan. The plan is auto-created if it doesn't exist.

```bash
node {baseDir}/scripts/add.mjs --scope <week|month> [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>] --text <text> [--scope <work|personal>] [--parent <itemId>]
```

- `--scope` (plan scope) — `week` or `month`
- For week scope: provide `--week-start` and `--week-end` (both required)
- For month scope: provide `--month YYYY-MM`
- `--text` — item text (required)
- `--scope` (project scope) — `work` (default) or `personal`
- `--parent` — parent item ID (week item → month item; must exist and the month must contain the week's start date)

On success: `✓ Item created: #<ID> (plan=<planId>)`

## Update

Modify an existing item. At least one flag is required.

```bash
node {baseDir}/scripts/update.mjs <id> [--text <text>] [--status <status>] [--scope <work|personal>] [--position <n>] [--parent <itemId>]
```

- `--text` — replace item text
- `--status` — change status (one of: planned, in_progress, done, cancelled, deferred)
- `--scope` — change project scope (work or personal)
- `--position` — change sort order (manual priority)
- `--parent` — change parent item ID (or remove parent by passing empty string)

On success: `✓ Item #<id> updated`

## Defer

Explicitly defer an incomplete item to the next period (same scope). This creates a new item in the next period and marks the original as `deferred`.

```bash
node {baseDir}/scripts/defer.mjs <id>
```

- Confirm with the user before deferring. The original item will be marked `deferred` and a new item will appear in the next period with `status='planned'`, linked back via `deferredFromItemId`.
- The target period is always the next one (week → next week, month → next month). You cannot defer to an arbitrary period.
- On success: `✓ Item deferred: #<newId> created in next period (original #<id> marked deferred)`

## Delete

Remove an item. This is a hard delete — the item is gone permanently.

```bash
node {baseDir}/scripts/delete.mjs <id>
```

- Confirm with the user before deleting. If the item has children (other items reference it as parent), those children lose their parent link but are NOT deleted.
- On success: `✓ Item #<id> deleted`
- On 404: item not found

## Error handling

All scripts exit 0 on success, non-zero on failure. Common errors:

| Message | Cause | Fix |
|---|---|---|
| `Cannot reach weekly-reporter` | Server not running | Start with `npm run dev` |
| `Invalid request (HTTP 4xx)` | Bad input | Check the error detail and retry |
| `Server error (HTTP 5xx)` | Backend issue | Check server logs |
| `Period plan not found` | Plan ID doesn't exist | Check the plan ID from list output |
| `Plan item not found` | Item ID doesn't exist | Check the item ID from list output |
