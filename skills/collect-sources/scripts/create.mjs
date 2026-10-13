#!/usr/bin/env node

// Create a collect source of any type.
//   git-local: create.mjs --name <n> --path <dir> --email <a> [--email <b>...]
//              [--branch <b>...] [--alias <x>...] [--scope work|personal]
//   remote:    create.mjs --type <git-remote-github|git-remote-gitlab|git-remote-gitee>
//              --name <n> --owner <o> --repo <r> --token <t> [--baseUrl <u>] (same optionals)
// --type defaults to git-local. Without --branch the source starts in
// all-branches mode (git-local) / default-branch mode (remote).

import { api, fail, failResponse, json, parseArgs, SCOPES, TYPES } from './lib/client.mjs'

const USAGE = 'Usage: create.mjs [--type <type>] --name <text> (--path <dir> | --owner <o> --repo <r> --token <t> [--baseUrl <url>]) --email <a> [--email <b>...] [--branch <b>...] [--alias <x>...] [--scope <work|personal>]'

const { flags } = parseArgs(process.argv.slice(2), {
  '--type': 'value',
  '--name': 'value',
  '--path': 'value',
  '--owner': 'value',
  '--repo': 'value',
  '--token': 'value',
  '--baseUrl': 'value',
  '--email': 'multi',
  '--branch': 'multi',
  '--alias': 'multi',
  '--scope': 'value',
}, USAGE)

// Client-side checks cover the cheap, local rules with clearer messages than
// the server's zod output; alias collisions, path validity and branch shapes
// are left to the server — it owns those semantics.
const type = flags.type ?? 'git-local'
if (!TYPES.includes(type)) fail(`Error: --type must be one of: ${TYPES.join(', ')} (got '${type}')`, USAGE)

const name = flags.name?.trim()
if (!name) fail('Error: --name is required (1-100 characters)', USAGE)
if (name.length > 100) fail(`Error: --name must be at most 100 characters (got ${name.length})`)

const scope = flags.scope ?? 'personal'
if (!SCOPES.includes(scope)) fail(`Error: --scope must be one of: ${SCOPES.join(', ')}`, USAGE)

const emails = flags.email ?? []
if (emails.length === 0) fail('Error: at least one --email is required — the API rejects sources without author emails', USAGE)
for (const email of emails) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(`Error: '${email}' does not look like an email address`, USAGE)
}

const aliases = flags.alias ?? []
if (aliases.length > 20) fail('Error: at most 20 --alias values are allowed', USAGE)

const config = { authorEmails: emails }
if (type === 'git-local') {
  if (!flags.path) fail('Error: --path is required for git-local (the repo directory on this machine)', USAGE)
  if (flags.repo || flags.token || flags.baseUrl) fail('Error: --repo/--token/--baseUrl apply to remote types only — git-local locates the repo by --path', USAGE)
  config.owner = flags.path
} else {
  if (flags.path) fail(`Error: --path applies to git-local only — ${type} uses --owner`, USAGE)
  if (!flags.owner || !flags.repo || !flags.token) fail(`Error: --owner, --repo and --token are all required for ${type}`, USAGE)
  config.owner = flags.owner
  config.repo = flags.repo
  config.token = flags.token
  if (flags.baseUrl) config.baseUrl = flags.baseUrl
}
if (flags.branch?.length) config.branches = flags.branch

const payload = { type, name, projectScope: scope, config }
if (aliases.length) payload.aliases = aliases

const { status, body } = await api('/api/collect/sources', json(payload))
if (status !== 201) failResponse(status, body, 'Create')

const created = body?.source ?? body
console.log(`✓ Created #${created.id} "${created.name}" (${created.type}, ${created.projectScope}) — status: ${created.status}`)
if (created.status === 'unavailable') {
  console.log('  Marked unavailable right away — that usually means a path the server cannot read; check it with show.mjs.')
}
