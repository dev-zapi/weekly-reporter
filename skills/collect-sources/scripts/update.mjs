#!/usr/bin/env node

// Update a collect source. Only the fields you pass change — everything else
// is backfilled from the stored source, because the API's PUT replaces the
// whole record and a naive partial body would wipe the omitted fields.
// Usage: update.mjs <ref> [--name <text>] [--scope <work|personal>]
//                   [--email <a>...]        (replace the whole email list)
//                   [--add-email <a>...]    (append; case-insensitive dedupe)
//                   [--alias <x>...]        (replace the whole alias list)
//                   [--add-alias <x>...]    (append)
//                   [--branch <b>...]       (replace branch list)
//                   [--path <dir>]          (git-local repo dir; --owner works too)
//                   [--repo <r>] [--baseUrl <url>] [--token <t>]

import { api, branchNames, fail, failResponse, jsonPut, parseArgs, resolveSource, SCOPES } from './lib/client.mjs'

const USAGE = 'Usage: update.mjs <ref> [--name <text>] [--scope <work|personal>] [--email <a>... | --add-email <a>...] [--alias <x>... | --add-alias <x>...] [--branch <b>...] [--path <dir>] [--repo <r>] [--baseUrl <url>] [--token <t>]'

const { flags, positional } = parseArgs(process.argv.slice(2), {
  '--name': 'value',
  '--scope': 'value',
  '--email': 'multi',
  '--add-email': 'multi',
  '--alias': 'multi',
  '--add-alias': 'multi',
  '--branch': 'multi',
  '--path': 'value',
  '--owner': 'value',
  '--repo': 'value',
  '--baseUrl': 'value',
  '--token': 'value',
}, USAGE)

if (flags.email && flags['add-email']) fail('Error: use either --email (replace the list) or --add-email (append), not both', USAGE)
if (flags.alias && flags['add-alias']) fail('Error: use either --alias (replace the list) or --add-alias (append), not both', USAGE)
if (flags.path && flags.owner) fail('Error: --path and --owner are synonyms for the same field; pass one', USAGE)

const source = await resolveSource(positional[0], USAGE)
const cfg = source.config ?? {}
const changed = []

// --- top-level fields (always present in the body; backfill unless given) ---
const name = flags.name != null ? flags.name.trim() : source.name
if (name.length < 1 || name.length > 100) fail(`Error: --name must be 1-100 characters (got ${name.length})`)
if (flags.name != null) changed.push('name')

const scope = flags.scope ?? source.projectScope
if (!SCOPES.includes(scope)) fail(`Error: --scope must be one of: ${SCOPES.join(', ')}`, USAGE)
if (flags.scope != null) changed.push('scope')

// --- config fields ---
const config = {}

// owner: git-local stores the absolute local path, remote stores the org/user.
const owner = flags.path ?? flags.owner ?? cfg.owner
if (owner == null || owner === '') fail('Error: the source has no owner to backfill — pass --path')
if (flags.path != null || flags.owner != null) changed.push('owner')
config.owner = owner

config.repo = flags.repo ?? cfg.repo
if (flags.repo != null) changed.push('repo')

if (flags.baseUrl != null) {
  config.baseUrl = flags.baseUrl
  changed.push('baseUrl')
} else if (cfg.baseUrl != null) {
  config.baseUrl = cfg.baseUrl
}

// token: the stored value comes back masked as [ENCRYPTED], so it must never
// be echoed into the body — omitting the key makes the server reuse the
// stored token (ADR-0011). Only an explicit --token replaces it.
if (flags.token != null) {
  config.token = flags.token
  changed.push('token')
}

// emails: replace (--email) or append (--add-email); absent → backfill.
let emails
if (flags.email) {
  emails = flags.email
  changed.push('emails')
} else if (flags['add-email']) {
  emails = [...(cfg.authorEmails ?? [])]
  for (const email of flags['add-email']) {
    if (!emails.some((existing) => existing.toLowerCase() === email.toLowerCase())) emails.push(email)
  }
  changed.push('emails')
} else {
  emails = cfg.authorEmails ?? []
}
if (emails.length === 0) fail('Error: a source needs at least one author email — the API rejects empty authorEmails')
config.authorEmails = emails

// aliases: same replace/append split; absent → backfill.
let aliases
if (flags.alias) {
  aliases = flags.alias
  changed.push('aliases')
} else if (flags['add-alias']) {
  aliases = [...(cfg.aliases ?? [])]
  for (const alias of flags['add-alias']) {
    if (!aliases.includes(alias)) aliases.push(alias)
  }
  changed.push('aliases')
} else {
  aliases = cfg.aliases ?? []
}
if (aliases.length > 20) fail('Error: at most 20 aliases are allowed', USAGE)

// branches: replace-only. Absent → resend the current branch NAMES so the
// server keeps each branch's cursor; absent and currently empty → omit the
// key entirely, because an empty branch config is the all-branches sentinel.
if (flags.branch) {
  config.branches = flags.branch
  changed.push('branches')
} else {
  const current = branchNames(source)
  if (current.length) config.branches = current
}
// branchCursors are never sent: the server always preserves the stored ones.

const payload = { type: source.type, name, projectScope: scope, config }
if (aliases.length) payload.aliases = aliases

if (changed.length === 0) fail('Error: nothing to update — pass at least one field', USAGE)

const { status, body } = await api(`/api/collect/sources/${source.id}`, jsonPut(payload))
if (status !== 200) failResponse(status, body, `Source #${source.id}`)

const updated = body?.source ?? body
console.log(`✓ Updated #${updated.id} "${updated.name}" — changed: ${changed.join(', ')}`)
console.log(`  status: ${updated.status}`)
// Renaming a branch (rather than adding/removing) leaves the old name's
// cursor behind — mergeEditedBranches matches cursors by exact branch name.
if (flags.branch && branchNames(source).some((prev) => !flags.branch.includes(prev))) {
  console.log('  Note: branches no longer in the list lose their sync cursors; a renamed branch starts from scratch.')
}
