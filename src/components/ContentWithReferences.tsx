'use client'

import { type ReactNode } from 'react'
import { REFERENCE_MATCH_REGEX } from '@/lib/references'

interface ContentWithReferencesProps {
  content: string
  isManual?: boolean
  onReferenceClick?: (referenceId: number) => void
}

export function ContentWithReferences({ content, isManual, onReferenceClick }: ContentWithReferencesProps) {
  // Only manual events participate in reference recognition (per spec).
  // Auto-collected events' content is rendered as plain text.
  if (!isManual) {
    return <>{content}</>
  }

  // Use matchAll to manually segment — avoids split() inserting captured
  // groups (the regex has two capture groups, which would produce bare
  // digit strings in the split result and cause duplicate rendering).
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  // Fresh regex instance per render to reset lastIndex.
  const regex = new RegExp(REFERENCE_MATCH_REGEX.source, REFERENCE_MATCH_REGEX.flags)

  for (const match of content.matchAll(regex)) {
    const matchStart = match.index!
    // Leading whitespace (captured by the boundary group) stays as plain text.
    const fullMatch = match[0]
    const idString = match[2]
    const leadingWs = fullMatch.slice(0, fullMatch.length - idString.length - 1) // all but the @<id>
    const id = Number.parseInt(idString, 10)

    // Text before this match.
    if (matchStart > lastIndex) {
      nodes.push(<span key={key++}>{content.slice(lastIndex, matchStart)}</span>)
    }

    // Skip @0 or other non-positive ids (matches server-side parser behavior).
    if (!Number.isFinite(id) || id <= 0) {
      nodes.push(<span key={key++}>{fullMatch}</span>)
    } else {
      if (leadingWs) {
        nodes.push(<span key={key++}>{leadingWs}</span>)
      }
      nodes.push(
        <button
          key={key++}
          type="button"
          className="text-primary underline decoration-dotted hover:decoration-solid cursor-pointer bg-transparent border-0 p-0 font-inherit text-inherit"
          onClick={(e) => {
            e.stopPropagation()
            onReferenceClick?.(id)
          }}
        >
          @{id}
        </button>,
      )
    }

    lastIndex = matchStart + fullMatch.length
  }

  // Trailing text after the last match.
  if (lastIndex < content.length) {
    nodes.push(<span key={key++}>{content.slice(lastIndex)}</span>)
  }

  // No matches at all — render the whole content.
  if (nodes.length === 0) {
    return <>{content}</>
  }

  return <>{nodes}</>
}
