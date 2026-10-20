#!/usr/bin/env node

// Delete a plan item
// Usage: delete.mjs <id>

import { api, failResponse, parseArgs, requireId } from './lib/client.mjs'

const USAGE = `Usage: delete.mjs <id>`

const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const id = requireId(positional[0], USAGE)

const { status, body } = await api(`/api/plan-items/${id}`, { method: 'DELETE' })

if (status === 204) {
  console.log(`✓ Item %${id} deleted`)
  process.exit(0)
}

failResponse(status, body, 'Plan item deletion')
