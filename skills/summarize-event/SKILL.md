---
name: summarize-event
description: Summarize previous work items and log them into the weekly-reporter timeline.
---

Summarize the work done since the last summary or session start into one single-line plain-text event. First query recent timeline events (via the timeline-events skill) to see what is already logged and to match their language and style. Name the project or repo the work happened in — the timeline spans many projects — and include concrete evidence such as commit hashes, ADR or test numbers. Only append tags when the user explicitly asks for them — never add tags on your own initiative. When added, place them inline at the end of the line, separated by whitespace. Note the app's parsing rules: it recognizes `#word` tokens only at the start of the line or after whitespace, and only before whitespace or end-of-line, so a tag glued to preceding punctuation (e.g. 。#tag) is silently lost, and conversely any incidental `#word` in the text becomes a tag unless quoted ("#tag"). Preview the line for user confirmation, submit only after approval, then invoke the "timeline-events" skill to create the event.
