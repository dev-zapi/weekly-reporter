#!/usr/bin/env node

// Update an event in the weekly-reporter timeline API
// Usage: update.mjs <id> [--content <text>] [--time <ISO8601>] [--important <true|false>]

import { api, json } from './lib/client.mjs'

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('Error: event ID is required')
  console.error('Usage: update.mjs <id> [--content <text>] [--time <ISO8601>] [--important <true|false>]')
  process.exit(1)
}

const eventId = parseInt(args[0])
if (isNaN(eventId)) {
  console.error(`Error: invalid event ID '${args[0]}'`)
  process.exit(1)
}

const body = {}

for (let i = 1; i < args.length; i++) {
  const flag = args[i]
  if (flag === '--content') {
    body.content = args[++i]
    if (!body.content) {
      console.error('Error: --content requires a value')
      process.exit(1)
    }
  } else if (flag === '--time') {
    body.eventTime = args[++i]
    if (!body.eventTime) {
      console.error('Error: --time requires a value')
      process.exit(1)
    }
  } else if (flag === '--important') {
    const val = args[++i]
    if (val === 'true') {
      body.isImportant = true
    } else if (val === 'false') {
      body.isImportant = false
    } else {
      console.error(`Error: --important must be 'true' or 'false', got '${val}'`)
      process.exit(1)
    }
  } else {
    console.error(`Error: unexpected argument '${flag}'`)
    console.error('Usage: update.mjs <id> [--content <text>] [--time <ISO8601>] [--important <true|false>]')
    process.exit(1)
  }
}

if (Object.keys(body).length === 0) {
  console.error('Error: at least one of --content, --time, --important is required')
  process.exit(1)
}

const { status, body: responseBody } = await api(`/api/events/${eventId}`, { ...json(body), method: 'PUT' })

if (status === 200) {
  console.log(`✓ Event #${eventId} updated`)
  process.exit(0)
}

if (status === 404) {
  console.error(`Error: Event #${eventId} not found`)
  process.exit(1)
}

if (status >= 400 && status < 500) {
  const errorMsg = responseBody?.error || responseBody?.message || `HTTP ${status}`
  console.error(`Error: ${errorMsg}`)
  process.exit(1)
}

if (status >= 500) {
  console.error(`Error: Server error (HTTP ${status})`)
  process.exit(1)
}

console.error(`Error: Unexpected response (HTTP ${status})`)
process.exit(1)
