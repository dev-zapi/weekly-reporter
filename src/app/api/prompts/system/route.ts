import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { systemPrompts } from '@/lib/db/schema'
import { systemPromptSchema } from '@/lib/validations'
import { ensureSeed } from '@/lib/ai/seed'
import { eq } from 'drizzle-orm'

export const GET = withAuth(async function GET() {
  try {
    await ensureSeed()
    const db = getDb()
    const prompts = await db.select().from(systemPrompts).orderBy(systemPrompts.key)

    return NextResponse.json({ prompts })
  } catch (error) {
    console.error('GET /api/prompts/system error:', error)
    return NextResponse.json(
      { error: 'Failed to load system prompts', code: 'FETCH_ERROR' },
      { status: 500 },
    )
  }
})

export const PUT = withAuth(async function PUT(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    const validated = systemPromptSchema.parse(body)
    const key = body.key

    if (!key || !['check', 'score', 'generate'].includes(key)) {
      return NextResponse.json(
        { error: 'Invalid prompt key', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }

    const now = new Date()
    const existing = await db.select().from(systemPrompts).where(eq(systemPrompts.key, key))

    if (existing.length === 0) {
      return NextResponse.json(
        { error: 'System prompt not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    await db.update(systemPrompts)
      .set({ promptText: validated.promptText, updatedAt: now })
      .where(eq(systemPrompts.key, key))

    const updated = await db.select().from(systemPrompts).where(eq(systemPrompts.key, key))

    return NextResponse.json({ prompt: updated[0] })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: 'Failed to update system prompt', code: 'UPDATE_ERROR' },
      { status: 500 },
    )
  }
})
