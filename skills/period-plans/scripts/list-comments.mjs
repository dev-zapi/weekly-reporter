#!/usr/bin/env node

// List a plan item's comments, including deferral-chain ancestor comments.
// Usage: list-comments.mjs <itemId>

import { api, failResponse, parseArgs, requireId } from './lib/client.mjs'
import { formatCommentList } from './lib/comments.mjs'

const USAGE = `Usage: list-comments.mjs <itemId>`

const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const itemId = requireId(positional[0], USAGE)

const { status, body } = await api(`/api/plan-items/${itemId}/comments`)

if (status !== 200) {
  failResponse(status, body, 'Plan item comments')
}

console.log(formatCommentList(itemId, body?.comments ?? [], body?.commentCount))
