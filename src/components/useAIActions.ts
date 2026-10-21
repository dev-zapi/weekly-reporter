'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { toast } from 'sonner'

export interface ErrorState {
  operation: string
  message: string
  canRetry: boolean
}

interface UseAIActionsProps {
  reportId: number
  templateId?: number
  styleOverride?: string
  onPolish?: (polishedContent: string) => void
  onExpand?: (expandedContent: string) => void
  onUnify?: (unifiedContent: string) => void
  getEditorContent?: () => string
}

type Operation = 'polish' | 'expand' | 'unify'

interface OperationConfig {
  endpoint: string
  buildBody: (content: string, props: UseAIActionsProps) => Record<string, unknown>
  extractResult: (data: Record<string, unknown>) => string
  callback: (props: UseAIActionsProps) => ((value: string) => void) | undefined
  successToast: string
  emptyToast: string
  fallbackError: string
  requiresContent: boolean
  clearSelectedEvent: boolean
}

const OPERATION_CONFIG: Record<Operation, OperationConfig> = {
  polish: {
    endpoint: '/api/ai/polish-event',
    buildBody: (content, props) => ({
      eventContent: content,
      templateId: props.templateId,
      styleOverride: props.styleOverride,
    }),
    extractResult: (data) => data.polishedContent as string,
    callback: (props) => props.onPolish,
    successToast: 'Polished successfully!',
    emptyToast: 'Select or enter text to polish',
    fallbackError: 'Polish service is temporarily unavailable',
    requiresContent: true,
    clearSelectedEvent: true,
  },
  expand: {
    endpoint: '/api/ai/expand-section',
    buildBody: (content, props) => ({
      content,
      templateId: props.templateId,
      styleOverride: props.styleOverride,
    }),
    extractResult: (data) => data.expandedContent as string,
    callback: (props) => props.onExpand,
    successToast: 'Expanded successfully!',
    emptyToast: 'Select or enter text to expand',
    fallbackError: 'Expansion service is temporarily unavailable',
    requiresContent: true,
    clearSelectedEvent: true,
  },
  unify: {
    endpoint: '/api/ai/unify-style',
    buildBody: (_content, props) => ({
      reportId: props.reportId,
      templateId: props.templateId,
      styleOverride: props.styleOverride,
    }),
    extractResult: (data) => data.unifiedContent as string,
    callback: (props) => props.onUnify,
    successToast: 'Style unified successfully!',
    emptyToast: '',
    fallbackError: 'Style service is temporarily unavailable',
    requiresContent: false,
    clearSelectedEvent: false,
  },
}

export function useAIActions(props: UseAIActionsProps) {
  const { getEditorContent } = props

  const [selectedEvent, setSelectedEvent] = useState('')
  const [loading, setLoading] = useState<Operation | null>(null)
  const [error, setError] = useState<ErrorState | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const errorRef = useRef<ErrorState | null>(null)

  useEffect(() => {
    errorRef.current = error
  }, [error])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  const getContentToProcess = useCallback(() => {
    if (selectedEvent.trim()) {
      return selectedEvent
    }
    if (getEditorContent) {
      const editorContent = getEditorContent()
      if (editorContent.trim()) {
        return editorContent
      }
    }
    return ''
  }, [selectedEvent, getEditorContent])

  const run = useCallback(async (operation: Operation) => {
    const config = OPERATION_CONFIG[operation]

    const content = config.requiresContent ? getContentToProcess() : ''
    if (config.requiresContent && !content.trim()) {
      toast.error(config.emptyToast)
      return
    }

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // Create new AbortController
    abortControllerRef.current = new AbortController()

    setLoading(operation)
    setError(null)

    try {
      const response = await apiFetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config.buildBody(content, props)),
        signal: abortControllerRef.current.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: config.fallbackError }))
        throw new Error((errorData as { error?: string }).error || config.fallbackError)
      }

      const data = (await response.json()) as Record<string, unknown>
      toast.success(config.successToast)

      const cb = config.callback(props)
      if (cb) {
        cb(config.extractResult(data))
      }

      if (config.clearSelectedEvent) {
        setSelectedEvent('')
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }

      const errorMessage = err instanceof Error ? err.message : 'Network error. Check your connection.'
      const newError: ErrorState = {
        operation,
        message: errorMessage,
        canRetry: true,
      }
      setError(newError)
      toast.error(errorMessage)
      console.error(`${operation} error:`, err)
    } finally {
      setLoading(null)
      abortControllerRef.current = null
    }
  }, [props, getContentToProcess])

  const retry = useCallback(() => {
    const currentError = errorRef.current
    if (!currentError) return
    setError(null)
    const op = currentError.operation as Operation
    if (op === 'polish' || op === 'expand' || op === 'unify') {
      run(op)
    }
  }, [run])

  return {
    selectedEvent,
    setSelectedEvent,
    loading,
    error,
    run,
    retry,
  }
}
