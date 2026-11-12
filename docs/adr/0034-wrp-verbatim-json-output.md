---
status: accepted
---

# wrp read verbs emit verbatim JSON; unified JSON error envelope (2026-11-12)

The wrp client's real consumers are agents, but its read verbs printed human-styled line formats. List lines dropped every field the line could not carry — an event's parsed references, its raw `eventTime`, all of `metadata` — `show` verbs printed scattered `key: value` blocks whose shape varied per module, and `reports preview` truncated drafts to 12 lines with a `--full` escape hatch. An agent needing a dropped field had to make another API round-trip, and errors were prose lines (`✗ <cause>: <message> → <fix>`) that could only be pattern-matched, not branched on.

The replacement makes JSON the only read format. Every read verb prints the parsed API response body **verbatim** as one line of compact JSON on stdout (`JSON.stringify(body)`): no wrapper, no field curation, no renaming, so every field arrives intact and fields the API adds later appear automatically. Fifteen verbs adopt it: `sources list/show/lookup/emails`, `events list`, `tags list`, `plans list` and `plans comments list`, `templates list/show`, `styles list/show`, and `reports list/show/preview` (`preview` is a read verb: it computes a snapshot and creates nothing). `--part`/`--variant` survive only as sub-object/array filters on the verbs that take them (template and report `show`); the filtered selection prints verbatim, and with no filter the whole body is printed. Empty results are the raw body (`{"events":[]}`, `{"tags":[]}`, `{"plan":null,"items":[]}`) with exit `0`, so zero results are distinguishable from failure by exit code alone. stdout carries only data; stderr only errors.

Errors become one compact JSON envelope on stderr for every failure — read verbs, write verbs, connection failure and 401 alike:

```json
{"error":{"status":…,"code":…,"message":…,"fix":…}}
```

`status` is the HTTP status, or `null` for a client-side fault (bad flags, unresolvable refs, an unreachable server). `code` appears only when the API or the client supplies one (e.g. `SYNC_FAILED`, `SOURCE_BUSY`, `PARTIAL_SYNC_FAILED`). `message` distills the old cause and detail into one field, and `fix` keeps the actionable hint, including the exact in-session `! node … init` command on a 401. Exit codes stay `0` success, `1` failure or unconfirmed preview, `3` `sources lookup` found no source. Write verbs' `✓` feedback lines (including `sources sync`'s per-source/per-branch summary), destructive verbs' `PLAN:` preview blocks, `init --show`, and all flags and validations are unchanged.

## The additive-key whitelist

Verbatim passthrough has exactly one sanctioned exception, stated as a rule rather than a list:

> A client-added key is permitted only when (1) it **reassembles** information already present in the response body into flag-ready form, (2) it adds **no new information**, and (3) it appears **only when its material exists** in that body.

The sole member is `nextCursorToken` on `events list`: it reassembles the body's own `nextCursor` object (`{id, eventTime}`) into the `<id>@<epoch-millis>` form `--cursor` accepts, adds nothing not already in `nextCursor`, and is present only when both `hasMore` and `nextCursor` exist. Future keys are held to all three conditions; anything that would surface new information belongs to the API response, not the client.

## Laws that died, and why

- **List line** (`<id-token> [<metadata>] <body>`): lossy by construction — its fixed columns were the reason fields disappeared. The whole body supersedes it.
- **List footer** (`— N <entity>(s)`) and **prose empty-states**: counts and emptiness are in the body (`total`, `items: []`), and prose only adds a second thing to parse.
- **Pagination hint lines** (`next page:`, `page x/y`): continuation state belongs in the body (`hasMore`/`nextCursor`, `page`/`pageSize`/`total`), which agents can read and re-use directly.
- **Payloads-in-show-only**: the list body already carries every payload field; hiding them forced a second `show` call and made `show` the only place drafts and finals lived.
- **`reports preview --full` and the 12-line truncation**: the truncation saved tokens at the cost of a guaranteed rerun. Complete drafts are the default; `--variant` already narrows the read.
- **`✗` error line**: replaced by the JSON envelope. The `fix` hint survives inside the envelope, so nothing actionable was lost.
- **"No `--json` in v1"**: there is no dual mode. JSON *is* the contract, not a flag.

`--part`/`--variant` are not a survival of the payloads law: they filter which sub-object reaches the JSON emitter, and the selected projection is still emitted verbatim.

This decision supersedes spec #119's v1 output laws (the five-law contract recorded in ADR 0031: feedback line, list line, error line, preview block, payloads-in-show-only). #119 is a ticket number, not an in-repo spec file; the durable record is this ADR plus the comments in `skills/weekly-reporter/scripts/lib/output.mjs` and `lib/errors.mjs`. ADR 0031's lockstep rule still governs: the module reference docs and the upstream flow-skill docs are part of the interface, so they were rewritten in the same change.

## Considered Options

- **Keep the human list lines and add an opt-in `--json` vs JSON-only**: a dual mode doubles the format surface, keeps the lossy path alive, and forces every agent to remember a flag. The consumers are agents and humans who pipe to `jq`; JSON-only is one predictable contract.
- **Wrap success bodies (`{"ok":true,"data":…}`) vs verbatim passthrough**: a wrapper adds no information and forces an unwrap on every read, while a raw body means API-added fields need no client change. The one allowed additive key is the narrowly specified `nextCursorToken`.
- **Curate/rename fields into a client-shaped schema vs print the API body**: curation is the original defect — it silently drops what the client did not anticipate. Verbatim makes the API the single source of truth.
- **Keep `✗` prose errors vs a JSON envelope**: prose can only be pattern-matched; `status`/`code` are branchable, and `fix` preserves exactly the guidance the old line carried.
- **Keep preview truncation with `--full` vs complete drafts**: truncation guarantees a rerun whenever the draft matters; complete drafts plus `--variant` cost no extra call and remove a flag.

## Consequences

- Breaking change for anything parsing the old list lines, footers, hint lines, `✗` lines or `--full`: the upstream flow docs (daily-review, collect-git-source, summarize-event(-quick), writing-weekly-report, yesterday-recall) were lockstepped in the same change, because those docs are interface, not prose.
- The additive-key whitelist becomes a review obligation: any new client-added key must satisfy reassembly-only, no-new-information, and presence-gated-on-material. The rule lives here and in `lib/output.mjs`'s header.
- API response fields now reach agents automatically: a server-side field addition no longer needs a wrp release to become visible, and a client-side projection can no longer hide one.
- `--part`/`--variant` remain the only projection mechanism and print the filtered selection verbatim; there is no field-renaming layer to keep in sync.
- The behavior suite keeps its one seam — the real `wrp.mjs` subprocess against a stub HTTP server — and asserts stdout deep-equals the stubbed body (plus `nextCursorToken` exactly when its material exists) and stderr parses as the envelope. Write-verb `✓` lines, PLAN blocks and `init --show` are asserted unchanged.
- User-level rollout (`~/.agents/skills`, `~/.claude/skills` copies) stays manual by design per ADR 0031; the change ships no install automation, and the delivery includes the command list a human runs to sync the installed copies.
