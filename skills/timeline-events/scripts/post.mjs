#!/usr/bin/env node

// Post an event to the weekly-reporter timeline API
// Usage: post.mjs "<content>" [--time <ISO8601-timestamp>]

import { api, json } from './lib/client.mjs'

let content = ''
let eventTime = ''

// Parse arguments
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--time') {
    eventTime = args[++i] ?? ''
  } else if (!content) {
    content = args[i]
  } else {
    console.error(`Error: unexpected argument '${args[i]}'`)
    console.error('Usage: post.mjs "<content>" [--time <ISO8601-timestamp>]')
    process.exit(1)
  }
}

if (!content) {
  console.error('Error: content is required')
  console.error('Usage: post.mjs "<content>" [--time <ISO8601-timestamp>]')
  process.exit(1)
}

// Build JSON payload
const payload = eventTime ? { content, eventTime } : { content }

const { status, body } = await api('/api/events', json(payload))

// Handle response
if (status === 200 || status === 201) {
  const eventId = body?.id
  if (eventId) {
    console.log(`✓ Event created: #${eventId}`)
  } else {
    console.log('✓ Event created successfully')
  }
  process.exit(0)
}

if (status >= 400 && status < 500) {
  console.error(`Error: Invalid request (HTTP ${status})`)
  const errorMsg = body?.error || body?.message
  if (errorMsg) {
    console.error(`Server says: ${errorMsg}`)
  }
  process.exit(1)
}

if (status >= 500) {
  console.error(`Error: Server error (HTTP ${status})`)
  console.error('Check the server logs for details')
  process.exit(1)
}

console.error(`Error: Unexpected response (HTTP ${status})`)
process.exit(1)
