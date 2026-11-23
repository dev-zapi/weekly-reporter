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

<!-- impeccable:design-map -->
Name: weekly-reporter — Numbered Evidence
Colors: primary: navy #14273d; secondary: green #18794e; tertiary: red #a43b3b; neutral: ice #edf3f8; primary: navy-deep #0d1b2c; primary: cobalt #2f66d0; primary: cobalt-dark #214fae (+9 more in the sidecar)
Fonts: var(--font-geist-sans) (display, headline, title, body, document, label, meta)
Spacing: sm 4px, md 8px, lg 12px, xl 16px, capture 22px, 2xl 24px, context 26px, section 30px, 3xl 32px
Radius: xs 3px, sm 4px, md 5px, lg 6px, xl 8px
North Star: "Numbered Evidence"
Rules:
- The Citation Rule. Cobalt identifies an actionable or traceable path; do not use it as general decoration.
- The Monochrome-Proof Rule. Status color always travels with an explicit word, number, icon, or shape so meaning survives without hue.
- The Shared Selection Rule. Selected text uses navy ink on the cobalt highlight tint (`#bcd3fa`) with a cobalt caret in every workbench surface; never leave a report, preview, plan, or proposal module on the browser default selection.
- The One-Family Rule. Geist Sans serves both controls and report content; do not introduce a display serif or separate monospace for citations.
- The Stable-Number Rule. IDs, dates, counts, revisions, and period ranges use tabular numerals wherever alignment matters.
- The Flat Record Rule. Evidence rows, readiness cells, source panes, and report documents use boundaries and tonal contrast, not ambient card shadows.
Elevation:
- Overlay: 0 10px 28px rgb(13 27 44 / 18%)
- Active pane: 0 1px 4px rgb(20 39 61 / 12%)
- Notice: 0 8px 24px rgb(13 27 44 / 20%)
Don't:
- Don't turn evidence rows into floating cards or use cobalt as a decorative accent detached from action, selection, or traceability.
- Don't collapse source draft, candidate final, and human adoption into one visually undifferentiated document state.
- Don't treat a source draft as a final, enable adoption without final content, or imply that live edits rewrite a frozen report basis.
- Don't replace the shipped C hybrid with the A or B prototype compositions; they are historical alternates only, and the `/prototype` variant switcher and its throwaway components are development tooling, not production code.
Do:
- Do keep `@id`, `%id`, and `Rid` adjacent to the records they identify and align numeric operational data.
- (+4 more)
Full: .impeccable/design-full.md (read a section when you need its detail)
