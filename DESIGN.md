---
name: weekly-reporter — Numbered Evidence
description: A compact evidence workbench where stable references, readiness, and human review make reporting traceable.
colors:
  navy: "#14273d"
  navy-deep: "#0d1b2c"
  cobalt: "#2f66d0"
  cobalt-dark: "#214fae"
  ice: "#edf3f8"
  frame-ground: "#e2ebf4"
  paper: "#fafcfe"
  white: "#ffffff"
  ink: "#172537"
  secondary: "#52647a"
  line: "#cbd6e2"
  green: "#18794e"
  green-bg: "#e9f5ee"
  amber: "#8a4d05"
  amber-bg: "#fff3dd"
  red: "#a43b3b"
typography:
  display:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "clamp(24px, 2.2vw, 34px)"
    fontWeight: 400
    lineHeight: 1.16
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "-0.008em"
  title:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.55
    letterSpacing: "0em"
  body:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  document:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: "0em"
  label:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "\"tnum\""
  meta:
    fontFamily: "var(--font-geist-sans), 'Noto Sans CJK SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
rounded:
  xs: "3px"
  sm: "4px"
  md: "5px"
  lg: "6px"
  xl: "8px"
spacing:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  capture: "22px"
  2xl: "24px"
  context: "26px"
  section: "30px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.white}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 13px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-dark}"
    textColor: "{colors.white}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.navy}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 13px"
    height: "38px"
  input-text:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 13px"
    height: "42px"
  panel:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "16px"
  status-ready:
    backgroundColor: "{colors.green-bg}"
    textColor: "{colors.green}"
    typography: "{typography.meta}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
    height: "24px"
  status-pending:
    backgroundColor: "{colors.amber-bg}"
    textColor: "{colors.amber}"
    typography: "{typography.meta}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
    height: "24px"
---

# Design System: weekly-reporter — Numbered Evidence

## Overview

**Creative North Star: "Numbered Evidence"**

Numbered Evidence is a compact personal workbench, not a decorative report editor. Navy frames the workspace, ice blue separates work areas from near-white records, and cobalt makes references and selected paths visible. Dense rows, stable IDs, fixed readiness cells, and one aligned evidence trace make the path from captured work to reviewed reporting inspectable.

This document records the shared visual world of the shipped Numbered Evidence production UI: the shared shell, the primary Timeline, Plans, Reports, and report workspace surfaces, and the migrated secondary surfaces — Library and configuration (Templates and Prompts), Collection sources, Security and sign-in, and the report creation entry. The primary surfaces implement the user-directed C hybrid composition: B’s 248px period sidebar combined with C’s split body, persistent context, and report-first review. The approved hybrid is now the production system; A and B survive only as historical prototype alternates, and the development-only `/prototype` switcher is not part of production.

**Key Characteristics:**
- Stable `@id`, `%id`, and `Rid` references remain visible beside content.
- Explicit labels and values accompany green, amber, neutral, and error states.
- Compact controls, tabular numerals, thin dividers, and small radii prioritize scanning.
- Navy is structural; cobalt marks action, selection, citations, and trace alignment.
- Source draft, candidate final, and human adoption remain visibly distinct.

## Surface Coverage

The primary surfaces remain Timeline, Plans, Reports, and the report workspace. Four secondary surface families have completed the Numbered Evidence migration and now express the same world rather than merely inheriting the shell. All of them are fixed-light (`color-scheme: light`), inherit the Geist stack, and honor the shared selection, focus, status, and reduced-motion rules.

