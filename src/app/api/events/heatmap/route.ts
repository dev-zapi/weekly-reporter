import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { gte, desc } from 'drizzle-orm'
import { rawEvents } from '@/lib/db/schema'

// request 为必选：Next 运行时总是传入请求（withAuth 也从第一个参数取请求做
// 鉴权）。可选签名在 dev server 的增量类型生成（.next/dev/types，tsconfig 有
// include）里会报 `Request | undefined` 不满足 ParamCheck——注意 `next
// typegen`（.next/types）并不报这个，别用它来反证。
export const GET = withAuth(async function GET(request: Request) {
  try {
    const db = getDb()
    const days = Math.min(
      parseInt(
        new URL(request.url).searchParams.get('days') || '365'
      ) || 365,
      730
    )

    const now = new Date()
    const cutoff = new Date(now)
    cutoff.setDate(cutoff.getDate() - days)

    const events = await db
      .select({ eventTime: rawEvents.eventTime })
      .from(rawEvents)
      .where(gte(rawEvents.eventTime, cutoff))
      .orderBy(desc(rawEvents.eventTime))

    // Aggregate by local date
    const counts = new Map<string, number>()
    for (const event of events) {
      const date = new Date(event.eventTime)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }

    const data = Array.from(counts, ([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date))

    return NextResponse.json({ data })
  } catch (error) {
    console.error('Error fetching heatmap data:', error)
    return NextResponse.json(
      { error: 'Failed to fetch heatmap data', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
})
