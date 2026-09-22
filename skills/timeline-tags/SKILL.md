---
name: timeline-tags
description: >-
  List, rename, and globally remove timeline tags (时间线标签) in the weekly-reporter app via Node.js scripts — see every tag with its event count, rename a tag across all events at once (merging into an existing tag when the target name is taken), or strip a tag from every event. Use this skill whenever the user mentions tags on timeline events or asks for tag-level operations: "有哪些标签", "哪个标签用得最多", "把 #调试 改成 #debug", "标签改个名", "这两个标签合并一下", "删掉 #临时 这个标签", "list my tags", "rename tag X to Y", "remove that tag from all events" — even if they never say the word "tag". Two boundaries: a tag on ONE event (add/change/remove on a single entry) means editing that event's content, which belongs to the timeline-events skill; 周报模板的标签字段 (template tags) belongs to the report-templates skill.
---

Manage timeline tags through three Node.js scripts under `{baseDir}/scripts/`. They use built-in `fetch` (Node 18+), take no dependencies, and read `WEEKLY_REPORTER_URL` from env (defaults to `http://localhost:6868`, the dev and systemd port for this app).

## What a tag is here

Tags are not standalone records. A tag is a `#name` token written inline in a manual event's content (e.g. `修复登录超时 #调试 #个人`); the app parses them out at write time and keeps a tag→events index. Only manual events participate — `#` inside auto-collected events is plain text. Consequently, renaming or removing a tag means **rewriting the content of every affected event** — these are global text operations, not metadata updates.

Two properties of the app's semantics matter for user expectations:

- **Rename merges silently.** If the target name already exists, the API merges the two tags instead of erroring. The plan output flags this; make sure the user sees it before approving. One artifact of merging: an event that carried both tags keeps a doubled inline token afterwards (e.g. `修复… #个人 #个人`) — the tag index dedupes, but the content text does not. Offer to clean those doubled tokens out of the affected events' content after the rename.
- **Weekly report snapshots are frozen.** Rename/remove only rewrites live timeline content. Reports already saved keep the old tag text — say so when it's relevant.

## List

```bash
node {baseDir}/scripts/list.mjs
```

One line per tag with its event count, alphabetically sorted. No arguments.

## Rename / Remove — always preview first

`rename.mjs <from> <to>` and `remove.mjs <name>` rewrite every affected event's content, so both refuse to run without `--confirm`. The gate exists because "删掉 #foo" is ambiguous (from one event? from everywhere?) and because merge-on-rename is silent at the API level. Work it like this:

1. Run the script **without** `--confirm`. It prints the plan — affected event count, plus a merge warning if the rename target already exists — and exits non-zero.
2. Show the user which events are affected:
   ```bash
   node {baseDir}/../timeline-events/scripts/query.mjs --tags <name>
   ```
3. Present plan + event samples to the user, including the merge warning (if any) and the frozen-snapshot caveat. "Remove #foo from 12 events — these samples … proceed?"
4. Only after explicit approval, re-run with `--confirm`.

```bash
node {baseDir}/scripts/rename.mjs <from> <to> --confirm   # → ✓ Renamed #a → #b on N event(s)
node {baseDir}/scripts/remove.mjs <name> --confirm         # → ✓ Removed tag #a from N event(s)
```

If the user's request is about a single event ("把昨天那条的 #会议 去掉"), that is an event edit — use timeline-events `update.mjs` with the new content, not a global operation.

## Tag name rules

Valid names: Chinese characters, Latin letters, digits — with at least one non-digit character. No hyphens, underscores, or any other symbol (`#my-tag` parses as `#my`). The scripts validate locally and exit with the reason before touching the API.

Placement in event content needs whitespace boundaries: a tag is recognized only at line start / after whitespace and only before whitespace / line end. `#tag1#tag2` glued together parses as neither. When you write tags into event content yourself, keep them inline at the end of the line, separated by spaces.

## Error handling

| Message | Cause | Fix |
|---|---|---|
| `Cannot reach weekly-reporter` | Server not running | Start with `npm run dev` |
| `no tag named '#x' exists` | Misspelled or already-gone tag | Run `list.mjs` to see what exists |
| `Tag name ... is invalid` | Charset rule violation | Rename within 中文/letters/digits, not digits-only |
| `NOT EXECUTED` | Ran without `--confirm` | Preview, get approval, re-run with `--confirm` |
| `Invalid request (HTTP 4xx)` | Bad input the client didn't catch | Read the error detail and retry |
