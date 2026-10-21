import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getAIConfig, updateModelListCache } from '@/lib/ai/config'
import { fetchModelList } from '@/lib/ai/provider'
import type { AIProtocol, AIConfig } from '@/lib/db/schema'

export const GET = withAuth(async function GET() {
  try {
    const db = getDb()
    const config = await getAIConfig(db)

    if (!config) {
      return NextResponse.json(
        { error: 'AI is not configured', code: 'AI_NOT_CONFIGURED' },
        { status: 400 }
      )
    }

    if (config.protocol === 'anthropic') {
      return NextResponse.json({
        models: [],
        supported: false,
        message: 'The Anthropic protocol does not support automatic model discovery; enter a model name manually',
      })
    }

    const models = await fetchModelList(config)
    await updateModelListCache(db, models)

    return NextResponse.json({
      models,
      supported: true,
      cachedAt: new Date(),
    })
  } catch (error) {
    console.error('GET /api/settings/ai/models error:', error)
    const db = getDb()
    const config = await getAIConfig(db)
    const cachedModels = config?.modelListCache ?? []

    return NextResponse.json({
      models: cachedModels,
      supported: true,
      cached: cachedModels.length > 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const { protocol, apiUrl, apiKey } = body

    if (!apiUrl || !apiKey) {
      return NextResponse.json(
        { error: 'Enter an API URL and API key first', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }

    if (protocol === 'anthropic') {
      return NextResponse.json({
        models: [],
        supported: false,
        message: 'The Anthropic protocol does not support automatic model discovery; enter a model name manually',
      })
    }

    const tempConfig: AIConfig = {
      id: 0,
      protocol: (protocol as AIProtocol) ?? 'openai',
      apiUrl,
      apiKey,
      model: '',
      modelListCache: null,
      modelListCachedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const models = await fetchModelList(tempConfig)

    const db = getDb()
    const existingConfig = await getAIConfig(db)
    if (existingConfig && existingConfig.apiUrl === apiUrl) {
      await updateModelListCache(db, models)
    }

    return NextResponse.json({
      models,
      supported: true,
    })
  } catch (error) {
    console.error('POST /api/settings/ai/models error:', error)
    return NextResponse.json({
      models: [],
      supported: true,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
