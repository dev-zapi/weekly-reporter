import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { reports, reportVariants } from '@/lib/db/schema'
import { createReportSchema } from '@/lib/validations'
import { createReportWithSourceDrafts } from '@/lib/reports/service'

export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10))
    const pageSize = Math.max(1, Number.parseInt(searchParams.get('pageSize') || '10', 10))
    const offset = (page - 1) * pageSize

    const allReports = await db.query.reports.findMany({
      orderBy: [desc(reports.createdAt)],
      limit: pageSize,
      offset,
    })
    let variants: Array<typeof reportVariants.$inferSelect> = []
    try {
      const variantRows = allReports.length > 0 ? await db.select().from(reportVariants) : []
      variants = variantRows ?? []
    } catch {
      // Compatibility with legacy callers/mocks that only expose reports.
      variants = []
    }
    const variantByReport = new Map<number, typeof variants>()
    for (const variant of variants) {
      const list = variantByReport.get(variant.reportId) ?? []
      list.push(variant)
      variantByReport.set(variant.reportId, list)
    }

    const results = allReports.map((report) => {
      const personal = variantByReport.get(report.id)?.find((variant) => variant.variant === 'personal')
      return {
        ...report,
        // Compatibility fields used by the existing report list.
        content: personal?.finalContent ?? personal?.sourceDraft ?? report.content,
        variants: variantByReport.get(report.id) ?? [],
      }
    })

    let total = allReports.length
    try {
      const totalRows = await db.select({ id: reports.id }).from(reports)
      total = totalRows?.length ?? total
    } catch {
      // Keep the page result usable for legacy database adapters.
    }
    return NextResponse.json({ reports: results, total, page, pageSize })
  } catch (error) {
    console.error('[/api/reports] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch reports', code: 'FETCH_ERROR' }, { status: 500 })
  }
})

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const validated = createReportSchema.parse(body)
    const result = await createReportWithSourceDrafts(validated)
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: error }, { status: 400 })
    }
    console.error('[/api/reports] POST error:', error)
    return NextResponse.json({ error: 'Failed to create report', code: 'CREATE_ERROR' }, { status: 500 })
  }
})
