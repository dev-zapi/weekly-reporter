import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { templates } from '@/lib/db/schema'
import { templateSchema } from '@/lib/validations'
import { eq } from 'drizzle-orm'

export const GET = withAuth(async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const template = await db.select().from(templates).where(eq(templates.id, parseInt(id)))
    
    if (template.length === 0) {
      return NextResponse.json(
        { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({ template: template[0] })
  } catch {
    return NextResponse.json(
      { error: 'Failed to load template', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
})

export const PUT = withAuth(async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const body = await request.json()
    
    const template = await db.select().from(templates).where(eq(templates.id, parseInt(id)))
    
    if (template.length === 0) {
      return NextResponse.json(
        { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      )
    }
    
    const styleOnlyUpdate = Object.keys(body).every((key) => key === 'aiStyle')
    let values: Partial<typeof templates.$inferInsert>
    if (styleOnlyUpdate) {
      const validated = templateSchema.pick({ aiStyle: true }).parse(body)
      values = { aiStyle: validated.aiStyle, updatedAt: new Date() }
    } else {
      const validated = templateSchema.parse(body)
      values = {
        name: validated.name,
        content: validated.content,
        description: validated.description,
        tags: validated.tags,
        aiStyle: validated.aiStyle ?? template[0].aiStyle,
        updatedAt: new Date(),
      }
    }

    const updated = await db.update(templates)
      .set(values)
      .where(eq(templates.id, parseInt(id)))
      .returning()
    
    return NextResponse.json({ template: updated[0] })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to update template', code: 'UPDATE_ERROR' },
      { status: 500 }
    )
  }
})

export const DELETE = withAuth(async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const template = await db.select().from(templates).where(eq(templates.id, parseInt(id)))
    
    if (template.length === 0) {
      return NextResponse.json(
        { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 404 }
      )
    }
    
    await db.delete(templates).where(eq(templates.id, parseInt(id)))
    
    return NextResponse.json({ success: true, message: 'Template deleted' })
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete template', code: 'DELETE_ERROR' },
      { status: 500 }
    )
  }
})
