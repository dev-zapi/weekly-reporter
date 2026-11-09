// The templates module (周报模板).
//
// A template is prose instructions for the AI that writes a 终版; the app never
// parses it or substitutes variables into it (the render endpoint is gone, see
// references/templates.md). Two kinds exist and they live behind two different
// ID conventions, which is the module's main trap:
//
//   official - hardcoded in the app, string IDs like `official-general`,
//              read-only. To adapt one, clone it.
//   user     - rows in the templates table, numeric IDs. The REST path uses the
//              bare number (`/api/templates/3`) while generation endpoints use
//              the prefixed selection ID (`user-3`).
//
// Every verb takes a flexible `<ref>` (selection ID, bare user ID, or a
// case-insensitive name substring) and resolves it here so callers do not have
// to remember which form they are holding.

import { readFile } from 'node:fs/promises'
import { api, json } from '../lib/api.mjs'
import { fail, failResponse } from '../lib/errors.mjs'
import { block, emptyState, feedback, listFooter, listLine, preview } from '../lib/output.mjs'

const NAME_MAX = 100
const DESCRIPTION_MAX = 200
// Same shape the API accepts (^[a-z][a-z0-9_-]*$); the API stores any
// well-shaped key, so existence is what this module checks against the live list.
const STYLE_KEY = /^[a-z][a-z0-9_-]*$/

const LIST_USAGE = 'wrp templates list [--kind official|user|all] [--query <text>]'
const SHOW_USAGE = 'wrp templates show <ref> [--part meta|content|both]'
const CREATE_USAGE = 'wrp templates create --name <name> (--content <text> | --file <path>) [flags]'
const CLONE_USAGE = 'wrp templates clone <ref> [--name <name>] [--content <text> | --file <path>]'
const UPDATE_USAGE = 'wrp templates update <ref> [--name] [--content|--file] [--description] [--tags] [--style]'
const DELETE_USAGE = 'wrp templates delete <ref> [--confirm]'

const REF_FIX = 'run wrp templates list to see the existing templates'

/** `wrp templates list` — both kinds, with the fields a chooser needs. */
export async function list({ flags }) {
  const kind = flags.kind ?? 'all'
  if (!['official', 'user', 'all'].includes(kind)) {
    fail('invalid --kind', `'${kind}' must be official, user or all`, `usage: ${LIST_USAGE}`)
  }

  const { official, user } = await fetchAll()
  const needle = flags.query?.toLowerCase()

  // Name, content, tags and description all participate: callers remember "the
  // template that mentions 风险", not which field it lived in.
  const matches = (template) =>
    !needle ||
    [template.name, template.content, template.tags, template.description]
      .filter(Boolean)
      .some((field) => field.toLowerCase().includes(needle))

  const selected = []
  if (kind !== 'user') selected.push(...official.filter(matches))
  if (kind !== 'official') selected.push(...user.filter(matches))

  if (selected.length === 0) {
    emptyState(needle ? `No templates matched '${flags.query}'.` : 'No templates yet — create one with wrp templates create.')
    return
  }

  for (const template of selected) {
    const metadata = [template.kind, `style: ${template.aiStyle}`, `${template.content.length} chars`]
    if (template.tags) metadata.push(`tags: ${template.tags}`)
    if (template.sourceTemplateId) metadata.push(`cloned from ${template.sourceTemplateId}`)
    listLine(template.selectionId, metadata, `${template.name} — ${firstLine(template.content) || '(empty)'}`)
  }
  listFooter(selected.length, 'template')
}

/** `wrp templates show` — metadata, and the full body only under a part mode. */
export async function show({ flags, positional }) {
  const part = flags.part ?? 'both'
  if (!['meta', 'content', 'both'].includes(part)) {
    fail('invalid --part', `'${part}' must be meta, content or both`, `usage: ${SHOW_USAGE}`)
  }

  const template = await resolveRef(positional[0], SHOW_USAGE)

  if (part === 'meta' || part === 'both') printMeta(template)
  if (part === 'content' || part === 'both') block('content', template.content || '(empty)')
}

