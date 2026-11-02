---
status: accepted
---

# Plan Item Comments: Plan-Side Context with Event-Only Citations

Plan items (weekly and monthly, one entity per ADR-0018) gain **plan item comments**: append-only, timestamped, plan-side supplementary records — blockers, scope adjustments, decisions. Comments are not work facts: they never enter the timeline, event snapshots, source drafts, or final-generation input; expressing done work remains a manual event with a `%id` reference (ADR-0019). Each comment carries a lightweight author marker (browser = the user; PAT = the caller's self-reported agent identity, falling back to the token name, then the literal `pat` — attribution like the audit log, not a security boundary). An entry may be deleted but never edited in place; corrections append, so reference parsing happens exactly once, at write. Deferral never migrates comments: they stay pinned to their item, and successor items display-aggregate the deferral chain's ancestor comments with their source period marked, mirroring how fulfilling events aggregate. Deleting a plan item cascades its comments. Consumption is the `/plans` page (per-item chain-aggregated count badge + expandable section, including the monthly-review aggregated view) and the period-plans skill API (list/add/delete subcommands); the timeline plan panel and generation sessions never see comments, and week/month items behave identically.

Comments parse exactly one content token: `@id` event references, dual-stored (text stays in the comment, writes parse into a comment-source row in the event-reference index — a `comment_references` table mirroring `event_references` is the likely shape) with the same whitespace boundaries. `%id` and `#tag` are plain text inside comments. This split is deliberate: ADR-0019's single write surface for plan-item references — the fulfillment association — stays completely intact, because comments never write plan references; the second write surface opens only for event references, which never carried fulfillment semantics. Comment citations are navigation, not evidence: they render as clickable reference previews with dangling-reference semantics, they arm the cited event's deletion warning, and — in v1 — the event side shows a cited-by backlink (「被 N 条评论引用」) that locates the comment's plan item. Deleting a comment removes its index rows.

## Considered Options

- Append-only timestamped entries (chosen) vs a single mutable note field vs both: the note field discards the evolution history this domain preserves everywhere else (deferral keeps originals, snapshots freeze, transcripts append).
- Deletable-but-not-editable entries (chosen) vs editable with updatedAt (manual-event precedent) vs fully immutable: comments are narrative records at a point in time; editing an old one falsifies the judgement made then, while deletion covers mistakes.
- `@id` dual-storage in comments (chosen) vs plain text vs render-only links: deletion warnings and the event-side cited-by backlink both require the server-side index; render-only cannot support either.
- Parsing `%id` in comments as well (considered mid-design, then withdrawn) vs event-only parsing: `%id` in comments would open a second write surface for the fulfillment association and invent plan→plan citations — scope creep; keeping `%id` manual-event-only leaves ADR-0019 untouched rather than narrowed.
- Citations as navigation (chosen) vs extending the item's fulfillment view to aggregate comment citations: the fulfillment view answers "which work fulfilled this item"; citations answer "who mentions this event" — merging blurs both questions.
- Event-side backlink in v1 (chosen) vs deferred: the index exists anyway, and the backlink answers "why does this event matter to my plan".

## Consequences

- The 事件引用 and 引用解析 glossary entries now name plan item comments as a second content surface for `@id`; 计划项引用 remains manual-event-only.
- Event deletion warnings and cited-by counts must include comment referrers; dangling citations follow existing semantics (link shape kept, click reports the event missing).
- The timeline plan panel, event snapshots, source drafts, and report finals remain comment-free surfaces; no comment text ever rides into report content.
- The period-plans skill gains comment subcommands; its docs must note that `%id` in comments is plain text.
- ADR-0019 needs no amendment: its single-write-surface claim was scoped to plan-item references, which this design leaves untouched.
