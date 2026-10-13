#!/usr/bin/env node

// List collect sources. All filters are optional and map onto the server's
// query params (--name matches the display name OR any alias, server-side).
// Usage: list.mjs [--name <text>] [--type <t>] [--status <s>] [--scope <work|personal>] [--sync <success|failure|never>]

import { fail, fetchAllSources, formatDate, parseArgs, SOURCE_STATUSES, SCOPES, SYNC_STATUSES, TYPES } from './lib/client.mjs'

const USAGE = 'Usage: list.mjs [--name <text>] [--type <type>] [--status <enabled|disabled|unavailable>] [--scope <work|personal>] [--sync <success|failure|never>]'

const { flags } = parseArgs(process.argv.slice(2), {
  '--name': 'value',
  '--type': 'value',
  '--status': 'value',
  '--scope': 'value',
  '--sync': 'value',
}, USAGE)

// Enum checks up front: an invalid filter would otherwise silently return an
// empty list, which looks like "no sources exist" instead of "bad flag".
if (flags.type && !TYPES.includes(flags.type)) fail(`Error: --type must be one of: ${TYPES.join(', ')}`, USAGE)
if (flags.status && !SOURCE_STATUSES.includes(flags.status)) fail(`Error: --status must be one of: ${SOURCE_STATUSES.join(', ')}`, USAGE)
if (flags.scope && !SCOPES.includes(flags.scope)) fail(`Error: --scope must be one of: ${SCOPES.join(', ')}`, USAGE)
if (flags.sync && !SYNC_STATUSES.includes(flags.sync)) fail(`Error: --sync must be one of: ${SYNC_STATUSES.join(', ')}`, USAGE)

const sources = await fetchAllSources({
  name: flags.name,
  type: flags.type,
  sourceStatus: flags.status,
  projectScope: flags.scope,
  syncStatus: flags.sync,
})

if (sources.length === 0) {
  console.log('No collect sources match.')
} else {
  for (const s of sources) {
    const aliases = s.config?.aliases ?? []
    const aliasNote = aliases.length ? ` (alias: ${aliases.join(', ')})` : ''
    const emails = s.config?.authorEmails?.length ?? 0
    const branches = s.config?.branches
    const branchMode = Array.isArray(branches) && branches.length
      ? `${branches.length} branches`
      : 'all-branches'
    const sync = s.lastSyncStatus
      ? `sync ${formatDate(s.lastSyncAt)}${s.lastSyncStatus === 'failure' ? ' (failed)' : ''}`
      : 'never synced'
    // enabled=false with status=enabled is a stale mixed state (a bare PATCH
    // of enabled doesn't recompute status); surface it when it occurs.
    const mixed = s.enabled === false && s.status === 'enabled' ? ' [enabled=false]' : ''
    console.log(`  #${s.id}  ${s.name}${aliasNote}  ${s.type}  ${s.projectScope}  ${s.status}${mixed}  ${emails} emails  ${branchMode}  ${sync}`)
  }
  const work = sources.filter((s) => s.projectScope === 'work').length
  console.log(`\n${sources.length} source(s) — work ${work} / personal ${sources.length - work}`)
}
