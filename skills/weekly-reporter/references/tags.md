# Tags (标签)

Global tag operations: `wrp tags list | rename | remove`. Commands are run as
`node {baseDir}/scripts/wrp.mjs tags …`; see the common contract in `SKILL.md`.

## What a tag is here

Tags are not standalone records. A tag is a `#name` token written inline in a
manual event's content (e.g. `修复登录超时 #调试 #个人`); the app parses them out
at write time and keeps a tag→events index. Only manual events participate — `#`
inside auto-collected events is plain text. Consequently, renaming or removing a
tag means **rewriting the content of every affected event** — these are global
text operations, not metadata updates.

Two properties of the app's semantics matter for user expectations:

- **Rename merges silently.** If the target name already exists, the API merges
  the two tags instead of erroring. The rename PLAN flags this with the target's
  event count; make sure the user sees it before approving. One artifact of
  merging: an event that carried both tags keeps a doubled inline token
  afterwards (e.g. `修复… #个人 #个人`) — the tag index dedupes, but the content
  text does not. After a rename that merged, offer to clean those doubled tokens
  out of the affected events' content (edit each event's content through the
  events module); the rename itself does not clean them.
- **Weekly report snapshots are frozen.** Rename/remove only rewrites live
  timeline content. Reports already saved keep the old tag text — say so when it
  is relevant.

## List

```bash
node {baseDir}/scripts/wrp.mjs tags list
```

One line per tag with its event count, in the order the API returns (alphabetical),
then the `— N tag(s)` footer. No arguments. When nothing exists yet it prints the
no-tags-yet hint — that is a normal answer, not an error.

## Rename / Remove — always preview first

`tags rename <from> <to>` and `tags remove <name>` rewrite every affected event's
content, so both refuse to run without `--confirm`. The gate exists because
"删掉 #foo" is ambiguous (from one event? from everywhere?) and because
merge-on-rename is silent at the API level. Work it like this:

1. Run the command **without** `--confirm`. It prints a `PLAN:` block — affected
   event count, plus a merge warning with the target's event count if the rename
   target already exists — then `NOT EXECUTED — re-run with --confirm`, and exits
   non-zero.
2. Show the user which events are affected:

   ```bash
   node {baseDir}/scripts/wrp.mjs events list --tags <name>
   ```

3. Present the plan and event samples to the user, including the merge warning
   (if any) and the frozen-snapshot caveat. "Remove #foo from 12 events — these
   samples … proceed?"
4. Only after explicit approval, re-run the same command with `--confirm`.

```bash
node {baseDir}/scripts/wrp.mjs tags rename <from> <to> --confirm  # ✓ tag renamed: #a → #b on N event(s)
node {baseDir}/scripts/wrp.mjs tags remove <name> --confirm        # ✓ tag removed: #a from N event(s)
```

A confirmed rename that merged adds `, merged with the existing tag` to its
feedback line. An unknown source tag is an error that points back at
`wrp tags list` — it is never treated as "create it".

If the user's request is about a single event ("把昨天那条的 #会议 去掉"), that is
an event edit — use the events module to update that event's content, not a
global operation.

## Tag name rules

Valid names: Chinese characters, Latin letters, digits — with at least one
non-digit character. No hyphens, underscores, or any other symbol (`#my-tag`
parses as `#my`). The client validates `rename`'s `from` and `to` and `remove`'s
name against this rule and exits with the rule in the message before touching the
API, so a bad name can never trigger a content rewrite.

Placement in event content needs whitespace boundaries: a tag is recognized only
at line start / after whitespace and only before whitespace / line end.
`#tag1#tag2` glued together parses as neither. When you write tags into event
content yourself, keep them inline at the end of the line, separated by spaces.
This is why `templates`' tag field is a different domain entirely: template tags
are metadata on a 周报模板, not `#name` tokens in event content.
