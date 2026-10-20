#!/usr/bin/env node

// Defer a plan item to the next period
// Usage: defer.mjs <id>

import { api, failResponse, parseArgs, json, requireId } from './lib/client.mjs'

const USAGE = `Usage: defer.mjs <id>`

const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const id = requireId(positional[0], USAGE)

const { status, body } = await api(`/api/plan-items/${id}/defer`, json({}))

if (status !== 201) {
  failResponse(status, body, 'Plan item deferral')
}

console.log(`✓ Item deferred: %${body.id} created in next period (original %${id} marked deferred)`)
