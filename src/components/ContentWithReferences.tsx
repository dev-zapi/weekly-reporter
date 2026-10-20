'use client'

import { type ReactNode } from 'react'
import { segmentContentTokens } from '@/lib/content-tokens'

interface ContentWithReferencesProps {
  content: string
  isManual?: boolean
  onReferenceClick?: (referenceId: number) => void
  onPlanReferenceClick?: (planItemId: number) => void
}

export function ContentWithReferences({
  content,
  isManual,
  onReferenceClick,
  onPlanReferenceClick,
}: ContentWithReferencesProps) {
  // Only manual events participate in reference recognition (per spec).
  // Auto-collected events' content is rendered as plain text.
  if (!isManual) {
    return <>{content}</>
  }

  const tokens = segmentContentTokens(content)

  // No reference tokens — render the raw content without extra spans.
  if (!tokens.some((token) => token.type !== 'text')) {
    return <>{content}</>
  }

  const nodes: ReactNode[] = []
  let key = 0

  for (const token of tokens) {
    if (token.type === 'text') {
      nodes.push(<span key={key++}>{token.text}</span>)
      continue
    }

    const id = token.id
    const isPlanReference = token.type === 'plan-reference'
    nodes.push(
      <button
        key={key++}
        type="button"
        className="text-primary underline decoration-dotted hover:decoration-solid cursor-pointer bg-transparent border-0 p-0 font-inherit text-inherit"
        onClick={(e) => {
          e.stopPropagation()
          if (isPlanReference) {
            onPlanReferenceClick?.(id)
          } else {
            onReferenceClick?.(id)
          }
        }}
      >
        {isPlanReference ? '%' : '@'}
        {id}
      </button>,
    )
  }

  return <>{nodes}</>
}
