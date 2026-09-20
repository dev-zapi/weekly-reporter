---
name: write-weekly-report
description: >-
  Author or revise weekly report (周报) finals in the weekly-reporter app as a peer of its built-in generation AI — confirm the week with the user, verify the source draft, pick a template and AI style, write the final yourself, show it in full, and save only after explicit user approval. Use this skill whenever the user wants a weekly report written or revised from outside the app's chat UI: "写一份这周的周报", "帮我生成周报", "写领导版/个人版", "用技术研发模板写周报", "revise last week's final", "改一下周报的口气", or any request to produce a 周报终版 rather than just read one. For merely listing/reading reports use the weekly-reports skill; for single timeline work-log entries use timeline-events.
---

You are the writer. The weekly-reporter app has its own chat-driven generation AI, but through this skill you author finals as its **peer**: you consume the same inputs it does (source draft, template, AI style), write the final yourself, and save it through the same API. The user must get the same quality and the same safety guarantees either way.

All scripts talk to a running weekly-reporter server (built-in `fetch`, Node 18+, no deps). They read `WEEKLY_REPORTER_URL` from env, defaulting to `http://localhost:6868`.

## Prerequisites

Two sibling skills provide the data-access scripts this skill orchestrates:

- **weekly-reports** — `preview.mjs`, `list.mjs`, `create.mjs`, `show.mjs`, `save-final.mjs` (repo: `skills/weekly-reports/scripts/`)
- **report-templates** — listing and reading 周报模板 (repo: `skills/report-templates/scripts/`)

If a sibling script is not installed as a skill, run it directly from the weekly-reporter repo's `skills/` directory. This skill's own script (`{baseDir}/scripts/show-style.mjs`) is self-contained.

## The model that keeps you honest

- The **source draft** (`原稿`) is the *only* factual input. It is a deterministic event inventory, already filtered per audience. Never invent facts, never import facts from the conversation or the other variant, never "remember" work that is not in the draft.
- Each report has two **audience variants**: `leadership` (work + manual events) and `personal` (everything). Their drafts differ; write each variant only from its own draft.
- A draft reading `- No events this week` is an **empty draft**: stop and tell the user (usually missing sync or wrong dates) — never fabricate a week.
- **Nothing is saved until the user has seen the complete text and approved it.** This replaces the app's proposal-review panel; skipping it is the one unrecoverable mistake in this flow.

## Flow A — author a new final

**1. Pin the week.** Agree the exact date range with the user ("this week" → which Monday–Sunday?). Then verify what it holds *before* creating anything:

```bash
node <weekly-reports>/preview.mjs --start 2026-09-14 --end 2026-09-20
```

Empty draft for a variant → say so and stop for that variant; the fix is a collect-source sync or a date correction, not writing.

**2. Reuse or create.** Check the week isn't already covered, then create if needed:

```bash
node <weekly-reports>/list.mjs --start 2026-09-14 --end 2026-09-20
node <weekly-reports>/create.mjs --title "2026 Week 38 Work Report" --start 2026-09-14 --end 2026-09-20
```

Nothing stops duplicate reports for one week, so always list first. If a report already exists with a current final, you are in Flow B, not here.

**3. Choose variant, template, style.** Default: write both variants, each confirmed separately. Pick the template with the report-templates skill (its `show` prints the full instruction text — that text defines the target structure and writing requirements). For style, unless the user names one, use the template's own AI style, shown by report-templates; `formal` is the fallback. Read the chosen style's prompt live — it is the voice you write in:

```bash
node {baseDir}/scripts/show-style.mjs            # one line per style
node {baseDir}/scripts/show-style.mjs technical  # full writing prompt
```

**4. Read the source draft** for the variant you are writing:

```bash
node <weekly-reports>/show.mjs <id> --variant leadership --part source
```

Note the `sourceRevision` in the metadata — you will pass it when saving.

**5. Check the previous week's plan (carry-forward reference).** Look up the previous week (weekStart − 7) and, if that report has a current final for the same variant, read its 下周计划 section:

```bash
node <weekly-reports>/list.mjs --start 2026-09-07 --end 2026-09-13
node <weekly-reports>/show.mjs <prevId> --variant leadership --part final
```

Treat those items as *reference, not fact*: carry items still relevant into this week's plan, drop finished/obsolete ones, and be ready to justify each decision at review time. If there is no previous final, there is simply nothing to carry.

**6. Write the final.** Apply the template's structure and requirements, write in the style prompt's voice, and ground every factual claim in the source draft. Rules for the 下周计划 section: at most 5 items; if the template forbids a plan section, omit it entirely.

**7. Review gate.** Show the user the *complete* text (full markdown, both the body and the plan). For a revision of an earlier draft of yours, summarize what changed instead of re-pasting everything. When carry-forward was involved, list what you carried and what you dropped, with one-line reasons. Then wait. "Looks good" / "可以" → save. Any feedback → revise (back to step 6). Never save on silence.

**8. Save.** Write the final to a temp file (never inline multi-line markdown through shell quoting) and save with provenance:

```bash
node <weekly-reports>/save-final.mjs <id> --variant leadership --file /tmp/final-leadership.md \
  --source-revision <n> --template-id <templateId> --ai-style-key <styleKey>
```

`--source-revision` turns a draft-changed-underneath-you into a loud 409 instead of a silent overwrite. `--template-id` / `--ai-style-key` snapshot provenance onto the report, matching what the app's own AI records — pass exactly the template and style you wrote with. Repeat per variant; each is an independent draft, review, and save.

## Flow B — revise an existing final

Read the current final and the current source draft:

```bash
node <weekly-reports>/show.mjs <id> --variant personal --part final
node <weekly-reports>/show.mjs <id> --variant personal --part source
```

If the final's status is `stale`, say so: the draft was regenerated after it was written. Editing stale text forward is usually wrong — offer to re-author from the fresh draft instead (Flow A from step 3).

Otherwise: apply only the requested changes to the existing text (it is the user's adopted wording — don't rewrite what they didn't ask about), show the full revised text, get approval, and save exactly as in Flow A step 8 (same template/style flags, so provenance survives revision).

## Errors worth pre-empting

| Situation | Meaning | What to do |
|---|---|---|
| `Cannot reach weekly-reporter` | Server down / wrong port | `npm run dev` or set `WEEKLY_REPORTER_URL` |
| `SOURCE_REVISION_CONFLICT` (409) on save | Draft regenerated since you read it | Re-read source, rebase your text on the new draft, re-review, re-save |
| Empty draft on preview/create | No events in range | Stop; suggest sync or date fix |
| Save with unknown template/style | 400 `VALIDATION_ERROR` | Re-check ids via report-templates / `show-style.mjs` |

## Out of scope

Collect-source syncing and timeline event logging belong to their own skills (suggest them when a draft is empty or thin). The app-internal generation sessions (`/edit/[id]` chat) are a parallel path — don't drive them from here. Deleting reports is `weekly-reports`' job, and finals you save through this skill are deletable precisely because they carry no proposal audit trail.
