// Flag parser for the wrp client.
//
// Three flag kinds: `value` (takes an argument), `boolean` (presence only) and
// `multi` (repeatable, accumulates into an array). `--flag-name` becomes
// `flags.flagName`, so a command reads `flags.weekStart` regardless of the
// dashed spelling.
//
// Unknown flags are rejected instead of ignored: a typo must surface as a ✗
// line, never as a silently dropped filter.

import { fail } from './errors.mjs'

/** `[{ name, kind }]` from the command registry → `{ '--name': kind }`. */
export function flagSpec(flags = []) {
  return Object.fromEntries(flags.map((flag) => [flag.name, flag.kind]))
}

function camelCase(flag) {
  return flag.slice(2).replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
}

/**
 * Parse `argv` against `spec`. Returns `{ flags, positional, help }`;
 * `help` is true when `--help`/`-h` was passed (the caller prints usage).
 */
export function parseArgs(argv, spec = {}, usage = 'wrp --help') {
  const flags = {}
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { flags, positional, help: true }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const kind = spec[arg]
    if (!kind) fail(`unknown flag: ${arg}`, '', `run ${usage} --help to see the flags this command takes`)
    if (kind === 'boolean') {
      flags[camelCase(arg)] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) fail(`missing value for ${arg}`, '', `pass ${arg} <value>`)
    if (kind === 'multi') {
      ;(flags[camelCase(arg)] ||= []).push(value)
    } else {
      flags[camelCase(arg)] = value
    }
  }

  return { flags, positional, help: false }
}

/** A positional argument, or one ✗ line naming what was missing. */
export function requireArg(positional, index, label, usage) {
  const value = positional[index]
  if (value === undefined || value.trim() === '') {
    fail(`missing ${label}`, '', `usage: ${usage}`)
  }
  return value
}

/** A required value flag, or one ✗ line naming what was missing. */
export function requireFlag(flags, name, label, usage) {
  const value = flags[name]
  if (value === undefined || String(value).trim() === '') {
    fail(`missing ${label} (--${name})`, '', `usage: ${usage}`)
  }
  return value
}
