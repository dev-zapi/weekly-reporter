// The tags module (标签).
//
// Tags are not standalone records: they are `#name` tokens inside manual event
// content, and the API re-parses them from the content on every write. So the
// only way to change a tag globally is to rewrite every affected event - hence
// the PLAN gate on rename/remove (ticket #123).

import { api, json } from '../lib/api.mjs'
import { requireArg } from '../lib/args.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { emptyState, feedback, listFooter, listLine, preview } from '../lib/output.mjs'

// Mirror of the server's TAG_CHARSET_REGEX (internal/api/tags/tags.go,
// IsValidTagName): Han characters, Latin letters, digits - never digits only.
// Catching a bad name here keeps a typo from becoming a 400 on an operation
// that rewrites event content.
const TAG_CHARSET_REGEX = /^(?=[\p{Script=Han}A-Za-z0-9]*[\p{Script=Han}A-Za-z])[\p{Script=Han}A-Za-z0-9]+$/u

const TAG_CHARSET_RULE =
  'a tag name may contain only Chinese characters, Latin letters and digits, with at least one non-digit'

/** Validate a tag name against the server's charset rule, or exit with the rule. */
function validateTagName(name) {
  if (!TAG_CHARSET_REGEX.test(name)) {
    fail(
      'invalid tag name',
      `'${name}' — ${TAG_CHARSET_RULE}`,
      'rename within 中文/letters/digits — symbols and digits-only names are not tags',
    )
  }
  return name
}

function failUnknownTag(name) {
  fail(`no tag named '#${name}'`, 'the tag is misspelled, already gone, or never existed', 'run wrp tags list to see the inventory')
}

/** The inventory with per-tag event counts, as the API returns it (alphabetical). */
async function fetchTags() {
  const { status, body } = await api('/api/tags')
  if (status !== 200) failResponse(status, body, 'read the tag inventory again')
  return body?.tags ?? []
}

function countOf(tags, name) {
  return tags.find((tag) => tag.name === name)?.count
}

/** `wrp tags list` — the inventory with per-tag event counts, alphabetical. */
export async function list() {
  const tags = await fetchTags()
  if (tags.length === 0) {
    emptyState('No tags yet — a tag appears when a manual event contains a #name token.')
    return
  }
  for (const tag of tags) listLine(`#${tag.name}`, [], `— ${tag.count} event(s)`)
  listFooter(tags.length, 'tag')
}

/** `wrp tags rename <from> <to> [--confirm]` — merges when the target exists. */
export async function rename({ flags, positional }) {
  const usage = 'wrp tags rename <from> <to> [--confirm]'
  const from = validateTagName(requireArg(positional, 0, 'source tag name', usage))
  const to = validateTagName(requireArg(positional, 1, 'target tag name', usage))

  const tags = await fetchTags()
  const fromCount = countOf(tags, from)
  if (fromCount === undefined) failUnknownTag(from)
  const mergeTarget = tags.find((tag) => tag.name === to)

  if (!flags.confirm) {
    preview(
      [
        `rename #${from} → #${to} on ${fromCount} event(s)`,
        'this rewrites the content of every affected event',
      ],
      mergeTarget
        ? [`'#${to}' already exists on ${mergeTarget.count} event(s) — running this silently MERGES the two tags.`]
        : [],
    )
    process.exit(1)
  }

  const { status, body } = await api('/api/tags/rename', json('POST', { from, to }))
  if (status !== 200) failResponse(status, body, 'check both tag names with wrp tags list and retry')

  const updated = body?.eventsUpdated ?? 0
  const merged = body?.merged ? ', merged with the existing tag' : ''
  feedback('tag', 'renamed', `#${from} → #${to} on ${updated} event(s)${merged}`)
}

/** `wrp tags remove <name> [--confirm]` — strips the token from every event. */
export async function remove({ flags, positional }) {
  const usage = 'wrp tags remove <name> [--confirm]'
  const name = validateTagName(requireArg(positional, 0, 'tag name', usage))

  const tags = await fetchTags()
  const count = countOf(tags, name)
  if (count === undefined) failUnknownTag(name)

  if (!flags.confirm) {
    preview([
      `remove #${name} from ${count} event(s)`,
      'this rewrites the content of every affected event',
    ])
    process.exit(1)
  }

  const { status, body } = await api(`/api/tags?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (status !== 200) failResponse(status, body, 'check the tag name with wrp tags list and retry')

  feedback('tag', 'removed', `#${name} from ${body?.removed ?? 0} event(s)`)
}
