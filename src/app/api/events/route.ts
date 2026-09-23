import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { desc, eq, between, sql, inArray } from 'drizzle-orm'
import { rawEvents, eventTags } from '@/lib/db/schema'
import { parseTags, syncEventTags, TAG_CHARSET_REGEX } from '@/lib/tags'
import { parseReferences, syncEventReferences } from '@/lib/references'

export async function GET(request: Request) {
  try {
    const db = getDb()
    const { searchParams } = new URL(request.url)
    const weekStart = searchParams.get('weekStart')
    const weekEnd = searchParams.get('weekEnd')
    const dateParam = searchParams.get('date')
    const sourceParam = searchParams.get('source')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)
    const cursorId = searchParams.get('cursorId') ? parseInt(searchParams.get('cursorId')!) : null
    const cursorTime = searchParams.get('cursorTime') ? parseInt(searchParams.get('cursorTime')!) : null
    const tagsParam = searchParams.get('tags')

    let filterTags: string[] = []
    if (tagsParam) {
      filterTags = tagsParam.split(',').map(t => t.trim()).filter(t => TAG_CHARSET_REGEX.test(t))
    }

    const conditions: ReturnType<typeof eq>[] = []

    // Tag filtering is full-volume (user chose 全量) — skip date/week conditions when tags are present.
    if (filterTags.length === 0) {
      if (weekStart && weekEnd) {
        const start = new Date(weekStart)
        const end = new Date(weekEnd)
        end.setHours(23, 59, 59, 999)
        conditions.push(between(rawEvents.eventTime, start, end))
      }

      if (dateParam) {
        const dateObj = new Date(dateParam + 'T00:00:00')
        if (!isNaN(dateObj.getTime())) {
          const dayStart = new Date(dateObj)
          const dayEnd = new Date(dateObj)
          dayEnd.setHours(23, 59, 59, 999)
          conditions.push(between(rawEvents.eventTime, dayStart, dayEnd))
        }
      }
    } else {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${eventTags} WHERE ${eventTags.eventId} = ${rawEvents.id} AND ${inArray(eventTags.tagName, filterTags)})`
      )
    }

    // source 筛选：manual = 手动, auto = 非手动（自动采集）
    if (sourceParam) {
      if (sourceParam === 'manual') {
        conditions.push(eq(rawEvents.source, 'manual'))
      } else if (sourceParam === 'auto') {
        conditions.push(sql`${rawEvents.source} != 'manual'`)
      }
    }

    // 游标分页：基于 (eventTime, id) 复合排序
    // SQLite 中 eventTime 存为秒级时间戳，cursorTime 是毫秒，需要转换
    if (cursorId !== null && cursorTime !== null) {
      const cursorTimeSec = Math.floor(cursorTime / 1000)
      conditions.push(
        sql`((${rawEvents.eventTime} < ${cursorTimeSec}) OR (${rawEvents.eventTime} = ${cursorTimeSec} AND ${rawEvents.id} < ${cursorId}))`
      )
    }

    let query = db.select()
      .from(rawEvents)
      .$dynamic()
    if (conditions.length > 0) {
      query = query.where(sql.join(conditions, sql` AND `))
    }
    const events = await query
      .orderBy(desc(rawEvents.eventTime))
      .limit(limit + 1)

    // Fetch all sources to get aliases
    const allSources = await db.query.collectSources.findMany()
    const sourceAliasesMap = new Map(
      allSources.map(s => [s.id, (s.config.aliases as string[]) || []])
    )

    // Append aliases to events
    const eventsWithAliases = events.map(event => {
      const sourceId = event.metadata?.sourceId
      const aliases = sourceId ? sourceAliasesMap.get(sourceId) || [] : []
      return {
        ...event,
        metadata: {
          ...event.metadata,
          aliases,
        },
      }
    })

    const hasMore = events.length > limit
    const page = eventsWithAliases.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = last ? { id: last.id, eventTime: last.eventTime.getTime() } : null

    return NextResponse.json({ events: page, nextCursor, hasMore })
  } catch (error) {
    console.error('Error fetching events:', error)
    return NextResponse.json(
      { error: 'Failed to fetch events', code: 'FETCH_ERROR' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb()
    const body = await request.json()
    const { content, eventTime } = body
    
    // Validate content is required and non-empty
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Content is required', code: 'INVALID_CONTENT' },
        { status: 400 }
      )
    }
    
    // Validate eventTime format if provided
    if (eventTime !== undefined && eventTime !== null) {
      const parsedDate = new Date(eventTime)
      if (isNaN(parsedDate.getTime())) {
        return NextResponse.json(
          { error: 'Invalid event time', code: 'INVALID_EVENT_TIME' },
          { status: 400 }
        )
      }
    }
    
    const now = new Date()
    const newEvent = db.transaction((tx) => {
      const event = tx.insert(rawEvents).values({
        content,
        eventTime: eventTime ? new Date(eventTime) : now,
        source: 'manual',
        isImportant: false,
        createdAt: now,
        updatedAt: now,
      }).returning().get()
      syncEventTags(tx, event.id, parseTags(content))
      syncEventReferences(tx, event.id, parseReferences(content))
      return event
    })
    return NextResponse.json(newEvent, { status: 201 })
  } catch (error) {
    console.error('Error creating event:', error)
    return NextResponse.json(
      { error: 'Failed to create event', code: 'CREATE_ERROR' },
      { status: 500 }
    )
  }
}
