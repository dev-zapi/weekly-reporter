---
status: accepted
---

# Report-side plan machinery removed: next-week plan content becomes plain prose

The 下周计划 (next-week plan) section inside report finals is now plain report prose, governed only by the template plus one soft style rule (若模板包含「下周计划」章节，以简洁列表陈述下周重点事项；模板未包含或明确禁止时，不添加该章节). All report-side plan machinery is deleted: the carry-forward snapshot captured at session creation, plan judgments and overrides, the `plan` parameter of `propose_final_report`, the deterministic plan merge that rewrote proposal content, the structure-completeness contract, and the dead `/api/timeline/plans` projection. Period plans (`period_plans` / `period_plan_items`, ADR-0018) are the single source of plan truth; cross-week continuity belongs to them via explicit deferral, not to report text. The only cross-week signal left to the generation AI is the read-only history report query tools.

Parsing an output document back into plan state was the root architectural smell. The carry-forward snapshot parsed last cycle's final (a *rendered* document, with a parse-failed branch and fuzzy text matching) to reconstruct plan state that a structured entity already owns deterministically. Deletion also fits the repo's explicit-over-automatic philosophy: every mechanism being removed existed to make an *automatic* carry decision safe (uncertain-by-default judgments, append-only overrides, drop tombstones, truncation recording). Once nothing carries automatically, none of that scaffolding has a job. What remains is what the user actually does in a report conversation: ask the AI to write prose.

## Why deletion instead of re-sourcing the carry-forward mechanism

The OKR evaluation report (2026-10-27, hermes-docs `weekly-reporter-okr-evaluation-20261027.md`, R1) proposed the opposite route: keep the judgment/override machinery intact and merely re-source the snapshot candidates from the period plan's unfinished items instead of parsing last cycle's final. That route was rejected because it preserves the smell while doubling the coupling:

- Re-sourcing keeps a second plan state alive inside report sessions — a projection of period plans that can drift, must be snapshotted, and still needs its own judgment/override/tombstone semantics on top of the entity that already has statuses and deferral.
- The evaluation itself argued "跨周期延续应基于结构化状态与证据，而非对输出文档的反向解析" — but the judgment/override layer it wanted to preserve is exactly the report-session-side plan state that B7 objects to. Following that principle to its conclusion deletes the layer, it does not re-feed it.
- The UI cost is permanent: the plan-override panel, plan-state columns, and per-candidate audit surfaces all survive under re-sourcing, for a mechanism the period-plan domain already replaces with one explicit "defer" action.
- The history report query tools already give the AI supervised, bounded access to last cycle's final when continuity genuinely matters; that is reference, not state.

## Relation to ADR-0018 and ADR-0019

ADR-0018 reserved a one-way report→plan reference direction ("plans survive without reports; reports may reference plans") as a future storage/backflow option. This ADR closes that reserved direction: reports no longer store or backflow any plan state. What stays open — deliberately, and undecided here — is the evaluation's R2-style *read-only* fact injection: capturing a period-plan snapshot as reference context for the generation session (plan-vs-actual prose). That would be a new fact input like the history query tools, not plan state storage, and requires its own ADR. ADR-0019 (event→plan-item fulfillment references) is untouched: it lives entirely in the period-plan/timeline domain.

## Deprecated storage and frozen prompts

No schema down-migrations. The following stay in the schema, marked `@deprecated`, and are no longer written; historical sessions keep replaying as plain message streams:

- Columns: `generation_sessions.carryForwardSnapshot`, `generation_sessions.planPolicy`, `generation_proposals.planState`, `report_variants.structureCompletenessRule`
- Tables: `generation_plan_judgments`, `generation_plan_overrides` (report deletion still cleans their rows; the previously missing override cleanup is fixed in the same change)
- Enums: `PlanJudgment`, `PlanOverrideAction`, `PlanOverrideSource`

Historical sessions keep their frozen system prompts containing the old PLAN_RULES text. They are not rewritten — consistent with the snapshot-freeze philosophy: a session's stored context is what the model actually saw, and editing stored history to match current policy would falsify the audit record. Old proposals' stored `publicSummary` keeps its plan fields; the normalizer accepts them, new summaries simply omit them.

## Considered Options

- Delete the report-side machinery (chosen) vs re-source the carry-forward snapshot from period plans (evaluation R1): re-sourcing preserves the reverse-parsing smell's downstream state and its UI surface; deletion makes period plans unambiguously the only plan state.
- Plain prose with a soft style rule (chosen) vs keeping a deterministic app-side plan section builder: a deterministic builder is plan state by another name — it must decide inclusion, ordering, caps, and empty-section wording, which is precisely the machinery being removed.
- Keep the structure-completeness contract as a neutral completeness check vs delete (chosen: delete): its rule version (`next-week-plan-structure/v1`) is defined entirely in terms of the next-week-plan section; with the section optional prose there is no completeness invariant to record.
- Clean up historical plan rows vs keep frozen (chosen: keep frozen): the audit-trail philosophy (accepted proposals are not deletable) applies; only the report-delete path gains the missing override cleanup.

## Consequences

- New generation sessions work end-to-end without the plan parameter, snapshot, judgments, or overrides; `propose_final_report` proposals are stored exactly as the model submits them.
- Finals save/accept without writing `structureCompletenessRule`; new finals render 下周计划 as ordinary markdown governed by template + soft rule.
- The proposal public summary keeps its non-plan audit fields (historical references, tool statuses, failure/truncation states, fact boundary); plan fields disappear from new summaries.
- Writing the next-week plan across weeks is now a user/author action (consult last week's final as reference, or check the period plan), never an automatic carry; the write-weekly-report skill wording follows.
- R2-style plan-fact injection into generation remains possible as a future, separately-decided ADR.
