// Output formatters - the four laws that print to stdout / stderr.
//
//   1. feedback:  ✓ <entity> <past-tense>: <identity>           (write verbs)
//   2. body:      one line of verbatim compact JSON (JSON.stringify(body)) for
//                 every read verb; API-added fields appear automatically.
//   3. error:     {"error":{"status":…,"code":…,"message":…,"fix":…}} on stderr
//                 (lib/errors.mjs).
//   4. preview:   PLAN: / warnings / NOT EXECUTED — re-run with --confirm
//
// The old list-line law (id token + bracketed metadata + footer) and the
// payloads-in-show-only law are dead: a read verb's whole body is printed, and
// `--part`/`--variant` simply filter which sub-object is passed to the JSON
// emitter. The "No --json in v1" note is superseded - JSON is the only format.
//
// Client-generated text is English; API-supplied text passes through verbatim.
// The legacy line helpers below survive only until their module tickets
// (#155-#159) move those read verbs to emitJson.

/** Law 1 - one feedback line. */
export function feedback(entity, pastTense, identity) {
  console.log(`✓ ${entity} ${pastTense}: ${identity}`)
}

/** Law 2 - print the API body verbatim as one compact JSON line. */
export function emitJson(body) {
  console.log(JSON.stringify(body))
}

/** Law 2 (retired) - one list line: id token, bracketed metadata, then body. */
export function listLine(idToken, metadata, body) {
  const meta = (metadata ?? []).filter((part) => part !== undefined && part !== null && part !== '')
  const prefix = [idToken, ...meta.map((part) => `[${part}]`)].filter(Boolean).join(' ')
  console.log(body ? `${prefix} ${body}` : prefix)
}

/** Law 2 (retired) - list footer: `— N <entity>(s)`, plus a pagination hint. */
export function listFooter(count, entity, { hint, detail } = {}) {
  console.log(`— ${count} ${entity}(s)${detail ? ` ${detail}` : ''}`)
  // The caller names its own continuation flag (`--cursor`, `--page`, …): no
  // module may advertise a flag it does not take.
  if (hint) console.log(hint)
}

/** The retired explicit empty state, until the read verbs emit bodies. */
export function emptyState(message) {
  console.log(message)
}

/** Law 4 - preview header + body lines + the not-executed footer. */
export function preview(lines, warnings = []) {
  console.log('PLAN:')
  for (const line of lines) console.log(`  ${line}`)
  for (const warning of warnings) console.log(`⚠ ${warning}`)
  console.log('NOT EXECUTED — re-run with --confirm')
}

/** Law 5 (retired) - a labeled multi-line payload, pending #158/#159. */
export function block(label, content) {
  console.log(`${label}:`)
  for (const line of String(content ?? '').split('\n')) console.log(`  ${line}`)
}
