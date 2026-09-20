---
status: accepted
---

# External agents author finals as peers of the generation-session AI

Agents outside the application (Claude Code, Codex, OpenCode, etc., guided by the `write-weekly-report` skill) may author final reports as peers of the internal generation-session AI: they read the source draft, template, and AI style themselves, write the final, and save it through the existing direct final-write path (`PUT /api/reports/[id]/final`). They do not drive generation sessions, and the application does not treat them as session operators. Final availability is therefore governed by `finalStatus === 'current'` with non-empty content — not by `acceptedProposalId`: carry-forward sources and the historical content tool accept any current final regardless of how it was authored. To keep provenance comparable across authorship paths, the direct final-write route accepts optional `templateId` and `aiStyleKey` and snapshots them onto the variant exactly as proposal acceptance does.

## Considered Options

- External agent drives application generation sessions as a headless operator versus writing the final directly as a peer (chosen: peer authorship — orchestrating the configured model from a stronger external model adds streaming complexity without domain value, and the user-facing effect should be identical either way)
- Availability keyed on `acceptedProposalId` versus on `finalStatus` (chosen: `finalStatus` — keying on proposal linkage silently excluded manually-written finals from carry-forward and historical reads, a latent bug predating this decision)
- Reusing proposal linkage for external authorship versus accepting the audit gap (chosen: accept the gap — externally-authored finals carry no session, proposal, public summary, or delete-protection record; introducing an "external proposal" model is deferred until a real audit need appears)

## Consequences

- Manually-written finals become first-class carry-forward sources and readable by the internal AI's historical query tools, fixing the pre-existing invisibility bug.
- Externally-authored finals are deletable without `AUDIT_RECORD_REQUIRED` and leave no generation transcript; the skill's mandatory show-full-draft-and-confirm protocol replaces proposal review as the human checkpoint.
- The `write-weekly-report` skill, not the application, is responsible for replicating the stable generation rules (source-draft grounding, audience boundaries, plan invariants) for external authors.
- If audit parity for external authorship is ever required, add an explicit authorship record rather than reusing proposal linkage.