### Library and Configuration — Templates and Prompts
Routes: `/templates`, `/templates/new`, `/templates/[id]`, `/prompts`.
- **Ground:** Template management and Prompt management use the near-white paper canvas with 30px 28px padding and a title-first heading; the description stays at body size and 70ch.
- **Records:** Templates and prompts are dense white full-width records on paper, led by a cobalt-ink `recordId` reference (the official template id, `T<id>` for personal templates, `S<id>` for AI styles, and the prompt key), a title and description, and a trailing scope/state badge plus text or icon actions. Official and personal templates stay visibly distinct through a worded badge, never hue alone.
- **Tabs:** Official/Personal template tabs and the system-prompt tabs use the shared tab language with tabular counts; inactive tabs are white/slate and the active tab is navy/white.
- **Editing:** Template form, rich-text content editor, prompt manager, and AI style selector are white panels on the paper ground with the standard 42px inputs, gently squared controls, cobalt caret, and 3px `#74a2fa` focus outline. Prompt previews scroll inside their field; the system prompt tabs cover the live `check` and `generate` keys only, and a prompt shows its variable block only when variables exist.
- **Dialogs:** View, clone, and save-as dialogs reuse the shared white dialog surface with a navy title, hairline boundary, and fixed-light form controls.

### Collection Sources
Routes: `/collect`, `/collect/new`, `/collect/[id]`.
- **Ground:** The collection workspace uses the shared frame ground (`#e2ebf4`) as its outer surface and a paper primary column with 30px 28px padding, a title-first heading, a 70ch description, and page actions aligned to the trailing edge.
- **Records:** Sources render as dense white table rows on desktop: a cobalt-ink numbered source reference, source name and identity, repository/path, author count, branch cursor, a worded status badge, and trailing actions. The Actions column is sticky on desktop; below 780px the table becomes labeled card records in one column, with the Actions cell as a non-sticky card footer.
- **Scope:** Project-scope badges use short labels ("Work", "Personal") with a leading icon and a reserved minimum width so words never clip against the sticky Actions edge.
- **Forms and dialogs:** The create/edit source form uses white form panels on the frame ground with a field grid, path suggestions, branch tags, scope radios, and inline validation. Scan-repository and author-picker dialogs follow the shared dialog pattern, including staged Escape handling.
- **Feedback:** Sync results appear as inline result rows with explicit counts and worded success/failure state; loading uses the cobalt pulse line and errors use the red alert field with a retry action.

### Security and Sign-in
Routes: `/security`, `/login`.
- **Security workspace:** Frame ground behind white record panels, title-first heading, and two tabs — Personal access tokens and Audit log — with tabular counts.
- **PAT records:** Numbered white records led by a cobalt `#id`, with token name, a worded status badge (Active/Expired/Revoked), and prefix, created, last-used, and expiry metadata in tabular numerals. Copy and Revoke are text actions; revocation uses an AlertDialog with a dimmed backdrop and a navy-titled white popup whose animation collapses under reduced motion.
- **Audit records:** Dense white rows carrying agent, working directory, User-Agent, and timestamp, with pagination and filter controls that keep their query parameters.
- **Login:** A standalone fixed-light gate outside the application shell: frame ground, one centered white panel capped at 440px with a 2px navy top rule, title-first body in Geist, cobalt input caret, visible focus, and an explicit inline error alert. No shell navigation is rendered on this route.

### Report Creation Entry
Routes: `/new`; `/edit/[id]` remains the thin editable wrapper around the already-migrated report workspace.
- **Composition:** A paper primary column with 30px 28px padding and a persistent 350px frame-ground settings rail, title-first, with no body-level top bar. The rail carries the week control, required title field, creation note, and Create/Cancel actions. The rail narrows to 300px at 1100px and stacks beneath the primary content at 780px.
- **Audience:** Two equal Leadership/Personal tabs with explicit evidence-scope labels; active is navy/white. The read-only source-draft preview keeps muted theme ink on its field and wraps long tokens.
- **States:** Explicit loading (cobalt pulse line), dashed empty preview with recovery guidance, worded ready/error status, and a red inline title-validation field linked through `aria-invalid` and `aria-describedby`.
- **Responsive:** Settings step to a two-column grid at 960px, stack at 780px, and the page holds at the 320px minimum without horizontal overflow.

## Colors

