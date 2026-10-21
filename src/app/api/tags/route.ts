import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { listTagsWithCounts, removeTagGlobally, TAG_CHARSET_REGEX } from '@/lib/tags'

export const GET = withAuth(async function GET() {
  try {
    const db = getDb()
    const tags = listTagsWithCounts(db)
    return NextResponse.json({ tags })
  } catch (error) {
    console.error('Error fetching tags:', error)
    return NextResponse.json({ error: 'Failed to fetch tags', code: 'FETCH_ERROR' }, { status: 500 })
  }
})

export const DELETE = withAuth(async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const name = searchParams.get('name') ?? ''
    if (!name || !TAG_CHARSET_REGEX.test(name)) {
      return NextResponse.json({ error: 'Invalid tag name', code: 'INVALID_TAG_NAME' }, { status: 400 })
    }
    const db = getDb()
    const removed = removeTagGlobally(db, name)
    return NextResponse.json({ removed })
  } catch (error) {
    console.error('Error removing tag:', error)
    return NextResponse.json({ error: 'Failed to remove tag', code: 'DELETE_ERROR' }, { status: 500 })
  }
})
