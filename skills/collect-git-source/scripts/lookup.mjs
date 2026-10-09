#!/usr/bin/env node

// Look up a git-local collect source by repo path.
// Usage: lookup.mjs --path <repo root>

import { api, fail, parseArgs } from './lib/client.mjs'

const USAGE = 'Usage: lookup.mjs --path <repo root>'

const { flags } = parseArgs(process.argv.slice(2), {
  '--path': 'value',
}, USAGE)

if (!flags.path || !flags.path.trim()) fail('Error: --path is required', USAGE)

const qs = new URLSearchParams({ type: 'git-local', path: flags.path.trim() })
const { status, body } = await api(`/api/collect/sources/lookup?${qs}`)

if (status === 404) {
  // Exit 3 is the "not found, cleanly" signal the skill flow uses to branch
  // into onboarding without parsing error text.
  console.error(`Source not found for path '${flags.path}'`)
  process.exit(3)
}
if (status !== 200) {
  const detail = body?.error || `HTTP ${status}`
  const code = body?.code ? ` [${body?.code}]` : ''
  fail(`Error: ${detail}${code}`)
}

const s = body
const branches = s.config?.branches
const branchMode = !branches || branches.length === 0
  ? 'all branches'
  : branches.map((b) => (typeof b === 'string' ? b : b.name)).join(', ')

const emails = (s.config?.authorEmails || []).join(', ') || '—'

console.log(`id:       ${s.id}`)
console.log(`name:     ${s.name}`)
console.log(`status:   ${s.status}`)
console.log(`enabled:  ${s.enabled}`)
console.log(`scope:    ${s.projectScope}`)
console.log(`emails:   ${emails}`)
console.log(`branches: ${branchMode}`)
