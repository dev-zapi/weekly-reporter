// Output formatters - the four laws that print to stdout.
//
//   1. feedback:  ✓ <entity> <past-tense>: <identity>
//   2. list:      <id-token> [<metadata>] <body>  +  — N <entity>(s)
//   3. error:     ✗ … (lib/errors.mjs, stderr)
//   4. preview:   PLAN: / warnings / NOT EXECUTED — re-run with --confirm
//   5. payloads:  multi-line bodies only from `show`, under explicit part modes
//
// Client-generated lines are English; anything the API supplies (entity text,
// error messages) passes through verbatim. No `--json` in v1.

/** Law 1 - one feedback line. */
export function feedback(entity, pastTense, identity) {
  console.log(`✓ ${entity} ${pastTense}: ${identity}`)
}

/** Law 2 - one list line: id token first, bracketed metadata, then the body. */
export function listLine(idToken, metadata, body) {
  const meta = (metadata ?? []).filter((part) => part !== undefined && part !== null && part !== '')
  const prefix = [idToken, ...meta.map((part) => `[${part}]`)].filter(Boolean).join(' ')
  console.log(body ? `${prefix} ${body}` : prefix)
}

/** Law 2 - list footer: `— N <entity>(s)`, plus a caller-supplied pagination hint. */
export function listFooter(count, entity, { hint, detail } = {}) {
  console.log(`— ${count} ${entity}(s)${detail ? ` ${detail}` : ''}`)
  // The caller names its own continuation flag (`--cursor`, `--page`, …): no
  // module may advertise a flag it does not take.
  if (hint) console.log(hint)
}

/** The explicit empty state, so a zero-result answer never looks like a crash. */
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

/** Law 5 - a multi-line payload, only ever called from `show` part modes. */
export function block(label, content) {
  console.log(`${label}:`)
  for (const line of String(content ?? '').split('\n')) console.log(`  ${line}`)
}
