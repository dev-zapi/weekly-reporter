---
status: accepted
date: 2026-11-09
---

# skills consolidated into the engineered wrp client

Eight vendored copies of the same HTTP/auth client (one per old API skill, plus the four flow skills' private copies — roughly 1.7k lines of duplicated logic) drifted apart under a stamping script whose only job was re-syncing a shared auth block into each copy. The configure-pat skill split its doc (inside the skill) from its script (repo root), so an installed copy could not set up its own credentials. And seven skills carried near-identical trigger descriptions, forcing the user and the agent to remember which skill owned which entity.

The replacement is one skill, `weekly-reporter`, with a single self-contained, zero-dependency client: `wrp <module> <verb>`, dispatched by `scripts/wrp.mjs`. Auth (credential resolution, self-report headers, 401/connection-failure handling) lives once in `scripts/lib/`, not eight times. Per-module reference docs (`references/init|sources|events|tags|plans|templates|reports.md`) become the knowledge home — the dense domain rules (token boundaries, snapshot immutability, cursor preservation, confirmation gates) move there verbatim, because after the cutover those docs are their only home. The five output format laws (feedback line, list line, error line, preview block, payloads-in-show-only) are a published contract: four upstream flow skills teach agents to parse it, so those docs were rewritten in lockstep in the same change. `wrp init` absorbs configure-pat with all four modes (`--pat`, interactive startup-password → PAT, `--show`, `--clear`). The dependent skills (collect-git-source, write-weekly-report, summarize-event, summarize-event-quick) slim to flow documents that invoke wrp and ship no client of their own. The old artifacts — the seven skill directories including their evals, the auth-block stamper and its template, the repo-root configure-pat script and its tests, the old plan-item comment behavior suite, and the `check:skills` npm script — are deleted in the same cutover.

## Considered Options

- **Keep seven narrow skills vs one cohesive skill**: narrow skills give crisper trigger surface but cost cross-entity recall, seven near-identical descriptions, and duplicate clients. Cohesion wins because invocation here is mostly deliberate or via an upstream flow doc; the description stays generic on purpose.
- **Keep stamped copies + the sync script vs one shared client**: stamping preserves per-skill self-containment but institutionalizes drift and makes every auth change a 7-way rewrite. One copy inside one self-contained skill is both simpler and still copy-to-install.
- **Redesign the output contract vs preserve each skill's historical lines**: preserving per-skill formats keeps the diff smaller but locks in the inconsistency agents already stumble on. A single contract is chosen, with the four upstream skill docs rewritten in lockstep so nothing parses a dead format.
- **Keep zero npm dependencies / zero build steps vs a packaged module**: the skill is installed by copying a directory onto machines that may only have Node 18+. Bundling or a build step would break that install story; built-in `fetch` and plain ESM keep it a copy.

## Consequences

- Trigger concentration is accepted: one skill's description must cover all entities. Deliberate invocation and upstream flow-doc references dominate in practice, so the description is kept short and broad rather than keyword-stuffed.
- The output contract is now a breaking-change surface: changing a format law requires updating the four upstream skill docs at the same time. They are part of the interface, not independent prose.
- User-level rollout (`~/.agents`, `~/.claude` copies) stays manual by design; this change ships no install or sync automation.
- Behavior tests live at one seam — the real `wrp.mjs` subprocess against a stub HTTP server; the old configure-pat pure-function tests and the old comment suite are superseded by CLI-seam cases, and the old eval sets are removed with their skills (trigger evals were explicitly declined).
- TS→Go server drift surfaced during the port and is documented in the module docs rather than hidden: plan-item delete answers `200 {deleted:true}` on the Go server where the retired TS route answered `204`, and the sync `lastSyncStatus` is written as `failed` on Go while historical rows and the client enum say `failure`; each module doc records the quirk its verbs absorb.
