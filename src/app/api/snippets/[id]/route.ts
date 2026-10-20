import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { sentenceSnippets } from '@/lib/db/schema'

export const DELETE = withAuth(async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const db = getDb()
    const { id } = await params
    const snippetId = parseInt(id, 10)
    
    // Validate ID
    if (isNaN(snippetId)) {
      return NextResponse.json(
        { error: 'Invalid snippet ID', code: 'INVALID_ID' },
        { status: 400 }
      )
    }
    
    // Check if snippet exists and get its details
    const snippet = await db.query.sentenceSnippets.findFirst({
      where: eq(sentenceSnippets.id, snippetId),
    })
    
    if (!snippet) {
      return NextResponse.json(
        { error: 'Snippet not found', code: 'NOT_FOUND' },
        { status: 404 }
      )
    }
    
    // Check if it's a built-in snippet
    if (snippet.isBuiltIn) {
      return NextResponse.json(
        { error: 'Built-in snippets cannot be deleted', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }
    
    // Delete the snippet
    await db.delete(sentenceSnippets).where(eq(sentenceSnippets.id, snippetId))
    
    return NextResponse.json({
      message: 'Snippet deleted successfully',
    })
  } catch (error) {
    console.error('DELETE /api/snippets/[id] error:', error)
    return NextResponse.json(
      { error: 'Failed to delete snippet', code: 'DELETE_ERROR', details: String(error) },
      { status: 500 }
    )
  }
})
