import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { listAIStyles, createAIStyle } from '@/lib/ai/styles'
import { aiStyleSchema } from '@/lib/validations'
import { ensureSeed } from '@/lib/ai/seed'

export const GET = withAuth(async function GET() {
  try {
    await ensureSeed()
    const styles = await listAIStyles()
    return NextResponse.json({ styles })
  } catch (error) {
    console.error('GET /api/prompts/styles error:', error)
    return NextResponse.json(
      { error: 'Failed to load styles', code: 'FETCH_ERROR' },
      { status: 500 },
    )
  }
})

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const validated = aiStyleSchema.parse(body)

    const style = await createAIStyle(validated)

    return NextResponse.json({ style }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: 'Failed to create style', code: 'CREATE_ERROR' },
      { status: 500 },
    )
  }
})
