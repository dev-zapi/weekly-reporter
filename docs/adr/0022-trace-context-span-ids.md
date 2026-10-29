---
status: accepted
---

# Trace context propagation with W3C-compatible IDs and per-request spans (2026-10-29)

Every `/api/**` request is now traced in the Spring-Sleuth sense: it receives a `traceId` — inherited from an inbound trace header when one is present and valid, otherwise generated — and a fresh root `spanId`. All three identifiers are returned on every API response through `x-trace-id`, `x-span-id`, and `traceparent`, so a user-facing error can be tied back to the exact server log line. Server logs emitted during the request are automatically prefixed with `[traceId=… spanId=…]` without editing a single existing `console.*` call site. Outbound HTTP calls to AI providers and to GitHub/GitLab carry `traceparent` (and `x-trace-id`) so the trace continues downstream, and client pages append `(trace: <id>)` to an API error message when the response carries the header.

## Identifiers and compatibility

A `traceId` is 32 lowercase hex characters (128-bit) and a `spanId` is 16 lowercase hex characters (64-bit); neither may be all zero. `traceparent` is rendered as `00-{traceId}-{spanId}-01`, with the flags field fixed at `01` (sampled) — this system has no sampling decision to make. IDs are generated with `globalThis.crypto.getRandomValues`, never `node:crypto`, because the identifier module must be importable from `src/proxy.ts` as well as from jsdom/vitest tests. The module is therefore split three ways: `src/lib/trace/ids.ts` is pure and client-safe, `src/lib/trace/context.ts` is `server-only` and holds the AsyncLocalStorage, and `src/lib/trace/console-patch.ts` owns the console wrapping.