The palette is cool and operational: dark navy for shell and review gates, cobalt for evidence paths, quiet blue-gray neutrals for records, and paired foreground/background status colors.

### Primary
- **Workbench Navy** (`navy`): Side shell, capture band, active audience tab, and review gate; it establishes product context without decorating the document.
- **Deep Navy** (`navy-deep`): Deepest rail and contrast anchor.
- **Citation Cobalt** (`cobalt`): Primary actions, active navigation, selected-row rules, trace connectors, and the shell's bottom keyline.
- **Cobalt Ink** (`cobalt-dark`): Evidence IDs, text actions, links, and primary hover.

### Secondary
- **Ready Green** (`green`) on **Ready Wash** (`green-bg`): Current finals, complete readiness, and successful notices; always paired with text or a check.
- **Blocker Amber** (`amber`) on **Blocker Wash** (`amber-bg`): Pending readiness and stale finals; not a generic warning ornament.

### Tertiary
- **Error Red** (`red`): Loading and data errors, with an explicit error message.

### Neutral
- **Ice Work Area** (`ice`): Main canvas and recessed working context.
- **Shared Frame Ground** (`frame-ground`): The selected C sidebar-to-body gutter and right context rail, making both read as one continuous frame.
- **Near-White Paper** (`paper`): Content emphasis in split work areas.
- **Record White** (`white`): Inputs, rows, cards, and report documents.
- **Evidence Ink** (`ink`): Primary text.
- **Secondary Slate** (`secondary`): Metadata, descriptions, and inactive labels.
- **Hairline Blue-Gray** (`line`): Dividers, table grids, and panel boundaries.

### Named Rules
**The Citation Rule.** Cobalt identifies an actionable or traceable path; do not use it as general decoration.
**The Monochrome-Proof Rule.** Status color always travels with an explicit word, number, icon, or shape so meaning survives without hue.
**The Shared Selection Rule.** Selected text uses navy ink on the cobalt highlight tint (`#bcd3fa`) with a cobalt caret in every workbench surface; never leave a report, preview, plan, or proposal module on the browser default selection.

## Typography

**Display Font:** Next self-hosted Geist Sans, with Noto Sans CJK SC, Microsoft YaHei, system-ui, and sans-serif fallbacks.
**Body Font:** The same Geist Sans stack.
**Label/Mono Font:** No separate mono face; stable references use Geist Sans with bold weight and tabular numerals.

**Character:** One compact grotesk family carries interface and Chinese report prose. Weight, size, numeric alignment, and labels create hierarchy rather than editorial font pairing.

### Hierarchy
- **Display** (400, 24–34px responsive clamp, 1.16): Page-level workspace names; balanced wrapping and tight tracking.
- **Headline** (400, 15px, 1.3): Panel and section titles.
- **Title** (550, 14px, 1.55): Evidence and record titles; event text clamps to two lines and wraps anywhere when needed.
- **Body** (400, 14px, 1.5): Controls, explanations, and general interface copy; introductory copy may extend to 70ch.
- **Document** (400, 13px, 1.75): Markdown source and final prose, constrained to 72ch with 17px section headings and 14px subheadings.
- **Label** (700, 12px, tabular numerals): `@id`, `%id`, and `Rid` references and trace nodes.
- **Meta** (400, 11px, 1.5): Dates, source, scope, and supporting state text; the smallest supporting labels reach 9–10px only inside dense cells and traces.

### Named Rules
**The One-Family Rule.** Geist Sans serves both controls and report content; do not introduce a display serif or separate monospace for citations.
**The Stable-Number Rule.** IDs, dates, counts, revisions, and period ranges use tabular numerals wherever alignment matters.

## Layout

The system is compact and record-led. Reused spacing centers on 4, 8, 12, 16, 24, and 32px; controls are typically 38–42px high, navigation rows 40px, and dense panels 16–18px internally. Lists use full-width rows with stable leading ID columns and thin lower dividers rather than a card per record. Report prose remains narrower than its workspace. Read-only prose previews keep theme ink on their muted panel and wrap long tokens (`overflow-wrap: anywhere`); no surface may pan horizontally at 320px.

