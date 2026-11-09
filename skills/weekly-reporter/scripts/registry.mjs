// The command registry: the single source of truth for `wrp --help`, per-module
// help, flag validation and dispatch.
//
// The full approved surface from spec #119 lives here from day one, including
// the verbs later tickets implement - an unbuilt verb is registered with a
// `ticket` field instead of an `run` function, so it dispatches to a clear
// "not implemented" ✗ line rather than an "unknown word" one. Help text is
// generated from this table; never hand-maintain usage strings.
//
// Entry shape:
//   { name, summary, usage, flags: [{ name, kind, summary }], run?, ticket? }
// `kind` is `value` | `boolean` | `multi` (see lib/args.mjs).

import * as events from './modules/events.mjs'
import * as init from './modules/init.mjs'
import * as reports from './modules/reports.mjs'
import * as styles from './modules/styles.mjs'
import * as tags from './modules/tags.mjs'
import * as templates from './modules/templates.mjs'

export const MODULES = [
  {
    name: 'init',
    summary: 'Provision machine credentials (PAT) for this machine',
    commands: [command('init', null, 'Store, inspect or clear machine credentials (one mode per run)', 'wrp init [--pat <token> [--base-url <url>] | --base-url <url> [--name <name>] | --show | --clear]', [
      flag('--pat', 'value', 'store this PAT directly'),
      flag('--base-url', 'value', 'base URL to store, or to provision against'),
      flag('--name', 'value', 'PAT name for interactive creation (default: <hostname>-cli)'),
      flag('--show', 'boolean', 'print the configured base URL and masked PAT'),
      flag('--clear', 'boolean', 'remove machine credentials'),
    ], null, init.run)],
  },
  {
    name: 'sources',
    summary: 'Collect sources (采集源): list, inspect, create, edit, enable, sync',
    commands: [
      command('list', 'sources', 'List collect sources', 'wrp sources list [--name] [--type] [--status] [--scope] [--sync]', [
        flag('--name', 'value', 'match name or alias'),
        flag('--type', 'value', 'git-local | github | gitlab | gitee'),
        flag('--status', 'value', 'available | unavailable | error'),
        flag('--scope', 'value', 'project scope'),
        flag('--sync', 'value', 'sync state filter'),
      ], 124),
      command('show', 'sources', 'Show one source with its config, cursors and timestamps', 'wrp sources show <ref>', [], 124),
      command('create', 'sources', 'Create a collect source', 'wrp sources create --type <type> --name <name> [flags]', [
        flag('--type', 'value', 'git-local | github | gitlab | gitee'),
        flag('--name', 'value', 'source name'),
        flag('--path', 'value', 'local repository path (git-local)'),
        flag('--owner', 'value', 'repository owner (remote types)'),
        flag('--repo', 'value', 'repository name (remote types)'),
        flag('--token', 'value', 'access token (remote types)'),
        flag('--base-url', 'value', 'self-hosted API base URL'),
        flag('--email', 'multi', 'author email to collect (repeatable)'),
        flag('--branch', 'multi', 'branch to collect (repeatable; default all)'),
        flag('--alias', 'multi', 'alias for the source (repeatable)'),
        flag('--scope', 'value', 'project scope'),
      ], 124),
      command('update', 'sources', 'Update a source, backfilling fields you did not pass', 'wrp sources update <ref> [flags]', [
        flag('--name', 'value', 'source name'),
        flag('--scope', 'value', 'project scope'),
        flag('--email', 'multi', 'replace the author emails'),
        flag('--add-email', 'multi', 'append an author email'),
        flag('--alias', 'multi', 'replace the aliases'),
        flag('--add-alias', 'multi', 'append an alias'),
        flag('--branch', 'multi', 'replace the branches'),
        flag('--path', 'value', 'local repository path'),
        flag('--owner', 'value', 'repository owner'),
        flag('--repo', 'value', 'repository name'),
        flag('--base-url', 'value', 'self-hosted API base URL'),
        flag('--token', 'value', 'access token'),
      ], 124),
      command('enable', 'sources', 'Enable a source (or disable it with --off)', 'wrp sources enable <ref> [--off]', [
        flag('--off', 'boolean', 'disable instead of enable'),
      ], 124),
      command('delete', 'sources', 'Delete a source (preview first)', 'wrp sources delete <ref> [--confirm]', [
        flag('--confirm', 'boolean', 'execute the previewed deletion'),
      ], 124),
      command('lookup', 'sources', 'Look a source up by repository path (exit 3 when absent)', 'wrp sources lookup --path <repo-root>', [
        flag('--path', 'value', 'local repository path'),
      ], 128),
      command('emails', 'sources', 'List commit authors and counts for a repository', 'wrp sources emails --path <repo-root>', [
        flag('--path', 'value', 'local repository path'),
      ], 128),
      command('sync', 'sources', 'Sync a source, reporting scanned commits and new events', 'wrp sources sync <ref> [--enable]', [
        flag('--enable', 'boolean', 'enable the source before syncing'),
      ], 128),
    ],
  },
  {
    name: 'events',
    summary: 'Timeline events (时间线事件): list, create, update, delete',
    commands: [
      command('list', 'events', 'List events', 'wrp events list [--date] [--week-start --week-end] [--tags] [--source] [--limit] [--cursor]', [
        flag('--date', 'value', 'single day (YYYY-MM-DD)'),
        flag('--week-start', 'value', 'week start (YYYY-MM-DD)'),
        flag('--week-end', 'value', 'week end (YYYY-MM-DD)'),
        flag('--tags', 'value', 'comma-separated tag names'),
        flag('--source', 'value', 'manual | auto'),
        flag('--limit', 'value', 'page size'),
        flag('--cursor', 'value', 'continue a page: <id>@<epoch-millis>'),
      ], null, events.list),
      command('create', 'events', 'Create an event', 'wrp events create <content> [--time <iso>]', [
        flag('--time', 'value', 'event time (ISO 8601)'),
      ], null, events.create),
      command('update', 'events', 'Update an event', 'wrp events update <id> [--content] [--time] [--important]', [
        flag('--content', 'value', 'new single-line content'),
        flag('--time', 'value', 'new event time (ISO 8601)'),
        flag('--important', 'value', 'true | false'),
      ], null, events.update),
      command('delete', 'events', 'Delete a manual event (auto-collected ones are refused)', 'wrp events delete <id>', [], null, events.deleteEvent),
    ],
  },
  {
    name: 'tags',
    summary: 'Timeline tags (标签): list, rename, remove',
    commands: [
      command('list', 'tags', 'List tags with event counts', 'wrp tags list', [], 123, tags.list),
      command('rename', 'tags', 'Rename a tag everywhere (preview first; merges on collision)', 'wrp tags rename <from> <to> [--confirm]', [
        flag('--confirm', 'boolean', 'execute the previewed rename'),
      ], 123, tags.rename),
      command('remove', 'tags', 'Remove a tag from every event (preview first)', 'wrp tags remove <name> [--confirm]', [
        flag('--confirm', 'boolean', 'execute the previewed removal'),
      ], 123, tags.remove),
    ],
  },
  {
    name: 'plans',
    summary: 'Period plans (周计划), plan items and their comments (评论)',
    commands: [
      command('list', 'plans', 'List plan items for a period', 'wrp plans list --scope <week|month> [--date] [--week-start --week-end] [--month]', [
        flag('--scope', 'value', 'week | month'),
        flag('--date', 'value', 'any day inside the period (YYYY-MM-DD)'),
        flag('--week-start', 'value', 'week start (YYYY-MM-DD)'),
        flag('--week-end', 'value', 'week end (YYYY-MM-DD)'),
        flag('--month', 'value', 'month key (YYYY-MM)'),
      ], 125),
      command('add', 'plans', 'Add a plan item (creating the period plan when needed)', 'wrp plans add --scope <week|month> --text <text> [flags]', [
        flag('--scope', 'value', 'week | month'),
        flag('--text', 'value', 'item text'),
        flag('--week-start', 'value', 'week start (YYYY-MM-DD)'),
        flag('--week-end', 'value', 'week end (YYYY-MM-DD)'),
        flag('--month', 'value', 'month key (YYYY-MM)'),
        flag('--project', 'value', 'project name'),
        flag('--parent', 'value', 'parent item id'),
        flag('--priority', 'value', 'priority level'),
        flag('--important', 'value', 'true | false'),
        flag('--urgent', 'value', 'true | false'),
      ], 125),
      command('update', 'plans', 'Update a plan item', 'wrp plans update <id> [--text] [--status] [--position] [--parent] [--priority] [--important] [--urgent]', [
        flag('--text', 'value', 'new text'),
        flag('--status', 'value', 'item status'),
        flag('--project', 'value', 'project name'),
        flag('--position', 'value', 'position within the period'),
        flag('--parent', 'value', 'parent item id'),
        flag('--priority', 'value', 'priority level'),
        flag('--important', 'value', 'true | false'),
        flag('--urgent', 'value', 'true | false'),
      ], 125),
      command('defer', 'plans', 'Defer an item into the next period (顺延)', 'wrp plans defer <id>', [], 125),
      command('delete', 'plans', 'Delete a plan item', 'wrp plans delete <id>', [], 125),
      command('comments list', 'plans', 'List the comment chain of a plan item', 'wrp plans comments list <item-id>', [], 125),
      command('comments add', 'plans', 'Add a comment to a plan item', 'wrp plans comments add <item-id> --text <text>', [
        flag('--text', 'value', 'comment text'),
      ], 125),
      command('comments delete', 'plans', 'Delete a comment from a plan item', 'wrp plans comments delete <item-id> <comment-id>', [], 125),
    ],
  },
  {
    name: 'templates',
    summary: 'Report templates (周报模板): list, show, create, clone, update, delete',
    commands: [
      command('list', 'templates', 'List templates (official and user)', 'wrp templates list [--kind] [--query]', [
        flag('--kind', 'value', 'official | user | all'),
        flag('--query', 'value', 'match name, content, tags or description'),
      ], 126, templates.list),
      command('show', 'templates', 'Show one template', 'wrp templates show <ref> [--part meta|content|both]', [
        flag('--part', 'value', 'meta | content | both (default: both)'),
      ], 126, templates.show),
      command('create', 'templates', 'Create a user template', 'wrp templates create --name <name> (--content <text> | --file <path>) [flags]', [
        flag('--name', 'value', 'template name'),
        flag('--content', 'value', 'single-line content (prefer --file)'),
        flag('--file', 'value', 'read the content from a file'),
        flag('--description', 'value', 'template description'),
        flag('--tags', 'value', 'comma-separated tags'),
        flag('--style', 'value', 'AI style key'),
      ], 126, templates.create),
      command('clone', 'templates', 'Clone a template (the way to adapt an official one)', 'wrp templates clone <ref> [--name] [--content|--file]', [
        flag('--name', 'value', 'name for the copy'),
        flag('--content', 'value', 'single-line content override'),
        flag('--file', 'value', 'read the content override from a file'),
      ], 126, templates.clone),
      command('update', 'templates', 'Update a user template', 'wrp templates update <ref> [--name] [--content|--file] [--description] [--tags] [--style]', [
        flag('--name', 'value', 'template name'),
        flag('--content', 'value', 'single-line content'),
        flag('--file', 'value', 'read the content from a file'),
        flag('--description', 'value', 'template description'),
        flag('--tags', 'value', 'comma-separated tags'),
        flag('--style', 'value', 'AI style key'),
      ], 126, templates.update),
      command('delete', 'templates', 'Delete a user template (preview first)', 'wrp templates delete <ref> [--confirm]', [
        flag('--confirm', 'boolean', 'execute the previewed deletion'),
      ], 126, templates.remove),
    ],
  },
  {
    name: 'styles',
    summary: 'AI writing styles (AI 风格): list, show',
    commands: [
      command('list', 'styles', 'List the AI style keys', 'wrp styles list', [], 126, styles.list),
      command('show', 'styles', 'Show one AI style prompt', 'wrp styles show <key>', [], 126, styles.show),
    ],
  },
  {
    name: 'reports',
    summary: 'Weekly reports (周报): list, show, preview, create, regenerate, save-final, delete',
    commands: [
      command('list', 'reports', 'List weekly reports (search mode on --query/--start/--end)', 'wrp reports list [--page] [--page-size] [--query] [--start] [--end]', [
        flag('--page', 'value', 'page number'),
        flag('--page-size', 'value', 'page size'),
        flag('--query', 'value', 'match title, draft or final'),
        flag('--start', 'value', 'period start (YYYY-MM-DD)'),
        flag('--end', 'value', 'period end (YYYY-MM-DD)'),
      ], 127, reports.list),
      command('show', 'reports', 'Show one report (metadata only unless --part asks for the text)', 'wrp reports show <id> [--variant] [--part meta|draft|final|both]', [
        flag('--variant', 'value', 'report variant'),
        flag('--part', 'value', 'meta | draft | final | both'),
      ], 127, reports.show),
      command('preview', 'reports', 'Preview the events a report would snapshot (creates nothing)', 'wrp reports preview --start <date> --end <date> [--variant] [--full]', [
        flag('--start', 'value', 'period start (YYYY-MM-DD)'),
        flag('--end', 'value', 'period end (YYYY-MM-DD)'),
        flag('--variant', 'value', 'report variant'),
        flag('--full', 'boolean', 'print every line, not just the first 12'),
      ], 127, reports.preview),
      command('create', 'reports', 'Create a report (snapshots events, builds both drafts)', 'wrp reports create --title <text> --start <date> --end <date>', [
        flag('--title', 'value', 'report title'),
        flag('--start', 'value', 'period start (YYYY-MM-DD)'),
        flag('--end', 'value', 'period end (YYYY-MM-DD)'),
      ], 127, reports.create),
      command('regenerate-source', 'reports', 'Rebuild both source drafts, bump the revision and mark adopted finals stale', 'wrp reports regenerate-source <id>', [], 127, reports.regenerateSource),
      command('save-final', 'reports', 'Save a final for one variant (409 when the draft moved)', 'wrp reports save-final <id> --variant <v> (--content|--file) [flags]', [
        flag('--variant', 'value', 'report variant'),
        flag('--content', 'value', 'final content (prefer --file)'),
        flag('--file', 'value', 'read the final from a file'),
        flag('--source-revision', 'value', 'source revision the final was built from'),
        flag('--template-id', 'value', 'template provenance'),
        flag('--ai-style-key', 'value', 'AI style provenance'),
      ], 127, reports.saveFinal),
      command('delete', 'reports', 'Delete a report (preview first)', 'wrp reports delete <id> [--confirm]', [
        flag('--confirm', 'boolean', 'execute the previewed deletion'),
      ], 127, reports.remove),
    ],
  },
]

