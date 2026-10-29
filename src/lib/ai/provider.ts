import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { AIConfig } from '@/lib/db/schema'
import { outboundTraceHeaders } from '@/lib/trace/context'

/** Internal transport markers used only to preserve explicit vendor reasoning. */
export const COMPAT_REASONING_START = '\u0000weekly-reasoning-start\u0000'
export const COMPAT_REASONING_END = '\u0000weekly-reasoning-end\u0000'

/** 合并 outbound trace 头到既有请求头（对方若是 Headers 也能正确展开）。 */
function withTraceHeaders(existing: HeadersInit | undefined): HeadersInit {
  const headers = new Headers(existing)
  for (const [key, value] of Object.entries(outboundTraceHeaders())) {
    headers.set(key, value)
  }
  return headers
}

function createReasoningCompatibleFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, headers: withTraceHeaders(init?.headers) })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) return response

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let pending = ''
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${normalizeReasoningSseLine(line)}\n`))
        }
      },
      flush(controller) {
        if (pending) controller.enqueue(encoder.encode(normalizeReasoningSseLine(pending)))
      },
    })

    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/** 普通 transport：合并 outbound trace 头后直接调原生 fetch。 */
function tracedFetch(): typeof fetch {
  return async (input, init) => {
    return fetch(input, { ...init, headers: withTraceHeaders(init?.headers) })
  }
}

function normalizeReasoningSseLine(line: string): string {
  if (!line.startsWith('data:')) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return line
  try {
    const value = JSON.parse(payload) as {
      choices?: Array<{ delta?: Record<string, unknown> }>
    }
    const delta = value.choices?.[0]?.delta
    if (!delta) return line
    const reasoningKey = ['reasoning_content', 'reasoning', 'thinking'].find((key) => typeof delta[key] === 'string')
    if (!reasoningKey) return line
    const reasoning = delta[reasoningKey]
    delete delta[reasoningKey]
    const content = typeof delta.content === 'string' ? delta.content : ''
    delta.content = `${COMPAT_REASONING_START}${reasoning as string}${COMPAT_REASONING_END}${content}`
    return `data: ${JSON.stringify(value)}`
  } catch {
    return line
  }
}

export class AIConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIConfigError'
  }
}

export function createModelFromConfig(config: AIConfig): LanguageModel {
  if (config.protocol === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.apiUrl || undefined,
      fetch: tracedFetch(),
    })
    return anthropic(config.model)
  }

  const openai = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.apiUrl,
    fetch: config.protocol === 'openai-compatible' ? createReasoningCompatibleFetch() : tracedFetch(),
  })

  // OpenAI Compatible uses chat() for APIs that only support Chat Completions API
  if (config.protocol === 'openai-compatible') {
    return openai.chat(config.model)
  }

  // OpenAI official uses default Responses API
  return openai(config.model)
}

export async function fetchModelList(config: AIConfig): Promise<string[]> {
  if (config.protocol === 'anthropic') {
    return []
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const url = config.apiUrl.replace(/\/+$/, '') + '/models'
    const response = await fetch(url, {
      headers: withTraceHeaders({
        Authorization: `Bearer ${config.apiKey}`,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const models = data.data?.map((m: { id: string }) => m.id) ?? []
    return models.sort()
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function testConnection(config: AIConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const model = createModelFromConfig(config)
    const { generateText } = await import('ai')
    await generateText({
      model,
      prompt: 'Hi',
      maxOutputTokens: 5,
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
