// Parse @<id> references from event content.
// Boundaries align with tag parsing: preceding char is whitespace or start of string,
// following char is whitespace or end of string (lookahead, not consumed).
//
// The regex captures the id group; the leading boundary (whitespace or start)
// is consumed but not captured so callers can reconstruct surrounding text.
export const REFERENCE_MATCH_REGEX = /((?:^|\s)@(\d+)(?=\s|$))/g

export function parseReferences(content: string): number[] {
  const set = new Set<number>()
  for (const match of content.matchAll(REFERENCE_MATCH_REGEX)) {
    const id = Number.parseInt(match[2], 10)
    if (Number.isFinite(id) && id > 0) {
      set.add(id)
    }
  }
  return [...set]
}
