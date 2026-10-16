#!/usr/bin/env node

// List period plans and their items
// Usage: list.mjs --scope <week|month> [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>]

import { api, fail, failResponse, parseArgs, requireScope, requireDate, requireMonth } from './lib/client.mjs'

const USAGE = `Usage: list.mjs --scope <week|month> [--date <YYYY-MM-DD>] [--week-start <YYYY-MM-DD> --week-end <YYYY-MM-DD>] [--month <YYYY-MM>]`

const { flags } = parseArgs(process.argv.slice(2), {
  '--scope': 'value',
  '--date': 'value',
  '--week-start': 'value',
  '--week-end': 'value',
  '--month': 'value',
}, USAGE)

if (!flags.scope) fail(`Error: --scope is required`, USAGE)
const scope = requireScope(flags.scope)

const params = new URLSearchParams()
params.set('scope', scope)

if (scope === 'week') {
  if (flags.date) {
    params.set('date', requireDate(flags.date, '--date'))
  } else if (flags['week-start'] && flags['week-end']) {
    params.set('weekStart', requireDate(flags['week-start'], '--week-start'))
    params.set('weekEnd', requireDate(flags['week-end'], '--week-end'))
  } else {
    fail(`Error: For week scope, provide either --date or both --week-start and --week-end`, USAGE)
  }
} else {
  // month scope
  if (flags.date) {
    params.set('date', requireDate(flags.date, '--date'))
  } else if (flags.month) {
    params.set('month', requireMonth(flags.month))
  } else {
    fail(`Error: For month scope, provide either --date or --month`, USAGE)
  }
}

const { status, body } = await api(`/api/plans?${params}`)

if (status !== 200) {
  failResponse(status, body, 'Plan query')
}

const plan = body?.plan
const items = body?.items ?? []

if (!plan) {
  console.log('No plan found for this period.')
  process.exit(0)
}

console.log(`Plan: ${plan.scope} ${plan.periodStart} to ${plan.periodEnd} (id=${plan.id})`)

if (items.length === 0) {
  console.log('  (no items)')
  process.exit(0)
}

for (const item of items) {
  const id = `#${item.id}`
  const statusStr = `[${item.status}]`
  const scopeStr = `[${item.projectScope}]`
  let line = `  ${id.padEnd(6)} ${statusStr.padEnd(14)} ${scopeStr.padEnd(10)} ${item.text}`

  if (item.parentItemId) {
    line += ` (parent=${item.parentItemId})`
  }
  if (item.deferredFromItemId) {
    line += ` (deferred from #${item.deferredFromItemId})`
  }

  console.log(line)
}
