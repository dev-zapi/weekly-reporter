---
name: summarize-event-quick
description: No-confirmation fast path over summarize-event — compose the segment summary and submit it in one shot.
disable-model-invocation: true
---

The no-confirmation fast path over summarize-event, for when the user has already decided they want the segment summarized and logged without stops. Invoke the summarize-event skill and treat this invocation as the user having said "直接发送" when triggering it, so its direct-send rules govern the entire run. Every rule — what to distill, tagging, collection, references, submission — lives in that skill; this one only selects the mode. The run is done when the timeline-events create inside that flow confirms the new event id.
