import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { tagRenameSchema } from '@/lib/validations'
import { renameTagGlobally } from '@/lib/tags'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const result = tagRenameSchema.safeParse(body)
    if (!result.success) {
      const issues = result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
      return NextResponse.json(
        { error: 'Validation failed', code: 'VALIDATION_ERROR', details: { issues } },
        { status: 400 },
      )
    }
    const db = getDb()
    const { eventsUpdated, merged } = renameTagGlobally(db, result.data.from, result.data.to)
    return NextResponse.json({ eventsUpdated, merged })
  } catch (error) {
    console.error('Error renaming tag:', error)
    return NextResponse.json({ error: 'Failed to rename tag', code: 'RENAME_ERROR' }, { status: 500 })
  }
})