// `run` marks a verb as built; `ticket` records where an unbuilt one lands.
function command(name, module, summary, usage, flags, ticket, run) {
  return { name, module, summary, usage, flags, ticket, run }
}

function flag(name, kind, summary) {
  return { name, kind, summary }
}

export function findModule(name) {
  return MODULES.find((module) => module.name === name)
}

/** Resolve `<verb words…>` for one module: `comments add` wins over `comments`. */
export function findCommand(module, words) {
  const candidates = words.map((word) => word.toLowerCase())
  let best = null
  for (const candidate of module.commands) {
    const parts = candidate.name.split(' ')
    if (parts.length > candidates.length) continue
    if (!parts.every((part, index) => part === candidates[index])) continue
    if (!best || parts.length > best.name.split(' ').length) best = candidate
  }
  return best
}

export const MODULE_NAMES = MODULES.map((module) => module.name)

/** Every registered command line, in registry order (help + tests). */
export function allCommandLines() {
  return MODULES.flatMap((module) =>
    module.commands.map((entry) => (entry.module ? `wrp ${entry.module} ${entry.name}` : `wrp ${module.name}`)),
  )
}

// ---------------------------------------------------------------------------
// Help, rendered from the table above. Nothing here is hand-maintained, so a
// new verb cannot ship without appearing in `wrp --help`.
// ---------------------------------------------------------------------------

