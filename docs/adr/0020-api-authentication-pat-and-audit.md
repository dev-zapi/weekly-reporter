---
status: accepted
---

# Authenticate the API with a startup password and PATs, and audit PAT calls

The API surface gains two credential kinds and one record of who called what. A **startup password** is generated on first boot into `~/.config/weekly-reporter/auth.json` and gates browser access; a **Personal Access Token (PAT)** is issued per script or agent and stored server-side as a SHA-256 hash. Both are presented as `Authorization: Bearer <token>` on every `/api/**` request. Only PAT calls are recorded in a new `api_audit_log` table. Page HTML and static assets stay unprotected; `WR_AUTH_DISABLED=1` turns the whole thing off.

Authentication is enforced in two layers. `src/proxy.ts` (Next 16 renamed `middleware` to `proxy`; it always runs on the Node.js runtime) rejects requests that carry no `Authorization` header at all, so a route that forgets to opt in is still shielded from unauthenticated traffic. Each route handler is then wrapped by a `withAuth` HOF that makes the authoritative call, updates the PAT's `last_used_at`, and writes the audit row. The audit row is written by the HOF rather than the proxy because the proxy runs before the route handler and therefore cannot observe the handler's final HTTP status — a status field that records 200 for a request that actually returned 500 is worse than no field.

The proxy exists for coverage, not for judgment. Comparing a PAT means a database lookup and a hash comparison, and the Next.js documentation explicitly steers Proxy away from full session management. So the proxy does an optimistic check only; the HOF does the real work and is where the audit row comes from, because only the HOF sees both the authenticated identity and the final status.

A PAT is stored as a SHA-256 hash, and its plaintext is shown exactly once at creation. This deliberately departs from the existing precedent in this repository, where collection-source tokens are stored in plaintext in SQLite (ADR-0011). That precedent is sound for a credential that never leaves the machine and only ever needs masking on screen; a PAT is the opposite — it is handed to scripts and agents that run elsewhere, so it is a bearer token that must survive transmission without the server being able to read it back. Lost PATs are revoked and reissued, not recovered.

PATs carry no permission scopes. This is a single-user system whose only API clients are the user's own agents, so a scope system would add real complexity and buy no isolation.

The machine-level credential — which PAT to use, against which base URL — lives in the same `~/.config/weekly-reporter/auth.json` file under a `machine` field, and is overridden by `WEEKLY_REPORTER_PAT` and `WEEKLY_REPORTER_BASE_URL`. Every skill script resolves it in the same order, so a machine is configured once and all scripts agree.

## Relation to ADR-0015

ADR-0015 accepted an audit gap: externally-authored final reports carry no authorship record. This ADR narrows that gap but does not close it. What the audit log records is *which PAT called which endpoint, and when* — it is a record of API traffic, not of who wrote a piece of text. An external agent that fetches a draft and saves a final still leaves no authorship trail; that gap stands exactly as ADR-0015 described it, including the note there that audit parity for external authorship would require an explicit authorship record rather than reuse of proposal linkage. ADR-0015 is left unmodified; this ADR cites it.

## Considered Options

- Enforcing authentication only in `src/proxy.ts` versus only in per-route guards versus both (chosen: both — the proxy gives new routes coverage for free, but it cannot make the authoritative decision or observe the final status; a per-route guard alone leaves a silent hole whenever a new route is added without it)
- Writing the audit row in the proxy versus in the guard (chosen: the guard — the proxy cannot observe the route's final HTTP status)
- Storing PATs in plaintext like collection-source tokens (ADR-0011) versus hashing them (chosen: hashing — a PAT travels to other machines, unlike a local source token)
- Scoped PATs versus unscoped PATs (chosen: unscoped — a single-user system has nothing to isolate)
- Recording only successful PAT calls versus recording failed attempts too (chosen: recording failures as well — a revoked or expired PAT is the most common script failure, and without the record there is nothing to diagnose from; this extends the literal wording of the original charter, which only mentioned PAT calls)
- A separate `~/.config/weekly-reporter/pat.json` versus sharing `auth.json` with the startup password (chosen: one file — the startup password and the machine credential are both "how this installation is accessed", and splitting them would make every write need to preserve the other file's fields)

## Consequences

- Every `/api/**` route requires a credential. Existing skill scripts that send no `Authorization` header start returning 401, so the upgrade is a hard switch and must be sequenced.
- The startup password is stored in plaintext on disk, alongside a machine-scoped PAT. This is accepted for a single-user personal installation, where the threat model is someone obtaining the machine's disk rather than someone intercepting a token in transit.
- The proxy must live at `src/proxy.ts`. At the repository root it is silently ignored in a `src/app` layout — no build error, no warning — so a build is not proof of coverage and the build output must be checked for a `ƒ Proxy (Middleware)` line.
- Route handlers must be wrapped with `withAuth`, and a test must assert that every exported handler under `src/app/api/**` is wrapped. The proxy alone is not sufficient: a route that forgets the wrapper would accept a request carrying a wrong credential.
- Server Actions are not covered. `src/app/collect/actions.ts` is the repository's only `'use server'` file and does not live under `/api/**`, so it falls outside both the proxy matcher and the per-route guards.
- The audit log grows without bound and is never pruned.
- Seven vendored copies of the skill HTTP client must stay in sync; they are kept in sync by a marker-block rewrite script with a `--check` mode, not by hand.
