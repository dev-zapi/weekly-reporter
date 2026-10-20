import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { templates } from '@/lib/db/schema'
import { templateSchema } from '@/lib/validations'
import { OFFICIAL_TEMPLATES } from '@/lib/official-templates'

export const GET = withAuth(async function GET() {
  try {
    const db = getDb()
    console.log('Database obtained:', !!db)
    
    const userTemplates = await db.select().from(templates)
    console.log('User templates:', userTemplates)
    
    return NextResponse.json({
      official: OFFICIAL_TEMPLATES,
      user: userTemplates,
    })
  } catch (error) {
    console.error('GET /api/templates error:', error)
    return NextResponse.json(
      { error: 'Failed to load templates', code: 'FETCH_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})

export const POST = withAuth(async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    
    const validated = templateSchema.parse(body)
    
    const now = new Date()
    const result = await db.insert(templates).values({
      name: validated.name,
      content: validated.content,
      description: validated.description,
      tags: validated.tags,
      aiStyle: validated.aiStyle,
      createdAt: now,
      updatedAt: now,
    }).returning()
    
    return NextResponse.json({ template: result[0] }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: 'Failed to create template', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
})
