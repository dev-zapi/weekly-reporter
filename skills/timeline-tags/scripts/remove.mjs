#!/usr/bin/env node

// Remove a tag from ALL events (strips the #name text from every event content)
// Usage: remove.mjs <name> [--confirm]
//
// Without --confirm this only prints the plan and exits 1 — the operation
// rewrites every affected event's content, so it must be previewed and
// user-approved first (see SKILL.md).

import { api, fail, failResponse, fetchTags, parseArgs, validateTag } from './lib/client.mjs'

const USAGE = 'Usage: remove.mjs <name> [--confirm]'

const { flags, positional } = parseArgs(process.argv.slice(2), { '--confirm': 'boolean' }, USAGE)

const name = validateTag(positional[0], 'Tag')

const tags = await fetchTags()

const count = tags.find((t) => t.name === name)?.count
if (count === undefined) {
  fail(`Error: no tag named '#${name}' exists. Run list.mjs to see what exists.`)
}

if (!flags.confirm) {
  console.log(`Plan: remove #${name} from ${count} event(s)`)
  console.log('NOT EXECUTED — this rewrites the content of every affected event.')
  console.log('Preview the affected events, get user approval, then re-run with --confirm.')
  process.exit(1)
}

const { status, body } = await api(`/api/tags?name=${encodeURIComponent(name)}`, {
  method: 'DELETE',
})
if (status !== 200) failResponse(status, body)

console.log(`✓ Removed tag #${name} from ${body?.removed ?? 0} event(s)`)
