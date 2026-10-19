// Segment manual-event content into renderable tokens for the two reference
// sigils: `@<id>` (event references) and `%<id>` (plan-item references).
//
// This is a pure helper so the boundary rules can be tested directly; the
// component just maps the tokens to elements. Both sigils reuse the canonical
// server-side regexes (REFERENCE_MATCH_REGEX / PLAN_REFERENCE_MATCH_REGEX) so
// the rendering boundary rules can never drift from the write-side parsers.
import { REFERENCE_MATCH_REGEX } from '@/lib/references'
import { PLAN_REFERENCE_MATCH_REGEX } from '@/lib/plan-references'

export type ContentToken =
  | { type: 'text'; text: string }
  | { type: 'event-reference'; id: number }
  | { type: 'plan-reference'; id: number }

type ReferenceKind = 'event-reference' | 'plan-reference'

interface RawMatch {
  index: number
  full: string
  idString: string
  id: number
  kind: ReferenceKind
}

function collectMatches(content: string, regex: RegExp, kind: ReferenceKind): RawMatch[] {
  // Fresh instance per call to reset lastIndex on the shared module regex.
  const fresh = new RegExp(regex.source, regex.flags)
  const matches: RawMatch[] = []
  for (const match of content.matchAll(fresh)) {
    matches.push({
      index: match.index!,
      full: match[0],
      idString: match[2],
      id: Number.parseInt(match[2], 10),
      kind,
    })
  }
  return matches
}

export function segmentContentTokens(content: string): ContentToken[] {
  const matches = [
    ...collectMatches(content, REFERENCE_MATCH_REGEX, 'event-reference'),
    ...collectMatches(content, PLAN_REFERENCE_MATCH_REGEX, 'plan-reference'),
  ].sort((a, b) => a.index - b.index)

  const tokens: ContentToken[] = []
  let lastIndex = 0

  const pushText = (text: string) => {
    if (!text) return
    const previous = tokens[tokens.length - 1]
    if (previous && previous.type === 'text') {
      previous.text += text
    } else {
      tokens.push({ type: 'text', text })
    }
  }

  for (const match of matches) {
    if (match.index > lastIndex) {
      pushText(content.slice(lastIndex, match.index))
    }

    // The boundary group consumes at most one leading whitespace character.
    const leadingWhitespace = match.full.slice(
      0,
      match.full.length - match.idString.length - 1,
    )

    if (Number.isFinite(match.id) && match.id > 0) {
      pushText(leadingWhitespace)
      tokens.push({ type: match.kind, id: match.id })
    } else {
      // Non-positive ids stay as plain text, exactly like the server parser.
      pushText(match.full)
    }

    lastIndex = match.index + match.full.length
  }

  if (lastIndex < content.length) {
    pushText(content.slice(lastIndex))
  }

  return tokens
}
