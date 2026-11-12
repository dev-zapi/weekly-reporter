---
name: writing-weekly-report
description: >-
  Author or revise weekly report (周报) finals in the weekly-reporter app as a peer of its built-in generation AI — confirm the week with the user, verify the source draft, pick a template and AI style, write the final yourself, show it in full, and save only after explicit user approval. Use this skill whenever the user wants a weekly report written or revised from outside the app's chat UI: "写一份这周的周报", "帮我生成周报", "写领导版/个人版", "用技术研发模板写周报", "revise last week's final", "改一下周报的口气", or any request to produce a 周报终版 rather than just read one. For merely listing/reading reports use the weekly-reporter skill's `wrp reports …`; for single timeline work-log entries use `wrp events …`.
---

You are the writer. The weekly-reporter app has its own chat-driven generation AI, but through this skill you author finals as its **peer**: you consume the same inputs it does (source draft, template, AI style), write the final yourself, and save it through the same API. The user must get the same quality and the same safety guarantees either way.

All data access goes through the **weekly-reporter** skill's wrp client, written shorthand as `wrp …` and run as `node <weekly-reporter>/scripts/wrp.mjs …` (Node 18+, no dependencies). It reads credentials from the env (`WEEKLY_REPORTER_PAT` for the token; `WEEKLY_REPORTER_BASE_URL`, or its alias `WEEKLY_REPORTER_URL`, for the base URL) or from the machine credential at `~/.config/weekly-reporter/auth.json`, defaulting the base URL to `http://localhost:6868`. Without a PAT every `/api/**` call returns 401 — run `wrp init` (the weekly-reporter skill) to set one up.

## Prerequisites

Only the **weekly-reporter** skill's wrp client is needed. It provides the whole command surface this skill orchestrates:

- `wrp reports …` — preview, list, create, show, save-final
- `wrp templates …` — listing and reading 周报模板
- `wrp styles …` — listing and reading AI 风格

If the weekly-reporter skill is not installed, run the client directly from the weekly-reporter repo's `skills/weekly-reporter/` directory. This skill ships no scripts of its own.

## The model that keeps you honest

- The **source draft** (`原稿`) is the *only* factual input. It is a deterministic event inventory, already filtered per audience. Never invent facts, never import facts from the conversation or the other variant, never "remember" work that is not in the draft.
- Each report has two **audience variants**: `leadership` (work + manual events) and `personal` (everything). Their drafts differ; write each variant only from its own draft.
- A draft reading `- No events this week` is an **empty draft**: stop and tell the user (usually missing sync or wrong dates) — never fabricate a week.
- **Nothing is saved until the user has seen the complete text and approved it.** This replaces the app's proposal-review panel; skipping it is the one unrecoverable mistake in this flow.

## Flow A — author a new final

**1. Pin the week.** Agree the exact date range with the user ("this week" → which Monday–Sunday?). Then verify what it holds *before* creating anything:

```bash
wrp reports preview --start 2026-09-14 --end 2026-09-20
```

Empty draft for a variant → say so and stop for that variant; the fix is a collect-source sync or a date correction, not writing. `preview` prints one line of compact JSON: read `variants[].sourceDraft` for each audience variant (the `- No events this week` or legacy `- 本周暂无事件` literal marks an empty draft).

**2. Reuse or create.** Check the week isn't already covered, then create if needed:

```bash
wrp reports list --start 2026-09-14 --end 2026-09-20
wrp reports create --title "2026 Week 38 Work Report" --start 2026-09-14 --end 2026-09-20
```

Nothing stops duplicate reports for one week, so always list first: `wrp reports list` prints one JSON line, and `reports[].id` plus each report's `variants` array tell you whether a report for the week already exists. If one exists with a current final, you are in Flow B, not here.

**3. Choose variant, template, style.** Default: write both variants, each confirmed separately. Pick the template with `wrp templates list` and `wrp templates show <ref>`; each prints one line of compact JSON, and the row's `content` field is the full instruction text that defines the target structure and writing requirements. For style, unless the user names one, use the template's own AI style — `wrp templates show <ref> --part meta` prints the row without the content, so its `aiStyle` field is right there; `formal` is the fallback. Read the chosen style's prompt live — it is the voice you write in:

