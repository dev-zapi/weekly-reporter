#!/usr/bin/env node

// Query events from the weekly-reporter timeline API
// Usage: query.mjs [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD>] [--week-end <YYYY-MM-DD>]
//                  [--tags <tag1,tag2>] [--source <manual|auto>] [--limit <n>]

import { api } from './lib/client.mjs'

const args = process.argv.slice(2)
const params = new URLSearchParams()

for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  if (flag === '--date' || flag === '--week-start' || flag === '--week-end' ||
      flag === '--tags' || flag === '--source' || flag === '--limit') {
    const value = args[++i]
    if (!value) {
      console.error(`Error: ${flag} requires a value`)
      process.exit(1)
    }
    const keyMap = {
      '--date': 'date',
      '--week-start': 'weekStart',
      '--week-end': 'weekEnd',
      '--tags': 'tags',
      '--source': 'source',
      '--limit': 'limit',
    }
    params.set(keyMap[flag], value)
  } else {
    console.error(`Error: unexpected argument '${flag}'`)
    console.error('Usage: query.mjs [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD>] [--week-end <YYYY-MM-DD>]')
    console.error('                  [--tags <tag1,tag2>] [--source <manual|auto>] [--limit <n>]')
    process.exit(1)
  }
}

const path = params.size > 0 ? `/api/events?${params}` : '/api/events'

const { status, body, bodyParsed } = await api(path)

if (!bodyParsed) {
  console.error(`Error: Unexpected response (HTTP ${status})`)
  process.exit(1)
}

if (status !== 200) {
  const errorMsg = body?.error || body?.message || `HTTP ${status}`
  console.error(`Error: ${errorMsg}`)
  process.exit(1)
}

const events = body?.events ?? []
const hasMore = body?.hasMore ?? false
const nextCursor = body?.nextCursor

if (events.length === 0) {
  console.log('No events found.')
  process.exit(0)
}

// Format output: one event per line
for (const event of events) {
  const id = `#${event.id}`
  const time = event.eventTime ? new Date(event.eventTime).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : '?'
  const source = event.source || '?'
  const important = event.isImportant ? ' ★' : ''
  const content = (event.content || '').replace(/\n/g, ' ↵ ')
  const tags = event.metadata?.tags?.length ? ` [${event.metadata.tags.join(', ')}]` : ''
  console.log(`${id.padEnd(6)} ${time}  ${source.padEnd(6)}${important} ${content}${tags}`)
}

// Pagination info
const summary = `${events.length} event${events.length !== 1 ? 's' : ''}`
if (hasMore && nextCursor) {
  console.log(`\n${summary} (hasMore — cursorId=${nextCursor.id}&cursorTime=${nextCursor.eventTime})`)
} else {
  console.log(`\n${summary}`)
}
