# summarize-event hooks

Harness-enforced reminder state for the summarize-event skill. Turns the two
weakest contract rules — "offer once about three accomplishments pile up" and
"always offer before the session ends with un-logged work" — from model
self-discipline into hook-enforced checks. See `docs/adr/0034-stop-hook-reminder-safety-net.md`
for the decision record.

## Files

| File | Role |
|---|---|
| `stop-reminder.sh` | Stop hook: local check for un-logged work, emits the reminder, self-stamps offer time |
| `remind-state.sh` | State landing: `remind-state <sid> now\|notyet\|skip\|end` (plus `show`) |
| `session-end-cleanup.sh` | SessionEnd hook: removes this session's state file |
| `test-stop-reminder.sh` | Fixtures-driven tests: `bash test-stop-reminder.sh` |

State lives at `~/.cache/wrp-remind/<session-id>.json`, one file per session.

## Install (manual, copy-based)

Deployment follows the copy model (ADR 0031): this repo directory is the
source; `~/.agents/skills/summarize-event/` is the deployed copy that
`~/.claude/skills/summarize-event` points to. The settings wiring references
the **deployed** path, so repo moves never silently break the hook.

```bash
# 1. Copy the skill from this repo to the deployed location
rsync -a --delete /home/god/github/weekly-reporter/skills/summarize-event/ \
    /home/god/.agents/skills/summarize-event/

# 2. Add the entries below to ~/.claude/settings.json (merge into the
#    existing "Stop" array; "SessionEnd" is likely new)
```

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "[ ! -f '/home/god/.claude/skills/summarize-event/hooks/stop-reminder.sh' ] || '/home/god/.claude/skills/summarize-event/hooks/stop-reminder.sh'",
        "timeout": 10,
        "statusMessage": "Checking un-logged work"
      }
    ]
  }
],
"SessionEnd": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "[ ! -f '/home/god/.claude/skills/summarize-event/hooks/session-end-cleanup.sh' ] || '/home/god/.claude/skills/summarize-event/hooks/session-end-cleanup.sh'",
        "timeout": 5
      }
    ]
  }
]
```

The `[ ! -f … ] || …` guard makes a missing script a silent no-op (same idiom
as the impeccable wiring); uninstall is deleting the two entries. Rewire after
every change: edit here → test → re-run the rsync.

## How the Stop hook decides

Guard chain, every step fail-open (any error or missing tool ⇒ silent pass):

1. `stop_hook_active: true` → pass (continuation round; harness also caps consecutive continuations at 8).
2. Non-empty `background_tasks` or `session_crons` → pass (session isn't really ending).
3. `skip: true` in state → pass (user chose "skip for this session").
4. `unanswered >= MAX_UNANSWERED` → pass (too many emitted offers went
   unanswered; the session is treated as skipped — **no auto-answer**, un-logged
   work simply stays un-logged).
5. Within cooldown of `last_offer_ts` → pass.

Every emitted reminder increments `unanswered`; any `remind-state` answer
clears it, so an engaged user is never capped and a present-but-ignoring or
unattended session goes quiet after at most 3 offers.

Trigger (either fires the reminder):

- **New commits**: `git -C <input cwd> log --since=<last timeline event>` is
  non-empty. The last event comes from
  `node ~/.claude/skills/weekly-reporter/scripts/wrp.mjs events list --limit 1`
  (`events[0].eventTime`, newest first; `{"events":[]}` counts as epoch 0),
  cached for 10 minutes per session; a failed query passes silently.
- **Time backstop**: ≥ `SESSION_BACKSTOP_MIN` (120) minutes since
  `max(session first seen, last timeline event, last reset)` — catches
  un-logged work that leaves no commit trail (tests, debugging, reviews).

On trigger the hook emits the approved English `additionalContext` reminder
(commit count, repo, since-timestamp, session id) and **self-stamps
`last_offer_ts` + base cooldown**, so an unanswered offer cannot re-fire every
round. It also opportunistically deletes state files older than 7 days.

## remind-state

| Answer | Command | Effect |
|---|---|---|
| summarize now | `remind-state <sid> now` | after the event is created: reset everything (direct-send and summarize-event-quick runs count once their create confirms) |
| not yet | `remind-state <sid> notyet` | start/escalate the cooldown ladder: 30 → 60 → 120 min (capped) |
| skip for this session | `remind-state <sid> skip` | silence all further offers this session, safety net included |
| remind at session end | `remind-state <sid> end` | record offer time, keep the net armed at the top cooldown (120 min) |

`remind-state <sid> show` prints the state. When no reminder text supplied a
session id (model-initiated offer), derive it as the newest `*.jsonl` filename
under `~/.claude/projects/<escaped-cwd>/`.

## Tuning constants (in `stop-reminder.sh`; `NOTYET_LADDER_MIN` and `END_COOLDOWN_MIN` are mirrored in `remind-state.sh` — override via env to keep both in sync)

| Constant | Default | Meaning |
|---|---|---|
| `SESSION_BACKSTOP_MIN` | 120 | time-backstop threshold in minutes |
| `BASE_COOLDOWN_MIN` | 20 | self-stamped cooldown when the hook emits a reminder |
| `NOTYET_LADDER_MIN` | 30 60 120 | escalating cooldowns after "not yet" |
| `END_COOLDOWN_MIN` | 120 | cooldown after "remind at session end" |
| `MAX_UNANSWERED` | 3 | emitted-but-unanswered offers before the session goes quiet |
| `EVENT_CACHE_TTL_MIN` | 10 | wrp last-event query cache |
| `STATE_PRUNE_DAYS` | 7 | opportunistic stale-state cleanup |

Dependencies: `bash`, `jq`, `git`, `node` (wrp client). Missing or failing any
of them just disables the reminder (fail-open); `wrp init` fixes a 401.

## Headless warning

Settings-level hooks also run in `claude -p` (print) mode. There the reminder's
continued turn becomes the final stdout, which corrupts script pipelines such
as `claude -p … | jq`. This hook cannot distinguish interactive from headless
sessions, so **do not wire it on machines or projects that drive `claude -p`
in scripts** — or accept that a reminder may appear in the output once; the
`MAX_UNANSWERED` cap only bounds a last-offer loop, not the first polluted
run.
