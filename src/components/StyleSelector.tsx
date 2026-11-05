'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiFetch } from '@/lib/api-client'
import type { AIStyleRow } from '@/lib/db/schema'
import css from './library-configuration.module.css'

interface StyleSelectorProps {
  value?: string
  onChange: (style: string) => void
  templateId?: number
}

interface StyleItem {
  key: string
  label: string
  systemPrompt: string
}

export function StyleSelector({ value, onChange, templateId }: StyleSelectorProps) {
  const [styles, setStyles] = useState<StyleItem[]>([])
  const [templateStyle, setTemplateStyle] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [stylesLoading, setStylesLoading] = useState(true)
  const [stylesError, setStylesError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false

    apiFetch('/api/prompts/styles')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load AI styles')
        return response.json()
      })
      .then((data) => {
        if (cancelled) return
        setStyles((data.styles || []).map((style: AIStyleRow) => ({
          key: style.key,
          label: style.label,
          systemPrompt: style.systemPrompt,
        })))
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to fetch styles:', error)
        setStylesError('AI styles could not be loaded. Retry to restore style selection.')
      })
      .finally(() => {
        if (!cancelled) setStylesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  useEffect(() => {
    if (templateId) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      abortControllerRef.current = new AbortController()

      const timeoutId = setTimeout(() => {
        setLoading(true)
        apiFetch(`/api/templates/${templateId}`, {
          signal: abortControllerRef.current?.signal,
        })
          .then((response) => {
            if (!response.ok) throw new Error('Failed to fetch template')
            return response.json()
          })
          .then((data) => {
            if (data.template?.aiStyle) {
              setTemplateStyle(data.template.aiStyle)
            }
          })
          .catch((error) => {
            if (error.name !== 'AbortError') {
              console.error('Failed to fetch template style:', error)
            }
          })
          .finally(() => {
            setLoading(false)
            abortControllerRef.current = null
          })
      }, 300)

      return () => {
        clearTimeout(timeoutId)
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
        }
      }
    }
  }, [templateId])

  const currentValue = value || templateStyle || (styles[0]?.key ?? 'formal')
  const currentStyle = styles.find((style) => style.key === currentValue)
  const currentLabel = currentStyle?.label ?? currentValue

  return (
    <div className={css.styleSelector}>
      <div className={css.styleHeader}>
        <span className={css.styleLabel}>AI style</span>
        <span className={css.currentStyle}>{currentLabel}</span>
      </div>
      <Select
        value={currentValue}
        onValueChange={(nextValue) => onChange(nextValue as string)}
        disabled={loading || stylesLoading || styles.length === 0}
      >
        <SelectTrigger className={css.selectTrigger} aria-label="AI style">
          <SelectValue placeholder="Select an AI style" />
        </SelectTrigger>
        <SelectContent className={css.selectContent}>
          {styles.map((style) => (
            <SelectItem key={style.key} value={style.key} className={css.selectItem}>
              <span className={css.styleOption}>
                <span>{style.label}</span>
                <span>{style.systemPrompt.slice(0, 40)}...</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {stylesLoading && <span className={css.inlineStatus} role="status">Loading AI styles…</span>}
      {stylesError && (
        <div className={css.inlineError} role="alert">
          <span>{stylesError}</span>
          <button
            type="button"
            className={css.stateAction}
            onClick={() => {
              setStylesLoading(true)
              setStylesError(null)
              setReloadToken((token) => token + 1)
            }}
          >
            Retry loading styles
          </button>
        </div>
      )}
      {!stylesLoading && !stylesError && styles.length === 0 && (
        <span className={css.inlineStatus}>No AI styles are configured.</span>
      )}
    </div>
  )
}
