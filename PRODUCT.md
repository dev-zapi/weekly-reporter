# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an individual developer or technical professional maintaining their own work record and reports on a self-hosted instance. They work across local and hosted Git repositories, record additional work manually, maintain weekly and monthly plans, and need reports for both leadership and themselves.

This is deliberately a single-user personal system, not a team reporting or collaboration product. There are no organizational roles or multi-user workflows.

## Product Purpose

weekly-reporter turns a user's ongoing work evidence into a searchable timeline, explicit period plans, and audience-specific weekly reports. It exists to make recurring reporting grounded in what actually happened while preserving a clear record of how each report was produced.

Success means the user can assemble and refine a leadership or personal report without reconstructing the week from memory, can trace its facts back to a frozen event snapshot, and remains the person who reviews and adopts the final content. Traceable, human-reviewed reporting takes priority over maximum automation.

## Positioning

The product's distinguishing contract is evidence-first report generation: collected and manual events are frozen into audience-specific snapshots, deterministic source drafts are produced without AI, and AI works in persistent sessions to propose final reports that the user must explicitly review and adopt. Period plans remain independent operational records rather than hidden inputs or automatically carried-over report prose.

The browser and agent/API skills are peers over the same personal system of record, allowing the user to capture and manage work from their existing development workflow.

## Operating Context

- Self-hosted personal web application, currently developed and run in a trusted individual environment.
- Work evidence comes from local Git repositories and remote GitHub/GitLab sources, supplemented by manual timeline events.
- The timeline supports work-time ordering, importance, tags, event references, and plan-item references.
- Weekly and monthly period plans support lifecycle states, project scope, priority, important/urgent flags, explicit deferral, fulfillment evidence, append-only comments, and monthly review.
- A weekly report has leadership and personal audience variants. Leadership includes work-project collected events and manual events; personal includes all events. Each variant has its own event snapshot, source draft, and current final.
- Final generation uses a selected report template and AI style in a persistent multi-turn session. The user reviews rendered, source, and diff proposals before adoption; historical reports may be read as reference but never replace the current source draft as the fact source.
- Repository skills provide agent access to collection sources, timeline events and tags, period plans, report templates, and reports through authenticated API calls.

## Capabilities and Constraints

- Single-user, self-hosted use with browser and agent/API access is a durable boundary; do not introduce multi-user roles or collaboration assumptions.
- Browser access uses the startup password. Scripts and agents use personal access tokens; PAT calls are audited, while browser calls are not.
- The AI connection, models, report templates, AI styles, and system prompts are database-driven product configuration.
- Report facts must come from the current audience variant's frozen event snapshot and deterministic source draft. Later event edits, deletions, collection changes, or project-scope changes must not silently alter an existing snapshot.
- AI-generated content is a candidate until explicit proposal review and adoption. Empty source drafts can be saved but cannot generate a final report.
- Historical evidence, generation sessions, adopted proposals, and audit records are retained where required for traceability; the application does not invent missing provenance.
- Period plans are independent of reports. Deferral is explicit, never automatic; plan-item comments are planning context, not timeline work facts or report-source input.
- Next-week plan text inside a final report is ordinary report prose, not a period-plan entity or an automatic carry-over mechanism.
- Existing Chinese domain terminology and the distinctions recorded in `CONTEXT.md` are product language, including event time versus recorded time, source draft versus final report, audience variants, and plan-item references.
- Deployment is personal/self-hosted; no team, multi-tenant, or public-service operating model is established.

## Brand Commitments

The established product name is **weekly-reporter**. Product and domain language is predominantly Chinese, with established English identifiers where the codebase and agent interfaces require them. Preserve the terminology and avoid-list distinctions in `CONTEXT.md`.

## Evidence on Hand

- `README.md`: current product overview, primary workflows, development status, and local test constraints.
- `CONTEXT.md`: canonical domain vocabulary and behavioral rules.
- `docs/adr/`: architecture decisions covering collection, report generation, authentication, plans, references, and traceability.
- `src/app/`, `src/components/`, and `skills/`: implemented browser workflows and agent-facing product capabilities.
- `e2e/` and the Vitest suite: executable behavioral evidence.
- Real user data, report content, and templates may exist in the local application database; treat them as personal data, not marketing proof.

No customer testimonials, public case studies, pricing, or externally validated performance claims are established; future product copy must not fabricate them.

## Product Principles

1. **Evidence before prose.** Reports begin from traceable work facts, not from an AI's reconstruction or a template's implied content.
2. **Freeze the reporting basis.** A saved report remains interpretable through its event, template, style, and generation-context snapshots even as live data changes.
3. **AI proposes; the user decides.** Generation assistance never bypasses proposal review or silently replaces the current final.
4. **Keep plans and reports distinct.** Plans record intent and follow-through; reports communicate work. Connections between them are explicit and do not collapse their semantics.
5. **One user, several first-class work surfaces.** Browser and agent workflows share the same records, authentication boundaries, and terminology without introducing team complexity.
