#!/usr/bin/env node

// Update a plan item
// Usage: update.mjs <id> [--text <text>] [--status <status>] [--project <work|personal>] [--position <n>] [--parent <itemId>]

import { api, fail, failResponse, parseArgs, jsonPut, requireId, requireStatus, requireProjectScope } from './lib/client.mjs'

const USAGE = `Usage: update.mjs <id> [--text <text>] [--status <status>] [--project <work|personal>] [--position <n>] [--parent <itemId>]`

const { flags, positional } = parseArgs(process.argv.slice(2), {
  '--text': 'value',
  '--status': 'value',
  '--project': 'value',
  '--position': 'value',
  '--parent': 'value',
}, USAGE)

const id = requireId(positional[0], USAGE)

const payload = {}
let hasUpdate = false

if (flags.text !== undefined) {
  if (flags.text.trim().length === 0) fail(`Error: --text cannot be empty`)
  payload.text = flags.text.trim()
  hasUpdate = true
}

if (flags.status !== undefined) {
  payload.status = requireStatus(flags.status)
  hasUpdate = true
}

if (flags.project !== undefined) {
  payload.projectScope = requireProjectScope(flags.project)
  hasUpdate = true
}

if (flags.position !== undefined) {
  const pos = Number.parseInt(flags.position, 10)
  if (!Number.isInteger(pos)) fail(`Error: --position must be an integer, got '${flags.position}'`)
  payload.position = pos
  hasUpdate = true
}

if (flags.parent !== undefined) {
  if (flags.parent === '') {
    payload.parentItemId = null
  } else {
    const parentId = Number.parseInt(flags.parent, 10)
    if (!Number.isInteger(parentId)) fail(`Error: --parent must be a numeric item ID, got '${flags.parent}'`)
    payload.parentItemId = parentId
  }
  hasUpdate = true
}

if (!hasUpdate) fail(`Error: at least one of --text, --status, --project, --position, --parent is required`, USAGE)

const { status, body } = await api(`/api/plan-items/${id}`, jsonPut(payload))

if (status !== 200) {
  failResponse(status, body, 'Plan item update')
}

console.log(`✓ Item %${id} updated`)
