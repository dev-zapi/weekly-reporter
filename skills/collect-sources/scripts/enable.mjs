#!/usr/bin/env node

// Enable or disable a collect source.
// Usage: enable.mjs <ref> [--off]
//
// Uses PATCH, not PUT: a full replace for one boolean would risk wiping
// fields, and PATCHing `enabled` alone leaves `status` stale (the server
// does not recompute it on PATCH) — so both keys are always sent together.

import { api, fail, failResponse, jsonPatch, parseArgs, resolveSource } from './lib/client.mjs'

const USAGE = 'Usage: enable.mjs <ref> [--off]'

const { flags, positional } = parseArgs(process.argv.slice(2), { '--off': 'boolean' }, USAGE)

const source = await resolveSource(positional[0], USAGE)
const enable = !flags.off

if (enable && source.status === 'unavailable') {
  fail(
    `Error: #${source.id} "${source.name}" is unavailable — enabling it now would not fix the cause.`,
    'Unavailable means no author emails or a broken local path. Add emails with: update.mjs <ref> --add-email <a>',
    'Check the stored path with: show.mjs <ref>',
  )
}

const { status, body } = await api(
  `/api/collect/sources/${source.id}`,
  jsonPatch({ enabled: enable, status: enable ? 'enabled' : 'disabled' }),
)
if (status !== 200) failResponse(status, body, `Source #${source.id}`)

console.log(`✓ ${enable ? 'Enabled' : 'Disabled'} #${source.id} "${source.name}"`)
