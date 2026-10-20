import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { sentenceSnippets } from '@/lib/db/schema'

interface SnippetQuery {
  category?: string
}

export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')
    
    // Build query with optional category filter
    const snippets = category
      ? await db.select().from(sentenceSnippets).where(eq(sentenceSnippets.category, category))
      : await db.select().from(sentenceSnippets)
    
    return NextResponse.json({
      snippets,
    })
  } catch (error) {
    console.error('GET /api/snippets error:', error)
    return NextResponse.json(
      { error: 'Failed to load snippets', code: 'FETCH_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})

export const POST = withAuth(async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    
    // Validate required fields
    if (!body.content || typeof body.content !== 'string') {
      return NextResponse.json(
        { error: 'Content is required', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }
    
    // Validate content length
    if (body.content.length > 500) {
      return NextResponse.json(
        { error: 'Content must be 500 characters or fewer', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }
    
    // Validate category if provided
    if (body.category && typeof body.category !== 'string') {
      return NextResponse.json(
        { error: 'Category must be a string', code: 'INVALID_INPUT' },
        { status: 400 }
      )
    }
    
    const now = new Date()
    const result = await db.insert(sentenceSnippets).values({
      content: body.content,
      category: body.category || 'General',
      isBuiltIn: false, // User-created snippets are never built-in
      createdAt: now,
      updatedAt: now,
    }).returning()
    
    return NextResponse.json({ snippet: result[0] }, { status: 201 })
  } catch (error) {
    console.error('POST /api/snippets error:', error)
    return NextResponse.json(
      { error: 'Failed to create snippet', code: 'CREATE_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})
