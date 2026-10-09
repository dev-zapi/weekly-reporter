#!/usr/bin/env node

// Create a new git-local collect source.
// Usage: create.mjs --path <p> --name <n> --scope work|personal --email <a> [--email <b> ...]

import { api, fail, failResponse, json, parseArgs } from './lib/client.mjs'

const USAGE = 'Usage: create.mjs --path <p> --name <n> --scope work|personal --email <a> [--email <b> ...]'

const { flags } = parseArgs(process.argv.slice(2), {
  '--path': 'value',
  '--name': 'value',
  '--scope': 'value',
  '--email': 'multi',
}, USAGE)

if (!flags.path || !flags.path.trim()) fail('Error: --path is required', USAGE)
if (!flags.name || !flags.name.trim()) fail('Error: --name is required', USAGE)
if (flags.name.length > 100) fail(`Error: --name must be at most 100 characters (got ${flags.name.length})`)
if (flags.scope !== 'work' && flags.scope !== 'personal') {
  fail(`Error: --scope must be 'work' or 'personal' (got '${flags.scope}')`, USAGE)
}
// The API requires at least one author email; the skill flow is supposed to
// have confirmed a non-empty selection before invoking this script.
const emails = flags.email || []
if (emails.length === 0) fail('Error: at least one --email is required', USAGE)

const payload = {
  type: 'git-local',
  name: flags.name.trim(),
  projectScope: flags.scope,
  config: {
    owner: flags.path.trim(),
    authorEmails: emails,
  },
}

const { status, body } = await api('/api/collect/sources', json(payload))
if (status !== 201) failResponse(status, body, 'Source')

console.log(`✓ Source created: #${body.id} ${body.name}`)