The selected C hybrid uses a sticky 248px deep-navy period rail with 20px 16px padding, 24px section gaps, a week card, navigation, Library, and a single-user/read-only footer. A 24px desktop column gutter separates the rail from the body and shares the right context rail’s frame ground (`#e2ebf4`). There is no body-level top bar: the primary paper area begins directly with the page title and description. A fluid primary column and 350px persistent context column share a 100dvh minimum-height split. The primary area uses 30px 28px padding; compact capture receives 22px padding, an 18px heading gap, 12px control gaps, and 30px separation from the evidence list. The ice context area uses 26px 20px padding and 20px panel gaps; its trace expands to 22px padding with 26px vertical chain margins and 6px connector spacing.

The artifact supports a 320px minimum width. At 1100px, multi-pane work areas collapse and the C context column narrows to 300px; at 780px, primary grids become one column, capture and composer controls stack full-width, side rails become horizontal scrolling navigation, readiness uses two columns, and secondary row actions or plan evidence columns are hidden while IDs and status remain. In the selected hybrid, the week card and rail footer hide, the body receives 16px top separation from the rail on the same shared frame ground, the title remains the first body content, primary and workspace padding become 22px 16px, capture becomes 18px padding with 24px bottom separation, and the context area moves below the primary content with a top divider and 20px 16px padding. The report workspace collapses source, preview, and review into a readable sequence.

Keyboard focus uses a 3px light-blue outline (`#74a2fa`) with 3px offset. Native controls and semantic buttons, tab lists, labels, status regions, and alerts support operation without pointer-only interactions. Reduced-motion preference collapses animation and transition durations to 0.01ms and disables smooth scrolling.

## Elevation & Depth

The workbench is flat by default. Depth comes from navy/ice/white tonal layers, 1px boundaries, 2–3px top or selection rules, and inset selected-row indicators. Shadows are reserved for transient overlays, the small active pane-tab lift, and notices; records and documents do not float.

### Shadow Vocabulary
- **Overlay** (`0 10px 28px rgb(13 27 44 / 18%)`): Library menu only.
- **Active pane** (`0 1px 4px rgb(20 39 61 / 12%)`): Selected report pane tab.
- **Notice** (`0 8px 24px rgb(13 27 44 / 20%)`): Fixed confirmation message.

### Named Rules
**The Flat Record Rule.** Evidence rows, readiness cells, source panes, and report documents use boundaries and tonal contrast, not ambient card shadows.

## Shapes

Corners are gently squared: 3px for badges and compact rows, 4px for controls and panels, 5px for major capture or notice containers, and 6px for menus. Pills are not part of the general control language; circles appear only for small status dots, step indicators, and board counts. Dashed 1px borders identify empty or no-final states. Selection adds a cobalt fill tint plus a 2px rule, never a change in silhouette.

## Components

### Buttons
- **Shape:** Gently squared (4px), inline-flex with an 8px icon gap and no wrapping.
- **Primary:** Cobalt fill and white text, 600 weight, minimum 38px height, 8px 13px padding; hover deepens to cobalt ink.
- **Secondary:** White fill, navy text, blue-gray 1px border, matching dimensions; hover uses an ice-blue tint and cobalt border.
- **Text:** Cobalt-ink label with 4px vertical padding and underline on hover.
- **Disabled:** Solid blue-gray fill and border with readable dark-slate text, full opacity, and not-allowed cursor; never communicate disabled state through opacity alone.

### Inputs / Fields
- **Style:** White background, 1px blue-gray border, 4px radius, 42px minimum height, and 10–13px internal spacing. In the selected C capture area, the surrounding compact panel uses 22px padding on desktop and 18px on mobile.
- **Focus:** Shared 3px external focus outline; text caret is cobalt and placeholder text remains opaque secondary slate.
- **Selects:** Compact 35px minimum height and 3px radius in dense plan rows, with an accessible item-specific label.