```bash
wrp styles list            # JSON: {"styles":[…]} with every key and label
wrp styles show technical  # JSON: the style row; read its systemPrompt
```

**4. Read the source draft** for the variant you are writing:

```bash
wrp reports show <id> --variant leadership --part source
```

Note the `sourceRevision` in the selected variant (`variants[].sourceRevision`; `--part source` keeps the meta fields) — you will pass it when saving.

**5. Optionally consult the previous week's final.** If you want continuity, look up the previous week (weekStart − 7) and, if that report has a current final for the same variant, read its 下周计划 section:

```bash
wrp reports list --start 2026-09-07 --end 2026-09-13
wrp reports show <prevId> --variant leadership --part final
```

Treat anything you read there as *reference, not fact*: this week's plan section is your own prose, grounded in this week's draft. Nothing carries forward automatically, and skipping this step is fine — if there is no previous final, there is simply nothing to consult.

**6. Write the final.** Apply the template's structure and requirements, write in the style prompt's voice, and ground every factual claim in the source draft. If the template includes a 下周计划 section, state next week's priorities as a concise plain list; if the template forbids a plan section, omit it entirely.

**7. Review gate.** Show the user the *complete* text (full markdown, both the body and the plan section). For a revision of an earlier draft of yours, summarize what changed instead of re-pasting everything. If you consulted last week's final, list which items you carried over and which you dropped, with one-line reasons. Then wait. "Looks good" / "可以" → save. Any feedback → revise (back to step 6). Never save on silence.

**8. Save.** Write the final to a temp file (never inline multi-line markdown through shell quoting) and save with provenance:

```bash
wrp reports save-final <id> --variant leadership --file /tmp/final-leadership.md \
  --source-revision <n> --template-id <templateId> --ai-style-key <styleKey>
```

`--source-revision` turns a draft-changed-underneath-you into a loud 409 instead of a silent overwrite. `--template-id` / `--ai-style-key` snapshot provenance onto the report, matching what the app's own AI records — pass exactly the template and style you wrote with. Repeat per variant; each is an independent draft, review, and save.

## Flow B — revise an existing final

Read the current final and the current source draft:

```bash
wrp reports show <id> --variant personal --part final
wrp reports show <id> --variant personal --part source
```

If the final's `finalStatus` is `stale`, say so: the draft was regenerated after it was written. Editing stale text forward is usually wrong — offer to re-author from the fresh draft instead (Flow A from step 3).

Otherwise: apply only the requested changes to the existing text (it is the user's adopted wording — don't rewrite what they didn't ask about), show the full revised text, get approval, and save exactly as in Flow A step 8 (same template/style flags, so provenance survives revision).

## Errors worth pre-empting

| Situation | Meaning | What to do |
|---|---|---|
| `status: 401`, `message` starts `unauthorized (HTTP 401) from` | PAT missing, invalid, expired, or revoked | Provision credentials with `wrp init` (run the exact `! node "…/wrp.mjs" init` command carried in the envelope's `fix`) |
| `status: null`, `message` starts `Cannot reach weekly-reporter at` | Server down / wrong port | `npm run dev` or set `WEEKLY_REPORTER_BASE_URL` |
| `status: 409`, `code: SOURCE_REVISION_CONFLICT` on save | Draft regenerated since you read it | Re-read source, rebase your text on the new draft, re-review, re-save |
| Empty `sourceDraft` on preview/create | No events in range | Stop; suggest sync or date fix |
| `status: 400`, `code: VALIDATION_ERROR` on save | Unknown template/style | Re-check ids via `wrp templates list` / `wrp styles list` |

## Out of scope

Collect-source syncing and timeline event logging belong to the weekly-reporter skill (`wrp sources …`, `wrp events …`; the collect-git-source flow covers syncing) — suggest them when a draft is empty or thin. The app-internal generation sessions (`/edit/[id]` chat) are a parallel path — don't drive them from here. Deleting reports is `wrp reports delete --confirm`'s job, and finals you save through this skill are deletable precisely because they carry no proposal audit trail.
