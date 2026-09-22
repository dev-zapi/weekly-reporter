#!/usr/bin/env node

// Rename a tag across ALL events (merges into the target when it already exists)
// Usage: rename.mjs <from> <to> [--confirm]
//
// Without --confirm this only prints the plan and exits 1 — the operation
// rewrites every affected event's content, so it must be previewed and
// user-approved first (see SKILL.md).

import { api, fail, failResponse, fetchTags, parseArgs, validateTag } from './lib/client.mjs'

const USAGE = 'Usage: rename.mjs <from> <to> [--confirm]'

const { flags, positional } = parseArgs(process.argv.slice(2), { '--confirm': 'boolean' }, USAGE)

const from = validateTag(positional[0], 'Source')
const to = validateTag(positional[1], 'Target')

const tags = await fetchTags()

const fromCount = tags.find((t) => t.name === from)?.count
if (fromCount === undefined) {
  fail(`Error: no tag named '#${from}' exists. Run list.mjs to see what exists.`)
}
const mergeTarget = tags.find((t) => t.name === to)

if (!flags.confirm) {
  console.log(`Plan: rename #${from} → #${to} on ${fromCount} event(s)`)
  if (mergeTarget) {
    console.log(`⚠ '#${to}' already exists on ${mergeTarget.count} event(s) — running this MERGES the two tags (the API does not error).`)
  }
  console.log('NOT EXECUTED — this rewrites the content of every affected event.')
  console.log('Preview the affected events, get user approval, then re-run with --confirm.')
  process.exit(1)
}

const { status, body } = await api('/api/tags/rename', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from, to }),
})
if (status !== 200) failResponse(status, body)

const updated = body?.eventsUpdated ?? 0
const merged = body?.merged ? ', merged with the existing tag' : ''
console.log(`✓ Renamed #${from} → #${to} on ${updated} event(s)${merged}`)
