import { z } from 'zod'
import type { AIStyleRow } from '@/lib/db/schema'

export interface StyleFormData {
  key: string
  label: string
  systemPrompt: string
  temperature: number
  detailLevel: string
  resultOriented: string
  isDefault: boolean
}

const RANDOM_WORDS = [
  'nova', 'apex', 'zen', 'flux', 'core', 'sage', 'echo', 'pulse',
  'spark', 'wave', 'beam', 'dash', 'glow', 'prism', 'forge', 'rift',
  'swift', 'crisp', 'pure', 'bold', 'keen', 'vivid', 'calm', 'dusk',
]

const draftSchema = z.object({
  version: z.literal(1),
  form: z.object({
    key: z.string().max(50),
    label: z.string().max(50),
    systemPrompt: z.string().max(5000),
    temperature: z.number().min(0).max(2),
    detailLevel: z.string(),
    resultOriented: z.string(),
    isDefault: z.boolean(),
  }),
})

export function randomStyleKey(): string {
  return RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)]
}

export function emptyStyleForm(key = ''): StyleFormData {
  return {
    key,
    label: '',
    systemPrompt: '',
    temperature: 0.3,
    detailLevel: 'medium',
    resultOriented: 'medium',
    isDefault: false,
  }
}

export function formForAIStyle(style: AIStyleRow): StyleFormData {
  return {
    key: style.key,
    label: style.label,
    systemPrompt: style.systemPrompt,
    temperature: Number.parseFloat(style.temperature),
    detailLevel: style.detailLevel ?? 'medium',
    resultOriented: style.resultOriented ?? 'medium',
    isDefault: style.isDefault,
  }
}

export function aiStyleDraftKey(mode: 'new' | 'edit', id?: number): string {
  return `weekly-reporter.ai-style-draft.${mode === 'new' ? 'new' : `edit.${id}`}`
}

export function parseAIStyleDraft(raw: string | null): StyleFormData | null {
  if (!raw) return null
  try {
    const parsed = draftSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.form : null
  } catch {
    return null
  }
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readAIStyleDraft(key: string, storage = browserStorage()): StyleFormData | null {
  if (!storage) return null
  try {
    return parseAIStyleDraft(storage.getItem(key))
  } catch {
    return null
  }
}

export function writeAIStyleDraft(key: string, form: StyleFormData, storage = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify({ version: 1, form }))
    return true
  } catch {
    return false
  }
}

export function clearAIStyleDraft(key: string, storage = browserStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Storage denial must not block saving or navigation.
  }
}
