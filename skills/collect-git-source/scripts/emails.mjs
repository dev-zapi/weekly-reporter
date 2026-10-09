#!/usr/bin/env node

// List commit authors for a local repo path, as the API sees them.
// Output: `commits  email  name` per line, in the server's order (count desc).
// Usage: emails.mjs --path <repo root>

import { api, fail, failResponse, parseArgs } from './lib/client.mjs'

const USAGE = 'Usage: emails.mjs --path <repo root>'

const { flags } = parseArgs(process.argv.slice(2), {
  '--path': 'value',
}, USAGE)

if (!flags.path || !flags.path.trim()) fail('Error: --path is required', USAGE)

const qs = new URLSearchParams({ type: 'git-local', path: flags.path.trim() })
const { status, body } = await api(`/api/collect/sources/emails?${qs}`)
if (status !== 200) failResponse(status, body, 'Emails')

const authors = body?.authors || []
if (authors.length === 0) {
  console.log('(no commit authors found in the last 300 commits)')
} else {
  // Header + rows in fixed-width columns. Padded for alignment, not pretty.
  const countWidth = Math.max(7, String(authors[0].count).length)
  console.log(`${'commits'.padStart(countWidth)}  email                          name`)
  for (const a of authors) {
    console.log(`${String(a.count).padStart(countWidth)}  ${(a.email || '').padEnd(30)}  ${a.name || ''}`)
  }
}