Inbound IDs are read with the priority `traceparent` → `x-b3-traceid` → `x-trace-id`. A candidate that is malformed, uppercase, all zero, or otherwise invalid falls through to the next source rather than rejecting the request; if none of the three yields a valid ID, a new trace is started. A 64-bit B3 trace id (Sleuth's default) is left-padded to 128 bits, so an upstream Sleuth service keeps the same trace lineage in this system's logs. The version field of an inbound `traceparent` is only rejected when it is `ff` (the one value W3C reserves as invalid).

The inbound `traceparent`'s span position is deliberately not adopted as a parent. This process has no upstream span object to point at, so the request still starts a root span; only the `traceId` is continued. A child-span API (`withSpan(name, fn)`) shipped in the first iteration of this ADR and was removed before merge: no caller existed, and its completion log — emitted inside the child span's own context — was the one code path where the console prefix patch would stamp a line with duplicated `[traceId= spanId=]` information. The system keeps exactly one root span per request; reintroduce child spans (with a log line that bypasses or accounts for the console patch) when a real consumer appears.

## Request lifecycle

`withAuth` in `src/lib/auth/guard.ts` is the single enforcement point. It parses the inbound trace id, then runs authentication and the handler inside `runWithTrace`. On a 401 it applies the trace headers to the guard's own response before returning; otherwise it applies them to the handler's response before writing the audit row. A nested `runWithTrace` passes through instead of starting a second root, so a trace begun elsewhere is never replaced. Because every route already exports `withAuth(...)` and `route-coverage.test.ts` enforces that shape, no route file changes and the tracing applies to the whole API surface at once. The handler may be invoked without a `Request` in tests (`GET()` called directly), so the trace-id parse guards against an absent request and simply generates an ID in that case.

`src/proxy.ts` keeps its optimistic-only role. Its own early 401 — a request with no `Authorization` header at all — must also carry trace headers, because a missing or expired PAT is the most common failure a user reports. The proxy parses (or generates) a trace id and writes the three headers onto that one response; pass-through responses are untouched and get their headers from `withAuth`. This keeps the existing division of responsibility: the proxy provides coverage, the guard makes the authoritative decision.

## Response headers, not the body

The identifiers travel only in response headers. Adding them to a JSON body was rejected because errors can originate in the proxy, the guard, the handler, or the framework, and because a streaming response's body may already be committed when the handler returns. A header is the one channel that every response can be decorated through. `applyTraceResponseHeaders` wraps its writes in `try/catch` and silently skips immutable headers, so a diagnostic nicety can never turn a working response into a 500.

The client reads the same header through `traceSuffix(response)` in `src/lib/api-client.ts` and appends `(trace: xxx)` to the displayed error message. `verifyPassword` changes from a boolean to `{ ok: boolean; traceId: string | null }` because it deliberately bypasses `apiFetch`'s clear-and-redirect side effect and is the only caller that needs the ID out of a 401; the login page appends it on the wrong-password path. A thrown network error has no `Response`, so that path has no trace to show.

## Logging

`installTraceConsolePatch()` is called once from the `nodejs` branch of `register()` in the repository-root `instrumentation.ts`, following the existing dynamic-import pattern there. It wraps `console.log`, `info`, `warn`, `error`, and `debug`: inside an active trace it inserts `traceLogPrefix()` as the first argument; outside a trace it calls the original untouched. Installation is idempotent via a `Symbol.for` flag on `globalThis`, so repeated instrumentation or module instantiation cannot stack prefixes. This is the only place that patches the console; no feature code reimplements it. The payoff is that existing `console.error` calls — including the unhandled-handler-error log in `withAuth` — gain the trace prefix without being touched.

## Outbound propagation

Outbound calls inject the trace headers explicitly at the known call sites rather than through a global `fetch` monkey-patch: the `fetch` paths in `src/lib/ai/provider.ts` (`createReasoningCompatibleFetch`, `fetchModelList`, and the `createAnthropic`/`createOpenAI` client construction, which receives a local traced wrapper), plus the single `fetch` call in `src/lib/collect/adapters/github-adapter.ts` and `gitlab-adapter.ts`. Each merges `outboundTraceHeaders()` into its request headers. Per W3C semantics the outbound `traceparent`'s span position is our current span, which becomes the downstream call's parent. With no active context the helper returns `{}`, so non-request call sites (startup jobs, tests) behave exactly as before.

## Relation to ADR-0020

ADR-0020's audit log records *which PAT called which endpoint, and when*. Trace IDs answer a different question: *which log lines and downstream calls belong to this one request*. The two are complementary; the audit row does not store a trace id, and adding that column is left as future work rather than silently expanding the audit schema here.

## Considered Options

- Trace IDs in the JSON response body versus in response headers (chosen: headers — errors come from multiple layers and streaming responses cannot rewrite an already-committed body)
- Starting the trace in `src/proxy.ts` versus in `withAuth` (chosen: `withAuth` — the guard wraps every route and already owns the request lifecycle; the proxy only decorates its own early 401, because successful responses are the guard's responsibility)
- Threading a context object through every function versus AsyncLocalStorage (chosen: ALS — it survives `await` boundaries without changing any handler signature)
- A global `fetch` monkey-patch versus explicit injection at outbound call sites (chosen: explicit — no hidden behavior on unrelated libraries, trivially testable, and the set of outbound clients is small and known; the cost is that a future outbound call must remember to merge the headers)
- Replacing `console` with a logger abstraction versus patching the existing methods in `instrumentation.ts` (chosen: patching — zero changes to existing call sites, which is the point of the Sleuth-style behavior)
- Adding a trace column to `api_audit_log` now versus leaving it for future work (chosen: future work — it would widen the audit schema for a diagnostic that is already recoverable from response headers and log lines)
- Rejecting a request whose inbound trace headers are all invalid versus generating a fresh trace (chosen: generate — tracing must never be a reason a request fails)

## Consequences

- Tracing is a diagnostic signal, not a security boundary. A client may choose its own inbound `traceId`, just as it can choose other W3C trace headers; nothing should authorize, rate-limit, or bill on it.
- RSC pages that read the database directly never pass through `/api/**` and are not traced. The repository's only `'use server'` file, `src/app/collect/actions.ts`, is likewise outside both the proxy matcher and `withAuth`.
- Streamed responses with immutable headers are silently left unannotated by `applyTraceResponseHeaders`. Losing the IDs on such a response is preferred over throwing.
- Client-side network failures (a `fetch` that throws) have no `Response` and therefore no trace suffix; only responses can carry an ID.
- The console patch is process-global and permanent for the lifetime of the Node.js process. That is acceptable for a single-user server; it is also why installation is limited to the `nodejs` runtime branch.
- There is no span exporter, collector, or span storage, so trace data lives no longer than the log retention policy.
- Frontend error strings gain `(trace: …)` only when the response actually carries the header. Existing page tests whose mocked responses omit it therefore see unchanged text; only `verifyPassword`'s changed return shape requires test updates.
- `src/lib/auth/guard.trace.test.ts` asserts the wrapped handler's headers (including the 401 path and inbound trace-id inheritance), and `src/proxy.test.ts` asserts the proxy's early 401, so the two mandatory integration points have direct coverage.
