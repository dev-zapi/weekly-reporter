#!/usr/bin/env node

// Show one collect source in full detail — the only place sync cursors
// and the complete config are displayed.
// Usage: show.mjs <ref>

import { formatDate, parseArgs, resolveSource } from './lib/client.mjs'

const USAGE = 'Usage: show.mjs <ref>'
const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const source = await resolveSource(positional[0], USAGE)
const cfg = source.config ?? {}

console.log(`#${source.id}  ${source.name}`)
console.log(`  type: ${source.type}   scope: ${source.projectScope}   status: ${source.status}${source.enabled === false ? ' (enabled=false)' : ''}`)
console.log(`  last sync: ${source.lastSyncStatus ? `${formatDate(source.lastSyncAt)} (${source.lastSyncStatus})` : 'never'}`)

console.log('  config:')
if (cfg.owner) console.log(`    owner: ${cfg.owner}`) // git-local: absolute local path; remote: org/user
if (cfg.repo) console.log(`    repo: ${cfg.repo}`)
if (cfg.baseUrl) console.log(`    baseUrl: ${cfg.baseUrl}`)
// the server always masks tokens to [ENCRYPTED]; git-local never uses one
if (cfg.token && source.type !== 'git-local') console.log(`    token: ${cfg.token}`)
const emails = cfg.authorEmails ?? []
console.log(`    authorEmails (${emails.length}): ${emails.join(', ')}`)
const aliases = cfg.aliases ?? []
if (aliases.length) console.log(`    aliases: ${aliases.join(', ')}`)

const branches = cfg.branches
if (Array.isArray(branches) && branches.length) {
  for (const b of branches) {
    if (typeof b === 'string') console.log(`    branch ${b}`)
    else console.log(`    branch ${b.name} @ cursor ${formatDate(b.lastCommitTime)}`)
  }
} else {
  // Empty branch config is meaningful: git-local = collect all local branches,
  // remote = follow the repo's default branch (ADR-0017).
  console.log('    branches: (none configured — all-branches / default branch)')
}
for (const c of cfg.branchCursors ?? []) {
  console.log(`    cursor ${c.name} @ ${formatDate(c.lastCommitTime)}`)
}

console.log(`  created: ${formatDate(source.createdAt)}   updated: ${formatDate(source.updatedAt)}`)
