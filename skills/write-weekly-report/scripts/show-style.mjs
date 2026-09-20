#!/usr/bin/env node

// List the AI styles configured in weekly-reporter, or print one style's full
// writing prompt. The style prompt is the voice/rules input when authoring a
// final report, so writing sessions should read it live rather than guess.
// Usage: show-style.mjs [key]   (exact key, or a unique case-insensitive
//                              substring of key or label)

import { api, fail, failResponse, parseArgs } from './lib/client.mjs'

const USAGE = 'Usage: show-style.mjs [key]'

const { positional } = parseArgs(process.argv.slice(2), {}, USAGE)

const { status, body } = await api('/api/prompts/styles')
if (status !== 200) failResponse(status, body, 'AI styles')

const styles = Array.isArray(body?.styles) ? body.styles : []
if (styles.length === 0) fail('Error: no AI styles are configured in weekly-reporter')

const listStyles = () => {
  for (const style of styles) {
    const bits = [`temp ${style.temperature ?? '?'}`]
    if (style.isDefault) bits.push('default')
    bits.push(`${(style.systemPrompt ?? '').length} chars of prompt`)
    console.log(`${style.key} — ${style.label} (${bits.join(', ')})`)
  }
}

if (positional.length === 0) {
  listStyles()
  console.log('\nPass a key to print that style\'s full writing prompt.')
  process.exit(0)
}

const ref = positional[0]
const byKey = styles.filter(style => style.key === ref)
const bySubstring = styles.filter(style =>
  style.key.toLowerCase().includes(ref.toLowerCase())
  || String(style.label ?? '').toLowerCase().includes(ref.toLowerCase()))

const match = byKey[0] ?? (bySubstring.length === 1 ? bySubstring[0] : null)
if (!match) {
  if (bySubstring.length > 1) {
    console.error(`Error: '${ref}' matches several styles, be more specific:`)
    listStyles()
  } else {
    console.error(`Error: no AI style matches '${ref}'. Available styles:`)
    listStyles()
  }
  process.exit(1)
}

console.log(`# ${match.key} — ${match.label}${match.isDefault ? ' (default)' : ''}`)
console.log(`temperature: ${match.temperature ?? '?'}`)
if (match.detailLevel) console.log(`detailLevel: ${match.detailLevel}`)
if (match.resultOriented) console.log(`resultOriented: ${match.resultOriented}`)
console.log('')
console.log(match.systemPrompt ?? '')
