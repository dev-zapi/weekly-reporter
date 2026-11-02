#!/usr/bin/env node

// Add a comment to a plan item.
// Usage: add-comment.mjs <itemId> --text <text>

import { api, fail, failResponse, json, parseArgs, requireId } from './lib/client.mjs'
import { authorLabel } from './lib/comments.mjs'

const USAGE = `Usage: add-comment.mjs <itemId> --text <text>`

const { flags, positional } = parseArgs(process.argv.slice(2), {
  '--text': 'value',
}, USAGE)

const itemId = requireId(positional[0], USAGE)

if (!flags.text || flags.text.trim().length === 0) {
  fail('Error: --text is required and cannot be empty', USAGE)
}

const { status, body } = await api(`/api/plan-items/${itemId}/comments`, json({ content: flags.text }))

if (status !== 201) {
  failResponse(status, body, 'Plan item comment creation')
}

console.log(`✓ Comment #${body.id} added to %${itemId} (author: ${authorLabel(body.author)})`)
