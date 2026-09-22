#!/usr/bin/env node

// List all timeline tags with event counts
// Usage: list.mjs

import { fail, fetchTags } from './lib/client.mjs'

const USAGE = 'Usage: list.mjs'

if (process.argv.length > 2) fail(`Error: list.mjs takes no arguments`, USAGE)

const tags = await fetchTags()

if (tags.length === 0) {
  console.log('No tags yet. Tags appear when a manual event contains #name tokens.')
  process.exit(0)
}

for (const tag of tags) {
  console.log(`#${tag.name} — ${tag.count} event${tag.count !== 1 ? 's' : ''}`)
}
console.log(`\n${tags.length} tag${tags.length !== 1 ? 's' : ''} total`)
