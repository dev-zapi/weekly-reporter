---
status: accepted
---

# Plan Item References in Event Content Are the Fulfillment Association

ADR-0018 promised plan items an optional association to timeline events as fulfillment evidence, but left it unimplemented. We now realize that association as a third content token in manual events: `%<planItemId>`, with whitespace boundaries identical to tags (`#`) and event references (`@`). It is dual-stored exactly like the other two — the `%id` text stays in event content, and writes parse it into an `event_plan_references` index table mirroring `event_references` (the ADR-0012/0016 pattern). That index table **is** the association: a single source of truth, with event content as its only write surface. The plans page and the timeline plan panel render fulfilling events read-only; they never create or remove links — a plan-side write would either edit event prose it does not own or break dual-storage consistency. References are evidence, not state: writing one never changes item status. Deferral does not rewrite existing references; they stay pinned to the deferred original, and the display side aggregates the deferral chain (`deferredFromItemId`) so all related events remain discoverable from the successor item. Dangling references follow the event-reference semantics exactly (link shape kept, click reports the item missing, deletion warned via the index but not blocked). Any item of any period may be referenced.

`#` was unusable for the sigil because digit-only tags are legal (`#42` is already a tag), and `@`-prefixed forms (`@plan:42`) were rejected because they break the pure-numeric rule of `@` and put two entity kinds under one lead character; a distinct single-character sigil keeps all three tokens isomorphic.

## Considered Options

- One association with event content as the sole write surface (chosen) vs a second, plan-side-authored link: two links would produce two competing truths ("plan says 3 fulfilling events, events say 5").
- References pinned to the deferred original with display-side chain aggregation (chosen) vs rewriting to the successor item: rewriting falsifies which plan the work actually fulfilled.
- `%` sigil (chosen) vs `!` / `~` vs `@plan:`-style prefixes: see above.
- Index table + content text dual storage (chosen) vs render-time parsing only: server-side consumers (deletion warnings, fulfillment aggregation on the plans page) need the index, and users' prose keeps its `%id` tokens.

## Consequences

- ADR-0018's association is now concretely this table; no separate plan→event field or join will be added.
- The plans page and the timeline plan panel expose item ids in `%<id>` form so users can cite them while writing events; the period-plans agent skill's item handle changes from `#<id>` to `%<id>` for cross-surface consistency.
- Report event snapshots freeze content text as-is; `%id` tokens ride along like tags and references and are never rewritten retroactively.
- timeline-events and summarize-event skill docs must document the new token.
