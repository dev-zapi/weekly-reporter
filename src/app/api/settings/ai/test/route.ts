import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getAIConfig } from '@/lib/ai/config'
import { testConnection } from '@/lib/ai/provider'

export const POST = withAuth(async function POST() {
  try {
    const db = getDb()
    const config = await getAIConfig(db)

    if (!config) {
      return NextResponse.json(
        { error: 'AI is not configured', code: 'AI_NOT_CONFIGURED' },
        { status: 400 }
      )
    }

    const result = await testConnection(config)

    return NextResponse.json({
      ok: result.ok,
      error: result.error,
    })
  } catch (error) {
    console.error('POST /api/settings/ai/test error:', error)
    return NextResponse.json(
      { error: 'Connection test failed', code: 'TEST_ERROR' },
      { status: 500 }
    )
  }
})
