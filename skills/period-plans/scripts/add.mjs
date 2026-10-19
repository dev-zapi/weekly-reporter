#!/usr/bin/env node

// Add a new plan item
// Usage: add.mjs --scope <week|month> [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>] --text <text> [--project <work|personal>] [--parent <itemId>]

import { api, fail, failResponse, parseArgs, json, requireScope, requireDate, requireMonth, requireProjectScope } from './lib/client.mjs'

const USAGE = `Usage: add.mjs --scope <week|month> [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>] --text <text> [--project <work|personal>] [--parent <itemId>]`

const { flags } = parseArgs(process.argv.slice(2), {
  '--scope': 'value',
  '--week-start': 'value',
  '--week-end': 'value',
  '--month': 'value',
  '--text': 'value',
  '--project': 'value',
  '--parent': 'value',
}, USAGE)

if (!flags.scope) fail(`Error: --scope is required`, USAGE)
const planScope = requireScope(flags.scope)

if (!flags.text) fail(`Error: --text is required`, USAGE)

const payload = {
  scope: planScope,
  text: flags.text,
  projectScope: flags.project ? requireProjectScope(flags.project) : 'work',
}

if (planScope === 'week') {
  if (!flags['week-start'] || !flags['week-end']) {
    fail(`Error: For week scope, both --week-start and --week-end are required`, USAGE)
  }
  payload.weekStart = requireDate(flags['week-start'], '--week-start')
  payload.weekEnd = requireDate(flags['week-end'], '--week-end')
} else {
  // month scope
  if (!flags.month) {
    fail(`Error: For month scope, --month is required`, USAGE)
  }
  payload.month = requireMonth(flags.month)
}

if (flags.parent) {
  const parentId = Number.parseInt(flags.parent, 10)
  if (!Number.isInteger(parentId)) fail(`Error: --parent must be a numeric item ID, got '${flags.parent}'`)
  payload.parentItemId = parentId
}

const { status, body } = await api('/api/plan-items', json(payload))

if (status !== 201) {
  failResponse(status, body, 'Plan item creation')
}

console.log(`✓ Item created: %${body.id} (plan=${body.periodPlanId})`)
