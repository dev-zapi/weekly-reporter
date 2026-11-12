# Templates (周报模板) and AI styles (AI 风格)

Manage weekly-report templates through `wrp templates …`, and read the AI writing
styles through `wrp styles …`. Both talk to `/api/templates*` and
`/api/prompts/styles`.

## What a template actually is here

A template is **prose instructions for the AI that writes a 终版 (final report)** —
target format, writing requirements, example sections. The app never parses it and
never substitutes variables into it: it hands the text to the model alongside the
原稿 (source draft). A template that reads like a fill-in-the-blank form with
`{{placeholders}}` will not behave like one, and `/api/templates/{id}/render`
answers HTTP **410 `TEMPLATE_RENDER_REMOVED`** by design. If a user asks to "render"
a template, what they want is a generation session in the app at `/edit/{id}` —
point them there; do not look for a render verb in `wrp`.

Two kinds exist, and the difference decides whether a write is even possible:

- **official** — hardcoded in the app (`internal/officialtemplates`), string IDs such
  as `official-general`, `official-tech-dev`, `official-minimal`,
  `official-personal-review`. Read-only: there is no endpoint that edits or deletes
  them. To adapt one, clone it.
- **user** — rows in the `templates` table with numeric IDs. Full create / update /
  delete.

### The two-ID trap

Generation endpoints and `sourceTemplateId` use the prefixed **selection ID**
(`official-general`, `user-3`), while the REST path for a user template uses the
bare number (`/api/templates/3`). Mixing them is the most common failure: a bare
number sent as `sourceId` reaches the clone endpoint as `TEMPLATE_NOT_FOUND`.

Every `wrp templates` verb takes a flexible `<ref>` and resolves it for you:

- a selection ID — `official-general`, `user-3`
- a bare numeric user ID — `3`
- a case-insensitive **name substring** — `极简`

A ref that matches several names fails with the candidate list instead of picking
one arbitrarily; re-run with one of the printed selection IDs.
Always report the **selection ID** back to the user: it is the form the report
generation API expects.

### Snapshot independence

Editing or deleting a template does **not** disturb reports already generated from
it: every final and every generation session stores its own template snapshot
(see 模板快照 in CONTEXT.md). Say so when a user hesitates to change a template that
is "already in use" — that fear is the usual reason people clone when they did not
need to. A template edit affects generation sessions started from now on only.

## Reading

`wrp templates list` is the right first call for almost anything, including "which
template should I use". It prints the `/api/templates` response body **verbatim**
as one line of compact JSON: the `official` and `user` arrays, every row complete
— including each template's full `content`. Parse the line with `JSON.parse`; do
not scrape text out of it.

```bash
wrp templates list [--kind official|user|all] [--query <text>]
```

```json
{"official":[{"id":"official-general","name":"通用正式周报模板","description":"适用于大多数场景的正式周报","tags":["正式","通用"],"content":"你是通用正式写作助手。\n请按正式格式总结风险与进展。","aiStyle":"formal"}],"user":[{"id":3,"name":"我的极简模板","content":"你是极简写作助手。\n只写结论，不写背景。","description":"个人用的极简模板","tags":"个人,极简","sourceTemplateId":"official-minimal","aiStyle":"concise","createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-02T09:30:00.000Z"}]}
```

`--query` matches name, content, tags and description, so it finds "the template
that mentions 风险" without the user remembering which field it lived in. `--kind`
defaults to `all`. Both flags select rows client-side: the body keeps the same
`{official, user}` shape (the unselected collection is `[]`) and every emitted row
is the API row untouched. With neither flag the response is passed through
unchanged. Zero matches is a successful empty body — `{"official":[],"user":[]}` —
not a prose message.

```bash
wrp templates show <ref> [--part meta|content|both]
```

The output is the resolved row from the list response, verbatim:

```json
{"id":3,"name":"我的极简模板","content":"你是极简写作助手。\n只写结论，不写背景。","description":"个人用的极简模板","tags":"个人,极简","sourceTemplateId":"official-minimal","aiStyle":"concise","createdAt":"2026-10-01T08:00:00.000Z","updatedAt":"2026-10-02T09:30:00.000Z"}
```

`--part` selects a sub-object of that row: `both` (default) is the whole row,
`content` is just the JSON string of its `content`, and `meta` is the row without
`content`. Templates run a few hundred characters, so `both` is usually fine;
`meta` is the cheap read when you only need the style, the ID or the timestamps.
Timestamps stay exactly as the API sent them — no timezone reformatting.

## Writing

These change stored data. Templates are short and hand-written, so confirm the
actual text with the user rather than inventing sections they did not ask for.

```bash
wrp templates create --name <text> (--content <text> | --file <path>) \
  [--description <text>] [--tags <a,b>] [--style <key>]
```

Prefer `--file`: template bodies are multi-line markdown, and shell quoting mangles
anything longer than a sentence. Limits, enforced before the request:

