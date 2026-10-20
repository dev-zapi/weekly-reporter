---
name: report-templates
description: Read and manage weekly-report templates (周报模板) in this repo via Node.js scripts — list official and user templates, inspect a template's instruction text, create one from scratch, clone an official template into an editable copy, update its content/name/tags/AI style, or delete it. Use this skill whenever the user mentions 周报模板/report template/模板内容/官方模板/模板风格 or asks things like "有哪些周报模板", "看下技术研发模板写了什么", "新建一个模板", "把官方极简模板复制出来改一改", "改一下模板的章节", "这个模板用哪个 AI 风格", "删掉那个测试模板", or needs the template ID to start a final-generation session. For the reports themselves (原稿/终版/受众版本) use the weekly-reports skill; for single work-log entries use timeline-events.
---

Manage weekly-report templates through six Node.js scripts under `{baseDir}/scripts/`. They use built-in `fetch` (Node 18+), take no dependencies, and read credentials from the env (`WEEKLY_REPORTER_PAT` for the token; `WEEKLY_REPORTER_BASE_URL`, or its alias `WEEKLY_REPORTER_URL`, for the base URL) or from the machine credential at `~/.config/weekly-reporter/auth.json`; the base URL defaults to `http://localhost:6868`, the dev and systemd port for this app. Without a PAT every `/api/**` call returns 401 — run the **configure-pat** skill to set one up.

## What a template actually is here

A template is **prose instructions for the AI that writes a 终版 (final report)** — target format, writing requirements, example sections. The app never parses it or substitutes variables into it: it hands the text to the model alongside the 原稿 (source draft). So a template that reads like a fill-in-the-blank form with `{{placeholders}}` will not behave like one, and `/api/templates/[id]/render` returns HTTP 410 by design. If a user asks to "render" a template, what they want is a generation session in the app at `/edit/[id]`.

Two kinds exist, and the difference decides whether a request is even possible:

- **official** — hardcoded in `src/lib/official-templates.ts`, IDs like `official-general`. Read-only; there is no endpoint to change or delete them. To adapt one, clone it.
- **user** — rows in the `templates` table, numeric IDs. Full create/update/delete.

**The two ID forms are the main trap.** Generation endpoints and `sourceTemplateId` use the prefixed *selection ID* (`official-general`, `user-3`), while the REST path for a user template uses the bare number (`/api/templates/3`). Every script here takes a flexible `<ref>` — selection ID, bare user ID, or a case-insensitive name substring — and resolves it for you, failing with the candidate list if a name is ambiguous. Report the selection ID back to the user, since that's the form the generation API needs.

Editing or deleting a template does **not** disturb reports already generated from it: each final and each generation session stores its own template snapshot. Say so when a user hesitates to change a template that's "already in use" — that fear is the usual reason people clone when they didn't need to.

## Reading

`list.mjs` is the right first call for almost anything, including "which template should I use" — it prints both kinds with selection IDs, AI style, size, tags, and the opening line.

```bash
node {baseDir}/scripts/list.mjs [--kind <official|user|all>] [--query <text>]
```

`--query` matches name, content, tags and description, so it finds "the template that mentions 风险" without the user remembering which field it lived in.

```bash
node {baseDir}/scripts/show.mjs <ref> [--part <meta|content|both>]
```

Defaults to `both`; templates run a few hundred characters, so printing the full text is usually fine. `--part meta` is there for when you only need the style or the ID.

## Writing

These change stored data. Templates are short and hand-written, so confirm the actual text with the user rather than inventing sections they didn't ask for.

```bash
node {baseDir}/scripts/create.mjs --name <text> (--content <text> | --file <path>) \
  [--description <text>] [--tags <a,b>] [--style <key>]
```

Prefer `--file` — templates are multi-line markdown and shell quoting mangles them. `--name` is capped at 100 chars, `--description` at 200, `tags` is a free-form comma string. `--style` is checked against the AI styles that actually exist (`formal`, `technical`, `concise`, `detailed` by default) because the API accepts any well-shaped key and a typo would otherwise sit there until it silently fell back during generation.

```bash
node {baseDir}/scripts/clone.mjs <ref> [--name <text>] [--content <text> | --file <path>]
```

The way to "edit" an official template. Copies name, content and AI style; description and tags are not carried over. Pass `--name` when cloning within the user set, otherwise you get two templates with the same name and only the ID to tell them apart.

```bash
node {baseDir}/scripts/update.mjs <ref> [--name <text>] [--content <text> | --file <path>] \
  [--description <text>] [--tags <a,b>] [--style <key>]
```

Only the fields you pass change — the script reads the current row and resends the rest, because the endpoint validates the whole object and would reject a name-less body. For a small wording change, read the content with `show.mjs`, write the edited version to a temp file, and pass `--file`; that's more reliable than trying to express a multi-line body inline.

```bash
node {baseDir}/scripts/delete.mjs <ref> --confirm
```

Without `--confirm` it prints what it resolved and exits 1 — run it that way first and show the user, especially when the ref was a name substring rather than an ID. Nothing restores a deleted template, though as noted above, existing reports are unaffected.

## Out of scope

These scripts cover `/api/templates/*` only. Starting a generation session and producing a 终版 from a template is a streaming NDJSON interface driven from the app UI at `/edit/[id]` — do it there, not here. AI styles themselves (`/api/prompts/styles`) are only read, to validate `--style`; managing styles and system prompts belongs to the `/prompts` page.

## Errors

All scripts exit 0 on success and non-zero on failure, printing one actionable line to stderr.

| Message | Cause | What to do |
|---|---|---|
| `Unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | Run the **configure-pat** skill (`node scripts/configure-pat.mjs`) |
| `Cannot reach weekly-reporter` | Server not running, or wrong port | `npm run dev`, or set `WEEKLY_REPORTER_URL` |
| `no template matches '<ref>'` | Wrong ID or name | Run `list.mjs` |
| `'<ref>' matches N templates` | Name substring hit several | Rerun with one of the printed selection IDs |
| `is an official template and cannot be edited/deleted` | Official templates are code | `clone.mjs` it, then edit the copy |
| `no AI style with key '<k>'` | Style doesn't exist | Use one of the keys listed in the error |
| `Validation failed [VALIDATION_ERROR]` | Empty name/content, or name >100 / description >200 chars | Fix the input and retry |
| `Source template not found [TEMPLATE_NOT_FOUND]` (clone) | Unprefixed `sourceId` reached the API | Pass the ref to `clone.mjs` and let it resolve |
| `TEMPLATE_RENDER_REMOVED` (410) | Something called `/render` | Templates aren't rendered; generate a final in the app |
