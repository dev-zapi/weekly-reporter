#!/usr/bin/env node

// Save the adopted final content for one audience variant of a report.
// Usage: save-final.mjs <id> --variant <leadership|personal> (--content <text> | --file <path>) [--source-revision <n>] [--template-id <id>] [--ai-style-key <key>]

import { readFile } from 'node:fs/promises'
import { api, fail, failResponse, jsonPut, parseArgs, requireId, requireVariant } from './lib/client.mjs'

const USAGE = 'Usage: save-final.mjs <id> --variant <leadership|personal> (--content <text> | --file <path>) [--source-revision <n>] [--template-id <id>] [--ai-style-key <key>]'

const { flags, positional } = parseArgs(process.argv.slice(2), {
  '--variant': 'value',
  '--content': 'value',
  '--file': 'value',
  '--source-revision': 'value',
  '--template-id': 'value',
  '--ai-style-key': 'value',
}, USAGE)

const reportId = requireId(positional[0], USAGE)
const variant = requireVariant(flags.variant)

if ((flags.content == null) === (flags.file == null)) {
  fail('Error: provide exactly one of --content or --file', USAGE)
}

// Final report bodies are multi-line markdown. --file is the reliable path for
// anything longer than a sentence; shell quoting mangles long inline content.
let content = flags.content
if (flags.file != null) {
  try {
    content = await readFile(flags.file, 'utf8')
  } catch (error) {
    fail(`Error: cannot read --file '${flags.file}': ${error.message}`)
  }
}

if (!content || !content.trim()) fail('Error: final content cannot be empty')

const payload = { variant, content }
if (flags['source-revision'] != null) {
  const revision = Number.parseInt(flags['source-revision'], 10)
  if (!Number.isInteger(revision)) fail(`Error: --source-revision must be an integer, got '${flags['source-revision']}'`)
  // Sending the revision you read makes the write fail loudly (409) instead of
  // overwriting a final that was rebuilt from a newer source draft meanwhile.
  payload.sourceRevision = revision
}
// Provenance snapshots: pass the template/style you actually wrote with so the
// variant records them the same way the app's own proposal acceptance does.
// Omitted flags leave the variant's existing snapshots untouched.
if (flags['template-id'] != null) payload.templateId = flags['template-id']
if (flags['ai-style-key'] != null) payload.aiStyleKey = flags['ai-style-key']

const { status, body } = await api(`/api/reports/${reportId}/final`, jsonPut(payload))
if (status !== 200) failResponse(status, body, `Report #${reportId} (${variant})`)

console.log(`✓ Final saved for report #${reportId} (${variant}) — ${content.trim().length} chars, status ${body?.finalStatus ?? 'current'}`)
