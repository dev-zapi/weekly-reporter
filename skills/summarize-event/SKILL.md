---
name: summarize-event
description: >-
  Summarize/log recent work to the weekly-reporter timeline. Offer after each
  completed outcome or wrap-up/project switch while work remains unlogged. Honor
  reminder choices; offers never authorize writes.
---

# Summarize event

Distill the requested work segment, or work since the last successful summary,
into one single-line plain-text event. Name the project/repo and what shipped,
was fixed, or was decided, with its result. Group related minor changes; omit
routine steps and dead ends. Use conversation evidence, not invented outcomes.

For a whole day's reconstruction use **yesterday-recall**; for reading a day's
timeline use **daily-review**; for a weekly report use **writing-weekly-report**.

## Automatic offers

Use completed, nameable tasks as offer boundaries. A task qualifies even when it
is small; tests, commits, and intermediate edits are evidence, not separate
outcomes. Partial work and routine Q&A do not count. Track pending outcomes, the
last offer/record, and the user's reminder choice in conversation context.

Apply the user's reminder choice before checking any automatic trigger:

| User's choice | Next action |
| --- | --- |
| Log now | Enter the recording flow; preview approval still applies. |
| Not yet | Wait for one **new** completed outcome after this offer, or wrap-up/project switch. |
| Skip this session | Mute every automatic offer, including wrap-up, until re-enabled. Explicit requests still work. |
| Remind at session end | Defer every automatic offer until wrap-up. |

Offer only while completed work remains unrecorded. In normal mode, offer at the
first clean boundary after each completed outcome not covered by a later offer
or successful record. Wrap-up or an unrelated-project switch also qualifies
when work remains unrecorded. Wrap-up requires an observable signal such as
“今天先这样”; an ordinary final answer is not itself session end.

Offer once at a clean work boundary with the four choices above, phrased in the
user's language. An unanswered offer is not consent: continue the user's task
and avoid repeating the offer for the same work. At wrap-up, selecting the
session-end reminder again ends this offer without recording or carrying it to
another session. An explicit recording request bypasses the offer.

**Offering ends here.** Until the user accepts or requests a record, use only
conversation context: no collection, API queries, or recording-reference reads.

## Record a segment

For an explicit request or an accepted offer, read
[the recording flow](references/recording.md). It covers collection, tags, event
and plan links, preview, and submission. “直接发送 / 不用确认” or an explicit
**summarize-event-quick** invocation selects direct-send for this run only.

Confirm the created event id (`✓ event created: #<id>`, or a verified record
after an uncertain create); report it and clear only the outcomes it covers.
On cancellation or failure, retain pending work without claiming it was logged.
