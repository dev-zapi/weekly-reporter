'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect, useRef } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AIStyleRow } from '@/lib/db/schema'

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
  const abortControllerRef = useRef<AbortController | null>(null)

  // 加载风格列表
  useEffect(() => {
    apiFetch('/api/prompts/styles')
      .then(res => res.json())
      .then(data => {
        if (data.styles) {
          setStyles(data.styles.map((s: AIStyleRow) => ({
            key: s.key,
            label: s.label,
            systemPrompt: s.systemPrompt,
          })))
        }
      })
      .catch(err => console.error('Failed to fetch styles:', err))
  }, [])

  useEffect(() => {
    if (templateId) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      abortControllerRef.current = new AbortController()
      setLoading(true)

      const timeoutId = setTimeout(() => {
        apiFetch(`/api/templates/${templateId}`, {
          signal: abortControllerRef.current?.signal,
        })
          .then(res => {
            if (!res.ok) throw new Error('Failed to fetch template')
            return res.json()
          })
          .then(data => {
            if (data.template?.aiStyle) {
              setTemplateStyle(data.template.aiStyle)
            }
          })
          .catch(error => {
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
  const currentStyle = styles.find(s => s.key === currentValue)
  const currentLabel = currentStyle?.label ?? currentValue

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">
          AI style
        </label>
        <span className="text-xs text-muted-foreground">
          {currentLabel}
        </span>
      </div>
      <Select
        value={currentValue}
        onValueChange={(val) => onChange(val as string)}
        disabled={loading || styles.length === 0}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select an AI style" />
        </SelectTrigger>
        <SelectContent>
          {styles.map((style) => (
            <SelectItem key={style.key} value={style.key}>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{style.label}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                  {style.systemPrompt.slice(0, 40)}...
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