### Navigation
- **Style:** Navy shell with quiet blue-gray labels; active destination uses cobalt fill, white text, and a light border, while hover uses a lighter navy fill.
- **Mobile:** Top and side navigation become horizontal scrolling rows; labels and active state remain visible.

### Evidence Rows
- **Style:** White full-width button rows, 62px leading ID column on desktop, 13px gaps, 15px 13px padding, and a 1px bottom divider.
- **Reference:** Cobalt-ink `@id` remains first; title and metadata follow, with inspect/tracing language at the trailing edge on wide screens.
- **State:** Hover is pale blue; selected is a stronger blue tint with a full-width 2px cobalt lower rule and `aria-pressed` state.

### Readiness Cells
- **Style:** A fixed four-part sequence—Work evidence, Plan follow-through, Source draft, Final review—with label, value, and context note in every cell.
- **Grid:** Two columns in compact rails, four in wide readiness bands, returning to two at mobile widths.
- **State:** Ready uses green text/wash; pending uses amber text/wash; idle remains neutral. Values such as loaded count, done ratio, revision, and Current/Stale/Needed carry the meaning.

### Evidence Trace
- **Style:** One horizontal chain from `@id / Live event` to `Next snapshot / Not yet frozen` to `Review / Human decision`, joined by 2px cobalt lines.
- **Behavior:** Appears as one persistent inspector beside the selected record in the C hybrid; its desktop panel uses 22px padding and the chain has 26px vertical margins with 6px connector spacing. Its copy states that snapshot creation fixes inclusion and later edits do not rewrite the basis.

### Audience Tabs and Report Review
- **Audience:** Two equal tabs with explicit evidence scope: Leadership = Work + manual evidence; Personal = All evidence. Active uses navy and white, inactive white and slate.
- **Panes:** Final preview, Source draft, and Compare remain separate; source is labeled read-only and deterministic facts retain authority.
- **Statuses:** Current is green, Stale amber, and None neutral. No-final uses a dashed neutral panel stating that source is not a candidate final.
- **Missing variant:** A requested audience with no stored variant shows a dashed "No <audience> version" state that says the other audience is kept separate and is not shown; the library withholds "Open full review" until that variant exists.
- **Review gate:** Navy panel with an ordered checklist for frozen snapshot, source revision, final availability, and human adoption. Adoption stays disabled when no final exists.

### Feedback
- **Empty:** Left-aligned dashed container with explicit title and recovery guidance.
- **Loading:** A cobalt pulse line plus loading text.
- **Error:** Red text and message on a pale red field with `role="alert"`.
- **Notice:** Green fixed status message with a labeled dismiss action.

## Do's and Don'ts

### Do:
- **Do** keep `@id`, `%id`, and `Rid` adjacent to the records they identify and align numeric operational data.
- **Do** preserve the four readiness cells and the single Live event → Next snapshot → Review trace when reorganizing a surface.
- **Do** keep Leadership and Personal scopes, snapshots, source drafts, finals, and review states explicitly separate.
- **Do** pair every status color with visible language or a check/shape, and retain the shared focus and reduced-motion behavior.
- **Do** use compact white records on ice work areas, with navy reserved for shell, capture, and decision gates.

### Don't:
- **Don't** turn evidence rows into floating cards or use cobalt as a decorative accent detached from action, selection, or traceability.
- **Don't** collapse source draft, candidate final, and human adoption into one visually undifferentiated document state.
- **Don't** treat a source draft as a final, enable adoption without final content, or imply that live edits rewrite a frozen report basis.
- **Don't** replace the shipped C hybrid with the A or B prototype compositions; they are historical alternates only, and the `/prototype` variant switcher and its throwaway components are development tooling, not production code.
