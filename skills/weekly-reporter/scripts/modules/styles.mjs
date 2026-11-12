// The styles module (AI 风格).
//
// Read-only: styles live in the ai_styles table and are managed on the /prompts
// page, not here. This module exists because the style prompt is the voice/rules
// input when authoring a 终版 — a writing session should read it live rather
// than guess — and because `wrp templates create/update --style` validates keys
// against the same live list.

import { api } from '../lib/api.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emitJson } from '../lib/output.mjs'
import { requireArg } from '../lib/args.mjs'

const SHOW_USAGE = 'wrp styles show <key>'

/** `wrp styles list` — the `/api/prompts/styles` body verbatim. */
export async function list() {
  emitJson(await fetchStyleInventory())
}

/**
 * `wrp styles show <key>` — one style's full writing prompt.
 *
 * Accepts an exact key or a unique case-insensitive substring of the key or
 * label: callers naturally say "the technical one", not the key. Ambiguity
 * lists the candidates instead of guessing.
 */
export async function show({ positional }) {
  const ref = requireArg(positional, 0, 'style key', SHOW_USAGE)

  const styles = await fetchStyles()
  if (styles.length === 0) {
    fail('no AI styles configured', '', 'add one on the /prompts page, then re-run')
  }

  const exact = styles.find((style) => style.key === ref)
  const needle = ref.toLowerCase()
  const bySubstring = styles.filter(
    (style) =>
      style.key.toLowerCase().includes(needle) ||
      String(style.label ?? '').toLowerCase().includes(needle),
  )
  const match = exact ?? (bySubstring.length === 1 ? bySubstring[0] : null)

  if (!match) {
    const available = styleList(styles)
    if (bySubstring.length > 1) {
      fail(
        `ambiguous style reference: '${ref}'`,
        `matches ${bySubstring.length} styles: ${bySubstring.map((style) => style.key).join(', ')}`,
        `pass one of those keys; available: ${available}`,
      )
    }
    fail('unknown AI style', `no AI style matches '${ref}'`, `available: ${available}`)
  }

  emitJson(match)
}

/** The inventory body exactly as the API returns it (styles live under `body.styles`). */
async function fetchStyleInventory() {
  const { status, body } = await api('/api/prompts/styles')
  if (status !== 200) failResponse(status, body, 'read the AI style list again')
  return body
}

async function fetchStyles() {
  const body = await fetchStyleInventory()
  return Array.isArray(body?.styles) ? body.styles : []
}

function styleList(styles) {
  return styles.map((style) => `${style.key} (${style.label})`).join(', ') || '(none configured)'
}
