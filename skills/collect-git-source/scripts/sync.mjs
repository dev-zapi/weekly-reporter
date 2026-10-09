#!/usr/bin/env node

// Trigger a sync for an existing collect source. Optionally enable it first.
// Usage: sync.mjs --id <n> [--enable]

import { api, fail, failResponse, json, jsonPatch, parseArgs } from './lib/client.mjs'

const USAGE = 'Usage: sync.mjs --id <n> [--enable]'

const { flags } = parseArgs(process.argv.slice(2), {
  '--id': 'value',
  '--enable': 'boolean',
}, USAGE)

if (!flags.id) fail('Error: --id is required', USAGE)
const id = parseInt(flags.id)
if (isNaN(id)) fail(`Error: --id must be numeric (got '${flags.id}')`)

// Read the source first so we can print its name in the summary line. The
// [id] GET returns the same shape as the sync endpoint's caller expects.
const { status: getStatus, body: getSource } = await api(`/api/collect/sources/${id}`)
if (getStatus !== 200) failResponse(getStatus, getSource, 'Source')
const sourceName = getSource.name

if (flags.enable) {
  const { status: patchStatus, body: patchBody } = await api(
    `/api/collect/sources/${id}`,
    jsonPatch({ enabled: true }),
  )
  if (patchStatus !== 200) failResponse(patchStatus, patchBody, 'Enable')
}

const { status, body } = await api('/api/collect/git-remote/sync', json({ sourceId: id }))

if (status === 409) {
  // Source operation lock — another sync/fetch is already running. Retry later.
  fail(`Error: source is busy — another sync is in progress [SOURCE_BUSY]`, 'Retry in a few seconds.')
}

if (status === 500 && body?.code === 'SYNC_FAILED') {
  const result = body.result || {}
  // autoDisabled is set by the server when the source path disappeared or
  // the repo became unreadable; surface it so the user knows why.
  if (result.autoDisabled) {
    fail(
      `Error: sync failed and the source was auto-disabled`,
      `Reason: ${result.error || 'unknown'}`,
      'Check that the repo path still exists and is readable.',
    )
  }
  const branchLines = formatBranches(result.branches || [], { failedOnly: true })
  fail(
    `Error: sync failed for ${sourceName} (#${id})`,
    `Reason: ${result.error || 'unknown'}`,
    ...branchLines,
  )
}

if (status !== 200) failResponse(status, body, 'Sync')

const result = body.result || {}
console.log(`✓ Synced ${sourceName} (#${id}): ${result.commitsCount} commits scanned, ${result.eventsCount} new events`)

for (const line of formatBranches(result.branches || [])) {
  console.log(line)
}

// Single iteration over the branch array; `failedOnly` switches between the
// success summary (✓/✗ per branch) and the error-only list used by SYNC_FAILED.
function formatBranches(branches, { failedOnly = false } = {}) {
  const lines = []
  for (const b of branches) {
    const isFailed = b.status === 'failed' || Boolean(b.error)
    if (failedOnly) {
      if (isFailed) lines.push(`  ${b.name}: ${b.error || 'failed'}`)
    } else if (isFailed) {
      lines.push(`  ${b.name}: ✗ ${b.error || 'failed'}`)
    } else {
      lines.push(`  ${b.name}: ✓ ${b.commitsCount} commits`)
    }
  }
  return lines
}
