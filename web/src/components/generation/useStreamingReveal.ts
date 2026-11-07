import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  appendRevealedMarkdown,
  finalizeStreamingMarkdown,
  type StreamingMarkdown,
} from '@/lib/generation/streaming-markdown'

export const REVEAL_INTERVAL_MS = 50
const REVEAL_CHARACTERS_PER_SECOND = 160
const FOLLOW_BOTTOM_THRESHOLD = 64

function emptyStreamingMarkdown(): StreamingMarkdown {
  return { markdownBlocks: [], pendingChunks: [] }
}

function takeCharacters(value: string, count: number): [string, string] {
  let end = 0
  let taken = 0
  for (const character of value) {
    if (taken === count) break
    end += character.length
    taken += 1
  }
  return [value.slice(0, end), value.slice(end)]
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface StreamingRevealHandle {
  liveText: StreamingMarkdown
  liveReasoning: string
  liveToolState: string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  handleTranscriptScroll: (event: React.UIEvent<HTMLDivElement>) => void
  queueLiveText: (text: string) => void
  queueLiveReasoning: (text: string) => void
  flushLiveReasoning: () => void
  waitForTextQueue: () => Promise<void>
  resetLiveOutput: () => void
  setLiveToolState: React.Dispatch<React.SetStateAction<string>>
  finalizeLiveText: () => void
}

export function useStreamingReveal({
  detail,
  streaming,
  liveUser,
}: {
  detail: { id: number } | null
  streaming: boolean
  liveUser: string
}): StreamingRevealHandle {
  const [liveReasoning, setLiveReasoning] = useState('')
  const [liveText, setLiveText] = useState<StreamingMarkdown>(emptyStreamingMarkdown)
  const [liveToolState, setLiveToolState] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const textQueueRef = useRef('')
  const textRevealFrameRef = useRef<number | null>(null)
  const lastTextRevealAtRef = useRef(0)
  const nextTextChunkIdRef = useRef(0)
  const textQueueDrainedRef = useRef<(() => void) | null>(null)
  const reasoningQueueRef = useRef('')
  const reasoningFlushTimerRef = useRef<number | null>(null)
  const shouldFollowTranscriptRef = useRef(true)
  const transcriptFollowFrameRef = useRef<number | null>(null)
  const autoScrollTopRef = useRef<number | null>(null)
  const initiallyScrolledSessionRef = useRef<number | null>(null)

  const revealTextChunk = useCallback((text: string) => {
    const id = nextTextChunkIdRef.current
    nextTextChunkIdRef.current += 1
    setLiveText((current) => appendRevealedMarkdown(current, { id, text }))
  }, [])

  const scheduleTextReveal = useCallback(() => {
    if (textRevealFrameRef.current !== null) return

    const reveal = (now: number) => {
      textRevealFrameRef.current = null
      if (!textQueueRef.current) {
        const resolve = textQueueDrainedRef.current
        textQueueDrainedRef.current = null
        resolve?.()
        return
      }

      const elapsed = lastTextRevealAtRef.current === 0
        ? REVEAL_INTERVAL_MS
        : now - lastTextRevealAtRef.current
      if (elapsed < REVEAL_INTERVAL_MS) {
        textRevealFrameRef.current = requestAnimationFrame(reveal)
        return
      }

      const backlogMultiplier = textQueueRef.current.length > REVEAL_CHARACTERS_PER_SECOND * 2
        ? Math.min(4, 1 + textQueueRef.current.length / (REVEAL_CHARACTERS_PER_SECOND * 2))
        : 1
      const characterCount = Math.max(1, Math.round((elapsed / 1_000) * REVEAL_CHARACTERS_PER_SECOND * backlogMultiplier))
      const [visibleText, remainingText] = takeCharacters(textQueueRef.current, characterCount)
      textQueueRef.current = remainingText
      lastTextRevealAtRef.current = now
      revealTextChunk(visibleText)
      textRevealFrameRef.current = requestAnimationFrame(reveal)
    }

    textRevealFrameRef.current = requestAnimationFrame(reveal)
  }, [revealTextChunk])

  const queueLiveText = useCallback((text: string) => {
    textQueueRef.current += text
    scheduleTextReveal()
  }, [scheduleTextReveal])

  const waitForTextQueue = useCallback(async () => {
    if (!textQueueRef.current && textRevealFrameRef.current === null) return
    await new Promise<void>((resolve) => {
      textQueueDrainedRef.current = resolve
      scheduleTextReveal()
    })
  }, [scheduleTextReveal])

  const cancelTextReveal = useCallback(() => {
    if (textRevealFrameRef.current !== null) cancelAnimationFrame(textRevealFrameRef.current)
    textRevealFrameRef.current = null
    textQueueRef.current = ''
    lastTextRevealAtRef.current = 0
    const resolve = textQueueDrainedRef.current
    textQueueDrainedRef.current = null
    resolve?.()
  }, [])

  const flushLiveReasoning = useCallback(() => {
    if (reasoningFlushTimerRef.current !== null) clearTimeout(reasoningFlushTimerRef.current)
    reasoningFlushTimerRef.current = null
    const text = reasoningQueueRef.current
    reasoningQueueRef.current = ''
    if (text) setLiveReasoning((current) => current + text)
  }, [])

  const queueLiveReasoning = useCallback((text: string) => {
    reasoningQueueRef.current += text
    if (reasoningFlushTimerRef.current !== null) return
    reasoningFlushTimerRef.current = window.setTimeout(flushLiveReasoning, REVEAL_INTERVAL_MS)
  }, [flushLiveReasoning])

  const resetLiveOutput = useCallback(() => {
    cancelTextReveal()
    if (reasoningFlushTimerRef.current !== null) clearTimeout(reasoningFlushTimerRef.current)
    reasoningFlushTimerRef.current = null
    reasoningQueueRef.current = ''
    nextTextChunkIdRef.current = 0
    setLiveReasoning('')
    setLiveText(emptyStreamingMarkdown())
    setLiveToolState('')
  }, [cancelTextReveal])

  const finalizeLiveText = useCallback(() => {
    setLiveText((current) => finalizeStreamingMarkdown(current))
  }, [])

  const cancelTranscriptFollow = useCallback(() => {
    if (transcriptFollowFrameRef.current !== null) cancelAnimationFrame(transcriptFollowFrameRef.current)
    transcriptFollowFrameRef.current = null
  }, [])

  const scheduleTranscriptFollow = useCallback(() => {
    if (!shouldFollowTranscriptRef.current || transcriptFollowFrameRef.current !== null) return

    const follow = () => {
      transcriptFollowFrameRef.current = null
      const transcript = transcriptRef.current
      if (!transcript || !shouldFollowTranscriptRef.current) return

      const target = Math.max(0, transcript.scrollHeight - transcript.clientHeight)
      const distance = target - transcript.scrollTop
      if (prefersReducedMotion() || Math.abs(distance) < 1) {
        autoScrollTopRef.current = target
        transcript.scrollTop = target
        return
      }

      const nextPosition = transcript.scrollTop + distance * 0.35
      autoScrollTopRef.current = nextPosition
      transcript.scrollTop = nextPosition
      transcriptFollowFrameRef.current = requestAnimationFrame(follow)
    }

    transcriptFollowFrameRef.current = requestAnimationFrame(follow)
  }, [])

  const handleTranscriptScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const transcript = event.currentTarget
    if (autoScrollTopRef.current !== null && Math.abs(transcript.scrollTop - autoScrollTopRef.current) < 1) return

    const distanceFromBottom = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
    shouldFollowTranscriptRef.current = distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD
    if (shouldFollowTranscriptRef.current) scheduleTranscriptFollow()
    else cancelTranscriptFollow()
  }, [cancelTranscriptFollow, scheduleTranscriptFollow])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript || !detail) return

    if (initiallyScrolledSessionRef.current !== detail.id) {
      const target = Math.max(0, transcript.scrollHeight - transcript.clientHeight)
      autoScrollTopRef.current = target
      transcript.scrollTop = target
      shouldFollowTranscriptRef.current = true
      initiallyScrolledSessionRef.current = detail.id
      return
    }

    scheduleTranscriptFollow()
  }, [detail, liveReasoning, liveText, liveToolState, liveUser, scheduleTranscriptFollow, streaming])

  useEffect(() => () => {
    cancelTextReveal()
    if (reasoningFlushTimerRef.current !== null) clearTimeout(reasoningFlushTimerRef.current)
    const resolve = textQueueDrainedRef.current
    textQueueDrainedRef.current = null
    resolve?.()
    cancelTranscriptFollow()
  }, [cancelTextReveal, cancelTranscriptFollow])

  return {
    liveText,
    liveReasoning,
    liveToolState,
    transcriptRef,
    handleTranscriptScroll,
    queueLiveText,
    queueLiveReasoning,
    flushLiveReasoning,
    waitForTextQueue,
    resetLiveOutput,
    setLiveToolState,
    finalizeLiveText,
  }
}
