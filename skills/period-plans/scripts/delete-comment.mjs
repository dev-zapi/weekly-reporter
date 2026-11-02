#!/usr/bin/env node

// Delete a plan item comment.
// Usage: delete-comment.mjs <itemId> <commentId>

import { api, failResponse, parseArgs, requireId } from './lib/client.mjs'

const USAGE = `Usage: delete-comment.mjs <itemId> <commentId>`

const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const itemId = requireId(positional[0], USAGE)
const commentId = requireId(positional[1], USAGE, 'comment')

const { status, body } = await api(`/api/plan-items/${itemId}/comments/${commentId}`, { method: 'DELETE' })

if (status !== 200) {
  failResponse(status, body, 'Plan item comment deletion')
}

console.log(`✓ Comment #${commentId} deleted from %${itemId}`)
