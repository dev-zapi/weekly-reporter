#!/usr/bin/env node

// Delete an event from the weekly-reporter timeline API
// Usage: delete.mjs <id>

import { api } from './lib/client.mjs'

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('Error: event ID is required')
  console.error('Usage: delete.mjs <id>')
  process.exit(1)
}

const eventId = parseInt(args[0])
if (isNaN(eventId)) {
  console.error(`Error: invalid event ID '${args[0]}'`)
  process.exit(1)
}

const { status, body } = await api(`/api/events/${eventId}`, { method: 'DELETE' })

if (status === 204) {
  console.log(`✓ Event #${eventId} deleted`)
  process.exit(0)
}

if (status === 404) {
  console.error(`Error: Event #${eventId} not found`)
  process.exit(1)
}

if (status === 403) {
  const errorMsg = body?.error || 'Cannot delete non-manual event'
  console.error(`Error: ${errorMsg}`)
  process.exit(1)
}

if (status >= 400 && status < 500) {
  const errorMsg = body?.error || body?.message || `HTTP ${status}`
  console.error(`Error: ${errorMsg}`)
  process.exit(1)
}

if (status >= 500) {
  console.error(`Error: Server error (HTTP ${status})`)
  process.exit(1)
}

console.error(`Error: Unexpected response (HTTP ${status})`)
process.exit(1)
