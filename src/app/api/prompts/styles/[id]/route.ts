import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { aiStyles } from '@/lib/db/schema'
import { updateAIStyle, deleteAIStyle, setDefaultStyle } from '@/lib/ai/styles'
import { aiStyleSchema } from '@/lib/validations'
import { eq } from 'drizzle-orm'

export const GET = withAuth(async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb()
    const { id } = await params
    const result = await db.select().from(aiStyles).where(eq(aiStyles.id, parseInt(id)))

    if (result.length === 0) {
      return NextResponse.json(
        { error: 'Style not found', code: 'STYLE_NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json({ style: result[0] })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load style', code: 'FETCH_ERROR' },
      { status: 500 },
    )
  }
})

export const PUT = withAuth(async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json()

    const validated = aiStyleSchema.partial().parse(body)

    const style = await updateAIStyle(parseInt(id), validated)

    if (!style) {
      return NextResponse.json(
        { error: 'Style not found', code: 'STYLE_NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json({ style })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: 'Failed to update style', code: 'UPDATE_ERROR' },
      { status: 500 },
    )
  }
})

export const DELETE = withAuth(async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await deleteAIStyle(parseInt(id))

    if (!result.success) {
      const status = result.error === 'Style not found' ? 404 : 400
      return NextResponse.json(
        { error: result.error, code: 'DELETE_ERROR' },
        { status },
      )
    }

    return NextResponse.json({ success: true, message: 'Style deleted' })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete style', code: 'DELETE_ERROR' },
      { status: 500 },
    )
  }
})

/** PATCH: 设为默认风格 */
export const PATCH = withAuth(async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const style = await setDefaultStyle(parseInt(id))

    if (!style) {
      return NextResponse.json(
        { error: 'Style not found', code: 'STYLE_NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json({ style, message: 'Style set as default' })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to set default style', code: 'UPDATE_ERROR' },
      { status: 500 },
    )
  }
})
