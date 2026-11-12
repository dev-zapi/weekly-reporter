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

/** Law 1 - one feedback line. */
export function feedback(entity, pastTense, identity) {
  console.log(`✓ ${entity} ${pastTense}: ${identity}`)
}

/** Law 2 - print the API body verbatim as one compact JSON line. */
export function emitJson(body) {
  console.log(JSON.stringify(body))
}

/** Plain one-line stdout for a write verb's empty case (`sources sync --all`). */
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