const INDENT = '  '

function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** A command's printable line: `wrp plans comments add`, `wrp init`. */
export function commandLine(module, entry) {
  return entry.module ? `wrp ${entry.module} ${entry.name}` : `wrp ${module.name}`
}

export function renderRootHelp() {
  const lines = []
  lines.push('wrp — unified client for the weekly-reporter app')
  lines.push('')
  lines.push('Usage: wrp <module> <verb> [args]')
  lines.push('')
  lines.push('Modules:')

  const width = Math.max(...MODULES.map((module) => module.name.length)) + 4
  for (const module of MODULES) {
    // A bare module (`wrp init`) has no verb to enumerate beyond its own name.
    const bare = module.commands.every((entry) => entry.module === null)
    const verbs = bare ? [] : [...new Set(module.commands.map((entry) => entry.name.split(' ')[0]))]
    lines.push(`${INDENT}${pad(module.name, width)}${verbs.join(' | ')}`.trimEnd())
    lines.push(`${INDENT}${' '.repeat(width)}${module.summary}`)
  }

  lines.push('')
  lines.push('Commands:')
  for (const line of allCommandLines()) lines.push(`${INDENT}${line}`)

  lines.push('')
  lines.push('Common:')
  lines.push(`${INDENT}wrp --help                   this list`)
  lines.push(`${INDENT}wrp <module> --help          the verbs of one module`)
  lines.push(`${INDENT}wrp <module> <verb> --help   the flags of one verb`)
  lines.push('')
  lines.push('Environment:')
  lines.push(`${INDENT}WEEKLY_REPORTER_PAT        personal access token`)
  lines.push(`${INDENT}WEEKLY_REPORTER_BASE_URL   API base URL (alias: WEEKLY_REPORTER_URL)`)
  lines.push(`${INDENT}(otherwise ~/.config/weekly-reporter/auth.json, default http://localhost:6868)`)
  return lines.join('\n')
}