- `--name` — required, at most **100 characters**
- `content` — required, non-empty, no length cap
- `--description` — optional, at most **200 characters**
- `--tags` — free-form comma string (e.g. `正式,通用`)

`--style` is checked against the AI styles that **actually exist** (see below),
because the API accepts any well-shaped key (`^[a-z][a-z0-9_-]*$`) and a typo would
otherwise sit there until it silently fell back during generation. An unknown key
fails with the valid keys listed.

```bash
wrp templates clone <ref> [--name <text>] [--content <text> | --file <path>]
```

The way to "edit" an official template. The clone endpoint copies **name, content
and AI style**; **description and tags are not carried over** — set them with
`wrp templates update` on the copy if needed. Pass `--name` when cloning within the
user set, otherwise you get two templates with the same name and only the ID to tell
them apart (the server keeps the source name when `--name` is omitted).

```bash
wrp templates update <ref> [--name <text>] [--content <text> | --file <path>] \
  [--description <text>] [--tags <a,b>] [--style <key>]
```

Only the fields you pass change. The PUT endpoint validates the whole object and
would reject a name-less body, so this verb reads the current row and resends it
with your overrides — a partial edit on the wire is a full replace. Official
templates are refused with the clone hint. For a small wording change, read the
content with `show`, write the edited version to a temp file, and pass `--file`;
that is more reliable than expressing a multi-line body inline.

```bash
wrp templates delete <ref> [--confirm]
```

Without `--confirm` it prints a `PLAN:` (the resolved template, size, opening line,
and the snapshot note) and exits **1** — run it that way first and show the user,
especially when the ref was a name substring rather than an ID. Nothing restores a
deleted template, though existing reports are unaffected as noted above. Official
refs are refused with the clone hint even with `--confirm`.

## AI styles (read-only)

A style is a writing-voice configuration — system prompt, temperature, detail level —
stored in the `ai_styles` table. Styles are managed on the app's `/prompts` page
(风格管理), **not** by this client. `wrp` reads them for two reasons: so a writing
session can use a style's exact voice, and so `--style` can be validated against
what exists.

```bash
wrp styles list
wrp styles show <key>
```

Both are read verbs: each prints its API response body **verbatim** as one line of
compact JSON. `styles list` returns `{"styles":[…]}` with every configured style:

```json
{"styles":[{"key":"technical","label":"技术研发","systemPrompt":"你是技术专家，突出工程细节和风险。","temperature":"0.4","detailLevel":"detailed","resultOriented":"true","isDefault":false}]}
```

`styles show <key>` prints the one matching style row on its own — not the list
wrapper:

```json
{"key":"technical","label":"技术研发","systemPrompt":"你是技术专家，突出工程细节和风险。","temperature":"0.4","detailLevel":"detailed","resultOriented":"true","isDefault":false}
```

The key lookup accepts an exact key or a unique case-insensitive substring of the
key **or label** — callers naturally say "the technical one". Ambiguous substrings
and unknown keys fail with the valid keys listed.

Styles are referenced by **key** (`formal`, `technical`, `concise`, `detailed` by
default), not by numeric ID. A style change on the `/prompts` page edits that
key for future use. A running generation session snapshots the full style
prompt; a saved final records only the style key (deleting a style clears that
reference), and the final text itself never changes.

## Out of scope

These verbs cover `/api/templates/*` and read-only `/api/prompts/styles`. Starting a
generation session and producing a 终版 from a template is a streaming NDJSON
interface driven from the app UI at `/edit/{id}` — do it there, not here. Managing
styles and system prompts belongs to the `/prompts` page.

## Errors

All verbs exit `0` on success and non-zero on failure. Every failure is one
compact JSON line on stderr: `{"error":{"status":…,"code":…,"message":…,"fix":…}}`.
Read `message` for the cause, then run the `fix` hint.

| Message | Cause | What to do |
|---|---|---|
| `unauthorized (HTTP 401)` | PAT missing, invalid, expired, or revoked | Provision credentials with `wrp init` (see SKILL.md) |
| `Cannot reach weekly-reporter` | Server not running, or wrong port | `npm run dev`, or set `WEEKLY_REPORTER_BASE_URL` |
| `no template matches '<ref>'` | Wrong ID or name | `wrp templates list` |
| `ambiguous template reference: '<ref>'` | Name substring hit several | Re-run with one of the printed selection IDs |
| `official template is read-only` | Official templates are code | `wrp templates clone <id> --name "<new name>"`, then edit the copy |
| `no user template with ID <n>` | Bare numeric ID does not exist | `wrp templates list --kind user` |
| `unknown AI style` / `invalid AI style key` | Style does not exist / wrong shape | Use one of the keys from `wrp styles list` |
| `missing template name` / `at most 100` / `at most 200` | Local validation | Fix the input and retry |
| `Template not found [TEMPLATE_NOT_FOUND]` (clone) | Unprefixed `sourceId` reached the API | Pass the ref to `wrp templates clone` and let it resolve |
| `TEMPLATE_RENDER_REMOVED` (410) | Something called `/render` | Templates are not rendered; generate a final in the app |
