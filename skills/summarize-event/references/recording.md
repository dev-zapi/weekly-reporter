# Record a work segment

Use **weekly-reporter** and only its relevant module references for wrp commands,
output, and auth. Read **collect-git-source** only in the Git branch below.
Reuse this run's lookup results; independent reads may run together.

Before lookups, establish a concrete action/decision and its result or current
state from conversation evidence. If missing, ask one factual question first;
direct-send waives preview approval, not missing facts.

## Collection and event links

Run `git rev-parse --show-toplevel` where the work happened. For a Git repo,
follow collect-git-source before drafting; outside Git, skip collection.
Registration/enabling needs a user decision: offer a skip option, and take it
automatically in direct-send mode.

Use commits as change evidence; add context/outcomes rather than repeating the
log. When continuing/fixing/verifying earlier work or citing synced commits,
query `wrp events list` for the relevant dates after collection. Use only
`events[].id` from returned data as `@id` links.

## Event wording

Use concrete wording; remove empty preambles, repetition, and generic praise.
Preserve facts, completion status, conditions, uncertainty, and the user's
language. Before preview or direct-send, polish with **humanizer-zh** for Chinese
when available, otherwise **humanizer** if available. If neither is available,
continue with these built-in rules. Polish prose only: keep project names,
`#tags`, `@id`, `%id`, and the single-line plain-text format intact.

## Plan links and tags

Query the segment's week and month (its own dates for earlier work):

```text
wrp plans list --scope week --date <YYYY-MM-DD>
wrp plans list --scope month --month <YYYY-MM>
```

Use only returned `items[].id` for `%id` links:

- Match open `planned`/`in_progress` items by project and topic. Prefer the
  matching week item to its month parent; use a deferred item's live successor.
- A user-named item overrides automatic matching; resolve it from query output.
- With plausible competing candidates, present their ids/texts beside the
  preview for selection; direct-send omits ambiguous links.
- Empty/irrelevant plans or failed plan queries need no question and do not
  block the summary. Linking never changes a plan's status.

Unless tags were supplied or declined, run `wrp tags list` and recommend
relevant existing `tags[].name` before new tags. Append selected tags at line end.

## Approve and submit

**Normal:** show the draft, recommended tags, and any plan ambiguity together.
Offer A no tags / B recommended tags (default) / C custom tags. Treat the tag
choice separately from preview approval; create only after explicit approval.
If a reply combines a tag choice and approval, apply both. Defaults and
unanswered questions never authorize creation.

**Direct-send:** “直接发送 / 不用确认” or **summarize-event-quick** authorizes
this run's create without preview approval. Use recommended tags unless the
user chose otherwise; skip collection decisions and ambiguous plan links.
It grants no permission to register/enable sources or change plans.

Before `wrp events create "<content>"`, check: single-line plain text;
project and evidenced outcome present; whitespace/line boundaries on both sides
of every `#tag`, `@id`, `%id`; incidental literal `#words` quoted.
For earlier work pass `--time` as ISO 8601 with `Z` or `±HH:MM`, using the
work date's system-zone offset; omit it for now. If only an earlier date is
known, ask for a time instead of inventing one.

## Recovery

On `401`, hand off `error.fix` per weekly-reporter; wait for credential
provisioning before retrying. Other optional lookup failures may be omitted.
If create's outcome is uncertain, check recent events for the submitted line
before retrying. Confirm its id before claiming success; avoid duplicate writes.