export function renderModuleHelp(module) {
  const lines = []
  const title = module.commands[0]?.module ?? module.name
  lines.push(`wrp ${title} — ${module.summary}`)
  lines.push('')
  lines.push('Commands:')
  for (const entry of module.commands) {
    lines.push(`${INDENT}${commandLine(module, entry)}`)
    lines.push(`${INDENT}${INDENT}${entry.summary}`)
  }
  lines.push('')
  lines.push('Usage:')
  for (const entry of module.commands) lines.push(`${INDENT}${entry.usage}`)
  lines.push('')
  lines.push(`${INDENT}wrp ${title} --help   this list`)
  return lines.join('\n')
}

export function renderCommandHelp(module, entry) {
  const lines = []
  const name = entry.module ? `${entry.module} ${entry.name}` : module.name
  lines.push(`wrp ${name} — ${entry.summary}`)
  lines.push('')
  lines.push(`Usage: ${entry.usage}`)
  if (entry.flags.length > 0) {
    lines.push('')
    lines.push('Flags:')
    const width = Math.max(...entry.flags.map((item) => item.name.length)) + 4
    for (const item of entry.flags) lines.push(`${INDENT}${pad(item.name, width)}${item.summary}`)
  }
  if (entry.ticket && !entry.run) {
    lines.push('')
    lines.push(`Not implemented yet (tracked in ticket #${entry.ticket}).`)
  }
  return lines.join('\n')
}
