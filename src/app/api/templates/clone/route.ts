import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { templates } from '@/lib/db/schema'
import { OFFICIAL_TEMPLATES } from '@/lib/official-templates'
import { cloneTemplateSchema } from '@/lib/validations'
import { eq } from 'drizzle-orm'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    const validated = cloneTemplateSchema.parse(body)
    
    let sourceTemplate: { name: string; content: string; id: string; aiStyle?: string } | null = null
    
    // 根据sourceId前缀判断来源
    if (validated.sourceId.startsWith('official-')) {
      const officialTemplate = OFFICIAL_TEMPLATES.find(t => t.id === validated.sourceId)
      sourceTemplate = officialTemplate || null
    } else if (validated.sourceId.startsWith('user-')) {
      const userId = parseInt(validated.sourceId.replace('user-', ''))
      const userTemplate = await db.select().from(templates).where(eq(templates.id, userId))
      if (userTemplate.length > 0) {
        sourceTemplate = {
          id: validated.sourceId,
          name: userTemplate[0].name,
          content: userTemplate[0].content,
          aiStyle: userTemplate[0].aiStyle,
        }
      }
    }
    
    if (!sourceTemplate) {
      return NextResponse.json(
        { error: 'Source template not found', code: 'TEMPLATE_NOT_FOUND' },
        { status: 400 }
      )
    }
    
    const now = new Date()
    const newTemplate = {
      name: validated.name || sourceTemplate.name,
      content: validated.content || sourceTemplate.content,
      description: undefined,
      tags: undefined,
      sourceTemplateId: validated.sourceId,
      aiStyle: sourceTemplate.aiStyle,
      createdAt: now,
      updatedAt: now,
    }
    
    const result = await db.insert(templates).values(newTemplate).returning()
    
    return NextResponse.json({
      template: result[0],
      message: 'Template cloned successfully',
    }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Failed to clone template', code: 'CLONE_ERROR' }, { status: 500 })
  }
})
