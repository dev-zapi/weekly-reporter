#!/usr/bin/env node

// Delete a collect source.
// Usage: delete.mjs <ref> --confirm

import { api, fail, failResponse, parseArgs, resolveSource } from './lib/client.mjs'

const USAGE = 'Usage: delete.mjs <ref> --confirm'

const { flags, positional } = parseArgs(process.argv.slice(2), { '--confirm': 'boolean' }, USAGE)

const source = await resolveSource(positional[0], USAGE)

// Nothing restores a deleted source, and name resolution means the caller may
// not have looked at what they matched — so show it before requiring --confirm.
if (!flags.confirm) {
  console.error('Refusing to delete without --confirm.')
  console.error(`  #${source.id}  ${source.name}  (${source.type}, ${source.projectScope})`)
  console.error(`  owner: ${source.config?.owner ?? '—'}`)
  console.error(`  ${source.config?.authorEmails?.length ?? 0} emails, last sync ${source.lastSyncStatus ?? 'never'}`)
  console.error('  Events already collected stay on the timeline (they move to the "other" group); the source record and its sync cursors are gone for good.')
  fail(`Rerun: delete.mjs #${source.id} --confirm`)
}

const { status, body } = await api(`/api/collect/sources/${source.id}`, { method: 'DELETE' })
if (status !== 200) failResponse(status, body, `Source #${source.id}`)

console.log(`✓ Deleted #${source.id} "${source.name}"`)
