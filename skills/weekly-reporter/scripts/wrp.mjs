#!/usr/bin/env node
// wrp — the single entry point of the weekly-reporter skill.
//
//   wrp <module> <verb> [args]
//
// Everything goes through the command registry in `lib/registry.mjs`: it drives
// `--help` and flag validation, so a verb cannot exist without being documented.
// A verb that is registered but not built yet dispatches to a ✗ "not
// implemented" line, keeping the surface complete while module tickets land.

import { flagSpec, parseArgs } from './lib/args.mjs'
import { fail, failNotImplemented } from './lib/errors.mjs'
import {
  findCommand,
  findModule,
  MODULE_NAMES,
  renderCommandHelp,
  renderModuleHelp,
  renderRootHelp,
} from './registry.mjs'

// `plans comments add` is the only three-level command, so a verb is at most
// two words; anything beyond that is a positional argument.
const MAX_VERB_WORDS = 2

/** The line an agent can retype to reach a command's help. */
function helpHint(moduleName) {
  return `run wrp ${moduleName} --help to see its verbs`
}

const argv = process.argv.slice(2)

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(renderRootHelp())
  process.exit(0)
}

const [moduleName, ...rest] = argv
const module = findModule(moduleName)
if (!module) {
  fail(
    `unknown module: ${moduleName}`,
    '',
    `run wrp --help to see the modules (${MODULE_NAMES.join(', ')})`,
  )
}

const verbWords = []
while (verbWords.length < MAX_VERB_WORDS && rest.length > 0 && !rest[0].startsWith('-')) {
  verbWords.push(rest.shift())
}

// A bare module (`wrp init`) carries its single command on the module itself.
const bareEntry =
  module.commands.length === 1 && module.commands[0].module === null ? module.commands[0] : null

// `wrp init foo` would otherwise swallow `foo` as a positional and start the
// interactive prompt: a bare module has no verb words at all.
if (bareEntry && verbWords.length > 0) {
  fail(`unknown verb: wrp ${module.name} ${verbWords.join(' ')}`, '', `wrp ${module.name} takes flags only — run wrp ${module.name} --help`)
}

if (verbWords.length === 0 && !bareEntry) {
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    console.log(renderModuleHelp(module))
    process.exit(0)
  }
  fail(`missing verb for ${module.name}`, '', helpHint(module.name))
}

const entry = bareEntry ?? findCommand(module, verbWords)
if (!entry) {
  fail(`unknown verb: wrp ${module.name} ${verbWords.join(' ')}`, '', helpHint(module.name))
}

const commandName = entry.module ? `wrp ${entry.module} ${entry.name}` : `wrp ${module.name}`
const extraPositional = verbWords.slice(entry.name.split(' ').length)

const { flags, positional, help } = parseArgs(rest, flagSpec(entry.flags), `wrp ${module.name}`)
if (help) {
  console.log(renderCommandHelp(module, entry))
  process.exit(0)
}

// The arity ceiling: a verb that takes no positionals must reject extras
// instead of quietly ignoring them, so `wrp events list junk` is an error.
const allPositional = [...extraPositional, ...positional]
if (allPositional.length > entry.maxArgs) {
  const unexpected = allPositional.slice(entry.maxArgs)
  const limit =
    entry.maxArgs === 0
      ? `${commandName} takes no positional arguments`
      : `${commandName} takes at most ${entry.maxArgs} positional argument${entry.maxArgs === 1 ? '' : 's'}`
  fail(`unexpected argument${unexpected.length > 1 ? 's' : ''}`, unexpected.join(' '), `${limit} — usage: ${entry.usage}`)
}

if (!entry.run) failNotImplemented(commandName, entry.ticket)

try {
  await entry.run({ flags, positional: allPositional, module, entry })
} catch (error) {
  fail('unexpected error', error?.message ?? String(error), 're-run wrp --help to check the syntax')
}