/** `wrp templates create` — a new user template from scratch. */
export async function create({ flags }) {
  requireName(flags.name)
  const content = await readContent(flags, { required: true, nonEmpty: true, usage: CREATE_USAGE })
  if (flags.description != null && flags.description.length > DESCRIPTION_MAX) {
    fail('invalid description', `--description must be at most ${DESCRIPTION_MAX} characters (got ${flags.description.length})`, `usage: ${CREATE_USAGE}`)
  }

  const payload = { name: flags.name.trim(), content }
  if (flags.description) payload.description = flags.description
  if (flags.tags) payload.tags = flags.tags
  // Validated against the styles that exist because the API accepts any
  // well-shaped key; a typo would be stored and only fall back at generation time.
  if (flags.style) payload.aiStyle = await requireStyle(flags.style)

  const { status, body } = await api('/api/templates', json('POST', payload))
  if (status !== 201) failResponse(status, body, 'check the template fields and retry')

  const created = body?.template
  feedback(
    'template',
    'created',
    `user-${created.id} "${created.name}" (${content.length} chars, style ${created.aiStyle})`,
  )
}

/** `wrp templates clone` — the way to adapt an official template. */
export async function clone({ flags, positional }) {
  const source = await resolveRef(positional[0], CLONE_USAGE)
  const content = await readContent(flags, { usage: CLONE_USAGE })
  requireName(flags.name, { optional: true, usage: CLONE_USAGE })

  // The endpoint keys off the prefixed selection ID; a bare number is rejected
  // as TEMPLATE_NOT_FOUND, which resolveRef spares the caller.
  const payload = { sourceId: source.selectionId }
  if (flags.name) payload.name = flags.name
  if (content != null) payload.content = content

  const { status, body } = await api('/api/templates/clone', json('POST', payload))
  if (status !== 201) failResponse(status, body, `source template ${source.selectionId}`)

  const created = body?.template
  feedback(
    'template',
    'cloned',
    `user-${created.id} "${created.name}" (from ${source.selectionId}, ${created.content.length} chars, style ${created.aiStyle})`,
  )
}

/**
 * `wrp templates update` — only the named fields change.
 *
 * The PUT endpoint validates the whole object, so a partial body would be
 * rejected. Read the current row and resend it with the caller's overrides;
 * that is what turns a full replace into the partial edit they asked for.
 */
export async function update({ flags, positional }) {
  const template = requireUser(await resolveRef(positional[0], UPDATE_USAGE), 'edited')
  const content = await readContent(flags, { nonEmpty: true, usage: UPDATE_USAGE })

  const changed = ['name', 'content', 'file', 'description', 'tags', 'style'].filter(
    (key) => flags[key] != null,
  )
  if (changed.length === 0) {
    fail('nothing to update', 'pass at least one field', `usage: ${UPDATE_USAGE}`)
  }
  if (flags.name != null) requireName(flags.name, { usage: UPDATE_USAGE })
  if (flags.description != null && flags.description.length > DESCRIPTION_MAX) {
    fail('invalid description', `--description must be at most ${DESCRIPTION_MAX} characters (got ${flags.description.length})`, `usage: ${UPDATE_USAGE}`)
  }

  const payload = {
    name: flags.name != null ? flags.name.trim() : template.name,
    content: content != null ? content : template.content,
  }
  const description = flags.description != null ? flags.description : template.description
  const tags = flags.tags != null ? flags.tags : template.tags
  if (description) payload.description = description
  if (tags) payload.tags = tags
  payload.aiStyle = flags.style != null ? await requireStyle(flags.style) : template.aiStyle

  const { status, body } = await api(template.apiPath, json('PUT', payload))
  if (status !== 200) failResponse(status, body, `template ${template.selectionId}`)

  const updated = body?.template
  const fields = [...new Set(changed.map((field) => (field === 'file' ? 'content' : field)))]
  feedback('template', 'updated', `${template.selectionId} "${updated.name}" (changed: ${fields.join(', ')})`)
}

