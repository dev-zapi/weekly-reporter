---
status: accepted
---

# Plan-item priority as an orthogonal ordering axis, decoupled from quadrant flags

Plan items gain three mutually orthogonal fields: a **priority** (`high`/`normal`/`low`, default `normal`) that serves as the only priority dimension of list ordering — items group high→normal→low in both /plans and the timeline plan panel, manual position orders within a group — plus an **important flag** and an **urgent flag** that record the two Eisenhower quadrant axes as semantic annotation only. Priority is deliberately *not* importance: importance and urgency live in the flags, combinations are completely free (low-priority-but-important is a legal, meaningful state), and the system applies no linkage or validation between the three fields. All three fields are inherited wholesale on deferral, alongside text and project scope. This round adds no filters and no AI/report consumption; final generation continues not to read plan items.

## Considered Options

- Orthogonal priority + two flags (chosen) vs single 3-level axis where priority means importance with the quadrant used only as an entry heuristic: the quadrant record should persist on the item, not evaporate after entry, and importance deserves a dedicated flag rather than being conflated with ordering weight.
- Orthogonal fields (chosen) vs dual-axis-only model (importance × urgency stored, no priority): group sorting from two axes requires a second rule to order quadrants; a single ordering axis keeps the sort self-evident while position already handles within-group order.
- Three fields (chosen) vs single 4-value quadrant enum (立即做/排期/委派/放弃): quadrant names like delegate/eliminate fit team task management, not a personal weekly plan; and it would still be a single axis, losing free annotation.
- Free combination (chosen) vs soft auto-suggest (important+urgent prefills high) or hard validation (important+urgent must be high): "important but deliberately deferred to low" is exactly the state a planner needs to record; the system judging or nudging would fight the user's own assessment.

## Consequences

- CONTEXT.md gains 优先级 (Priority), 重要标记 (Important Flag), and 紧急标记 (Urgent Flag) entries under 周期计划; the plan-item 重要标记 is distinct from the timeline-event importance toggle (same word, different entity).
- Every plan-item surface orders by (priority, position); drag-and-drop reorders within a priority group only, and priority changes go through an explicit control — dragging never changes priority.
- Deferral copies priority and both flags to the new item; nothing is reset except status.
- API and the period-plans skill accept the three fields with enum/boolean validation; existing items backfill to `normal`/false/false.
- Filters and AI consumption are explicit non-goals for now; the AI question resurfaces when final generation starts reading plan items at all.
