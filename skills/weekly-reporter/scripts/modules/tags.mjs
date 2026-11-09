// The tags module (标签).
//
// Tags are not standalone records: they are `#name` tokens inside manual event
// content, and the API re-parses them from the content on every write. So the
// only way to change a tag globally is to rewrite every affected event - hence
// the PLAN gate on rename/remove (ticket #123).

import { api } from '../lib/api.mjs'
import { failResponse } from '../lib/errors.mjs'
import { emptyState, listFooter, listLine } from '../lib/output.mjs'

/** `wrp tags list` — the inventory with per-tag event counts, alphabetical. */
export async function list() {
  const { status, body } = await api('/api/tags')
  if (status !== 200) failResponse(status, body, 'read the tag list again')

  const tags = body?.tags ?? []
  if (tags.length === 0) {
    emptyState('No tags yet — a tag appears when a manual event contains a #name token.')
    return
  }
  for (const tag of tags) listLine(`#${tag.name}`, [], `— ${tag.count} event(s)`)
  listFooter(tags.length, 'tag')
}