/** `wrp templates delete` — preview first, then require --confirm. */
export async function remove({ flags, positional }) {
  const template = requireUser(await resolveRef(positional[0], DELETE_USAGE), 'deleted')

  // Nothing restores a deleted template, and name resolution means the caller
  // may not have looked at what they matched — show it before the gate.
  if (!flags.confirm) {
    preview([
      `delete ${template.selectionId} "${template.name}"`,
      `${template.content.length} chars, style ${template.aiStyle}`,
      `opening: ${firstLine(template.content, 60) || '(empty)'}`,
      'reports already generated from it keep their own template snapshot and are unaffected',
    ])
    process.exitCode = 1
    return
  }

  const { status, body } = await api(template.apiPath, { method: 'DELETE' })
  if (status !== 200) failResponse(status, body, `template ${template.selectionId}`)

  feedback('template', 'deleted', `${template.selectionId} "${template.name}"`)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Fetch both collections in one call and normalize them to one shape. */
async function fetchAll() {
  const { status, body } = await api('/api/templates')
  if (status !== 200) failResponse(status, body, REF_FIX)
  return {
    official: (body?.official ?? []).map(normalizeOfficial),
    user: (body?.user ?? []).map(normalizeUser),
  }
}

/** Official templates are code constants: string id, array tags, never editable. */
function normalizeOfficial(row) {
  return {
    kind: 'official',
    selectionId: row.id,
    apiPath: null,
    name: row.name,
    content: row.content ?? '',
    description: row.description ?? null,
    tags: Array.isArray(row.tags) ? row.tags.join(', ') : (row.tags ?? null),
    aiStyle: row.aiStyle ?? 'formal',
    sourceTemplateId: null,
    createdAt: null,
    updatedAt: null,
  }
}

/** User templates are DB rows: numeric id, comma-string tags, full CRUD. */
function normalizeUser(row) {
  return {
    kind: 'user',
    selectionId: `user-${row.id}`,
    apiPath: `/api/templates/${row.id}`,
    numericId: row.id,
    name: row.name,
    content: row.content ?? '',
    description: row.description ?? null,
    tags: row.tags ?? null,
    aiStyle: row.aiStyle ?? 'formal',
    sourceTemplateId: row.sourceTemplateId ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

/**
 * Resolve a human reference to exactly one template.
 *
 * Accepts a selection ID (`official-general`, `user-3`), a bare numeric user ID
 * (`3`), or a case-insensitive name substring. Ambiguous names fail with the
 * candidate list rather than picking arbitrarily — a wrong edit is worse than a
 * retry. The selection ID is the form every report endpoint expects, so it is
 * what this module always reports back.
 */
async function resolveRef(ref, usage) {
  if (!ref) {
    fail('missing template reference', '', `usage: ${usage} (ID, user-<n>, official-<slug>, or a name substring)`)
  }
  const { official, user } = await fetchAll()
  return resolveIn([...official, ...user], ref)
}

function resolveIn(all, ref) {
  const exact = all.find((template) => template.selectionId === ref)
  if (exact) return exact

  if (/^\d+$/.test(ref)) {
    const byNumber = all.find((template) => template.kind === 'user' && String(template.numericId) === ref)
    if (byNumber) return byNumber
    fail('template not found', `no user template with ID ${ref}`, REF_FIX)
  }

  const needle = ref.toLowerCase()
  const byName = all.filter((template) => template.name.toLowerCase().includes(needle))
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    const candidates = byName.map((template) => `${template.selectionId} (${template.name})`).join(', ')
    fail(
      `ambiguous template reference: '${ref}'`,
      `matches ${byName.length} templates: ${candidates}`,
      'pass one of those IDs instead',
    )
  }
  fail('template not found', `no template matches '${ref}'`, REF_FIX)
}

function requireUser(template, action) {
  if (template.kind !== 'user') {
    fail(
      'official template is read-only',
      `'${template.name}' (${template.selectionId}) cannot be ${action}`,
      `clone it first: wrp templates clone ${template.selectionId} --name "<new name>"`,
    )
  }
  return template
}

/**
 * Check an aiStyle key against the styles that actually exist. The API only
 * regex-checks the shape, so a typo would be stored happily and then quietly
 * fall back at generation time — catching it here is the point.
 */
async function requireStyle(key) {
  if (!STYLE_KEY.test(key)) {
    fail(
      'invalid AI style key',
      `'${key}' must be lowercase, starting with a letter`,
      'run wrp styles list to see the available keys',
    )
  }
  const styles = await fetchStyles()
  if (!styles.some((style) => style.key === key)) {
    fail(
      'unknown AI style',
      `no style with key '${key}'`,
      `available: ${styleList(styles)}`,
    )
  }
  return key
}

async function fetchStyles() {
  const { status, body } = await api('/api/prompts/styles')
  if (status !== 200) failResponse(status, body, 'run wrp styles list to see the configured styles')
  return Array.isArray(body?.styles) ? body.styles : []
}

function styleList(styles) {
  return styles.map((style) => `${style.key} (${style.label})`).join(', ') || '(none configured)'
}

/**
 * Resolve template content from `--content` or `--file`.
 * `required` means create (exactly one must be present); otherwise absence means
 * "keep the source/current body". `nonEmpty` mirrors the create/update check —
 * clone deliberately allows an empty override (the API falls back to the source).
 * Preferred input is `--file`: template bodies are multi-line markdown and
 * shell quoting mangles anything longer than a sentence.
 */
async function readContent(flags, { required = false, nonEmpty = false, usage }) {
  if (flags.content != null && flags.file != null) {
    fail('conflicting template content', 'provide at most one of --content or --file', `usage: ${usage}`)
  }

  let content = flags.content
  if (flags.file != null) {
    try {
      content = await readFile(flags.file, 'utf8')
    } catch (error) {
      fail('cannot read content file', `${flags.file}: ${error.message}`, 'check the path and try again')
    }
  }

  if (required && content == null) {
    fail('missing template content', 'provide --content <text> or --file <path>', 'prefer --file for multi-line markdown bodies')
  }
  if (nonEmpty && content != null && !content.trim()) {
    fail('empty template content', 'content cannot be empty', 'pass the template text with --content or --file')
  }
  return content
}

function requireName(name, { optional = false, usage = CREATE_USAGE } = {}) {
  if (optional && name == null) return
  if (name == null || !String(name).trim()) {
    fail('missing template name', '', `usage: ${usage}`)
  }
  if (name.length > NAME_MAX) {
    fail('invalid template name', `--name must be at most ${NAME_MAX} characters (got ${name.length})`, 'shorten the name and retry')
  }
}

function printMeta(template) {
  const metadata = [template.kind, `style: ${template.aiStyle}`, `${template.content.length} chars`]
  if (template.tags) metadata.push(`tags: ${template.tags}`)
  if (template.sourceTemplateId) metadata.push(`cloned from ${template.sourceTemplateId}`)
  listLine(template.selectionId, metadata, template.name)
  console.log(`description: ${template.description ?? '—'}`)
  if (template.kind === 'user') {
    console.log(`created: ${formatDate(template.createdAt)}   updated: ${formatDate(template.updatedAt)}`)
  } else {
    console.log(`read-only — clone it to edit: wrp templates clone ${template.selectionId} --name "<new name>"`)
  }
}

function formatDate(value) {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** First line of a body, trimmed for one-line listings. */
function firstLine(text, max = 44) {
  const line = (text ?? '').split('\n').find((candidate) => candidate.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
