import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { previewReportSourceDrafts } from '@/lib/reports/service'
import { reportWeekSchema } from '@/lib/validations'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const input = reportWeekSchema.parse(await request.json())
    const variants = await previewReportSourceDrafts(input)
    return NextResponse.json({ variants })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Validation failed', code: 'VALIDATION_ERROR', details: error },
        { status: 400 },
      )
    }
    console.error('[/api/reports/preview] POST error:', error)
    return NextResponse.json(
      { error: 'Failed to preview source draft', code: 'PREVIEW_ERROR' },
      { status: 500 },
    )
  }
})
