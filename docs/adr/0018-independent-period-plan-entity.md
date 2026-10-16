---
status: accepted
---

# Standalone period-plan entity independent of weekly reports

Plans become a standalone top-level entity — the **period plan** — covering weekly scope (Monday-start week, identified by its date range) and monthly scope (calendar month, identified as `yyyy-MM`) in one entity. Items carry a status lifecycle (planned / in_progress / done / cancelled / deferred), a per-item project scope reusing the collect-source work/personal semantics, an optional parent link from a weekly item to a monthly item, and an optional association to timeline events as fulfillment evidence. Unfinished items move across periods only by explicit user deferral (a new item in the target period linked back to the original; the original is marked deferred) — nothing carries over automatically. Plans hold no reference to reports; reports may reference plans. This consciously reverses the earlier decision recorded in the 计划结转 (Plan Carry-forward) glossary entry that the system builds no independent plan state model: the report-scoped machinery answers "don't lose last week's items while generating a report", but cannot answer "plan next week or next month before any report exists".

## Considered Options

- Reverse the no-model decision (chosen) vs keep it and merely enhance carry-forward and the timeline projection: planning ahead of any report is the actual need, and carry-forward is report-generation-time by construction.
- Optional one-way report→plan reference (chosen) vs zero linkage between the entity and reports: zero linkage would block a future "plan vs actual" report view; the reference keeps the dependency one-directional so plans survive without reports.
- One entity with a week/month scope column and optional parent links (chosen) vs separate weekly and monthly tables: separate tables duplicate item semantics and complicate cross-scope aggregation.
- Manual deferral only (chosen) vs automatic carry-over of unfinished items: automatic carry-over silently keeps alive items that should be dropped and falsifies period history.
- Single item list with per-item project scope (chosen) vs audience-split plans mirroring report variants: a plan is a personal execution list; leadership visibility is a filtering concern, and project scope is the established filtering vocabulary.
- Calendar months with week→month attribution by the week's start day (chosen) vs week-aligned months: week-aligned months break calendar intuition; straddling weeks get a simple, explainable attribution rule.

## Consequences

- The glossary keeps 下周计划 (Next-week Plan) unchanged for the report-final section and adds 周期计划 (Period Plan) for the entity; conflating the two is a terminology error.
- This ADR does not by itself migrate the existing plan machinery (carry-forward snapshot/judgments/overrides, the timeline plan table, the 下周计划 section in finals); that migration is decided and phased separately.
- Deferral preserves history: the deferred original stays in its period with deferred status, and carried chains remain traceable.
