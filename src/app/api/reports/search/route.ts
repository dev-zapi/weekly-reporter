import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { reportVariants, reports } from '@/lib/db/schema'

export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const query = (searchParams.get('q') || '').trim().toLowerCase()
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const allReports = await db.query.reports.findMany({ orderBy: [desc(reports.createdAt)] })
    const variants = await db.select().from(reportVariants)
    const variantsByReport = new Map<number, typeof variants>()
    for (const variant of variants) {
      const list = variantsByReport.get(variant.reportId) ?? []
      list.push(variant)
      variantsByReport.set(variant.reportId, list)
    }

    const results = allReports.filter((report) => {
      if (startDate && report.weekStart < startDate) return false
      if (endDate && report.weekEnd > endDate) return false
      if (!query) return true
      const text = [
        report.title,
        report.content,
        ...(variantsByReport.get(report.id) ?? []).flatMap((variant) => [variant.sourceDraft, variant.finalContent ?? '']),
      ].join('\n').toLowerCase()
      return text.includes(query)
    }).map((report) => ({
      ...report,
      variants: variantsByReport.get(report.id) ?? [],
    }))

    return NextResponse.json({ reports: results })
  } catch {
    return NextResponse.json({ error: 'Search failed', code: 'SEARCH_ERROR' }, { status: 500 })
  }
})
