#!/usr/bin/env bash
# Stop hook for the summarize-event skill.
#
# Fail-open is absolute: any error (missing jq/git/node, malformed stdin,
# corrupt state, git/wrp failure, non-git cwd) exits 0 with no output and
# nothing on stderr.  The whole body lives in main() so `main || exit 0`
# catches unexpected failures too.
exec 2>/dev/null
set +e

SESSION_BACKSTOP_MIN=${SESSION_BACKSTOP_MIN:-120}
BASE_COOLDOWN_MIN=${BASE_COOLDOWN_MIN:-20}
NOTYET_LADDER_MIN=${NOTYET_LADDER_MIN:-"30 60 120"}
END_COOLDOWN_MIN=${END_COOLDOWN_MIN:-120}
EVENT_CACHE_TTL_MIN=${EVENT_CACHE_TTL_MIN:-10}
STATE_PRUNE_DAYS=${STATE_PRUNE_DAYS:-7}
# After this many emitted-but-unanswered reminders the session goes quiet:
# the user is present but not engaging, so stop spending turns on offers.
MAX_UNANSWERED=${MAX_UNANSWERED:-3}

STATE_DIR=${WRP_REMIND_STATE_DIR:-"$HOME/.cache/wrp-remind"}
EVENTS_CMD=${WRP_EVENTS_CMD:-"node $HOME/.claude/skills/weekly-reporter/scripts/wrp.mjs events list --limit 1"}

# Atomically replace the current session's state file.  state_file is a local
# of main(); bash dynamic scoping makes it visible here.
write_state_json() {
  local tmp
  tmp=$(mktemp "$state_file.XXXXXX" 2>/dev/null) || return 1
  printf '%s\n' "$1" > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$state_file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  return 0
}

run_events_cmd() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 8 bash -c "$EVENTS_CMD" 2>/dev/null
  else
    bash -c "$EVENTS_CMD" 2>/dev/null
  fi
}

main() {
  local input sid cwd now state_file
  input=$(cat) || return 0
  [ -n "$input" ] || return 0
  printf '%s' "$input" | jq -e . >/dev/null 2>&1 || return 0

  # Guard 1: continuation round after a Stop hook already fired.
  jq -e '.stop_hook_active == true' >/dev/null 2>&1 <<<"$input" && return 0

  # Guard 2: session is not really ending (background work / scheduled wakeup).
  jq -e '((.background_tasks // []) | length) > 0 or ((.session_crons // []) | length) > 0' \
    >/dev/null 2>&1 <<<"$input" && return 0

  sid=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null) || return 0
  [ -n "$sid" ] || return 0
  case "$sid" in */*) return 0 ;; esac

  cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null) || cwd=""
  now=$(date +%s 2>/dev/null) || return 0

  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  state_file="$STATE_DIR/$sid.json"

  # First run for a sid (or the first run after a `now` reset deleted the
  # file): create the baseline.  session_first_seen_ts is the "last reset"
  # baseline used by the time backstop.
  if [ ! -f "$state_file" ]; then
    local fresh
    fresh=$(jq -cn --argjson now "$now" '{
      skip: false,
      last_offer_ts: 0,
      cooldown_min: 0,
      ladder_step: 0,
      unanswered: 0,
      session_first_seen_ts: $now,
      last_event_ts_cached: 0,
      last_event_fetched_at: 0
    }' 2>/dev/null) || return 0
    write_state_json "$fresh" || return 0
  fi

  # Read and validate state.  tonumber? // 0 keeps a weird-but-valid state
  # from breaking the arithmetic below.
  local skip last_offer cooldown first_seen cached_ts fetched_at unanswered vals
  vals=$(jq -r '[
    ((.skip // false) | tostring),
    ((.last_offer_ts // 0) | tonumber? // 0 | floor),
    ((.cooldown_min // 0) | tonumber? // 0 | floor),
    ((.session_first_seen_ts // 0) | tonumber? // 0 | floor),
    ((.last_event_ts_cached // 0) | tonumber? // 0 | floor),
    ((.last_event_fetched_at // 0) | tonumber? // 0 | floor),
    ((.unanswered // 0) | tonumber? // 0 | floor)
  ] | @tsv' "$state_file" 2>/dev/null) || return 0
  [ -n "$vals" ] || return 0
  IFS=$'\t' read -r skip last_offer cooldown first_seen cached_ts fetched_at unanswered <<<"$vals"

  # Guard 3: the user chose "skip for this session".
  [ "$skip" = "true" ] && return 0

  # Guard 3b: too many emitted-but-unanswered reminders — treat the session
  # as skipped. No auto-answer: un-logged work simply stays un-logged.
  [ "$unanswered" -ge "$MAX_UNANSWERED" ] 2>/dev/null && return 0

  # Guard 4: still inside the cooldown window.
  if [ $((now - last_offer)) -lt $((cooldown * 60)) ]; then return 0; fi

  # Fail open outside a git work tree: ADR 0034 lists a non-git cwd among the
  # silent-pass error conditions.  Resolve the repo before querying wrp so the
  # network call only happens where it can matter.
  [ -n "$cwd" ] || return 0
  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  local toplevel repo
  toplevel=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -n "$toplevel" ] || return 0
  repo=$(basename "$toplevel" 2>/dev/null) || return 0
  [ -n "$repo" ] || return 0

  # Resolve the last timeline event.  A cache younger than the TTL avoids the
  # API call; a failed query with no fresh cache fails open.
  local event_epoch event_iso_used
  if [ "$fetched_at" -gt 0 ] && [ $((now - fetched_at)) -lt $((EVENT_CACHE_TTL_MIN * 60)) ]; then
    event_epoch=$cached_ts
    if [ "$event_epoch" -gt 0 ]; then
      event_iso_used=$(date -u -d "@$event_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) \
        || event_iso_used="1970-01-01T00:00:00Z"
    else
      event_iso_used="1970-01-01T00:00:00Z"
    fi
  else
    local raw ev_iso updated
    if ! raw=$(run_events_cmd); then
      return 0
    fi
    printf '%s' "$raw" | jq -e '(.events | type) == "array"' >/dev/null 2>&1 || return 0
    ev_iso=$(printf '%s' "$raw" | jq -r '.events[0].eventTime // empty' 2>/dev/null) || return 0
    if [ -n "$ev_iso" ]; then
      event_epoch=$(date -d "$ev_iso" +%s 2>/dev/null) || return 0
      case "$event_epoch" in ''|*[!0-9]*) return 0 ;; esac
      event_iso_used=$ev_iso
    else
      event_epoch=0
      event_iso_used="1970-01-01T00:00:00Z"
    fi
    updated=$(jq -c --argjson ts "$event_epoch" --argjson at "$now" \
      '.last_event_ts_cached=$ts | .last_event_fetched_at=$at' "$state_file" 2>/dev/null) || return 0
    write_state_json "$updated" || return 0
    # The backstop below must see the value we just fetched, not the stale one.
    cached_ts=$event_epoch
  fi

  # Trigger A: commits in the hook's cwd since the last timeline event.
  local trigger=0 n=0 commits
  if git -C "$cwd" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    commits=$(git -C "$cwd" log --since="$event_iso_used" --format=%H 2>/dev/null) || return 0
    if [ -n "$commits" ]; then
      n=$(printf '%s\n' "$commits" | grep -c . 2>/dev/null)
      [ -n "$n" ] || n=0
      if [ "$n" -gt 0 ]; then trigger=1; fi
    fi
  fi

  # Trigger B: time backstop for work with no commit trail.
  local baseline=$first_seen
  if [ "$cached_ts" -gt "$baseline" ]; then baseline=$cached_ts; fi
  if [ $((now - baseline)) -ge $((SESSION_BACKSTOP_MIN * 60)) ]; then trigger=1; fi

  [ "$trigger" -eq 1 ] || return 0

  local text
  text="Stop-hook reminder (summarize-event): ${n} un-logged commit(s) in ${repo} since ${event_iso_used}, or this session has run long without a timeline event. Session id: ${sid}. Make the summarize-event offer now per its four-option rules, covering any un-logged non-commit work from this session (tests, reviews, debugging) as well. After the user answers, land the state with remind-state ${sid} <now|notyet|skip|end>: 'now' after the event is created (resets everything), 'notyet' starts/escalates the cooldown, 'skip' silences this session, 'end' records the offer time and keeps the safety net armed."

  # Self-stamp before emitting so an unanswered offer cannot re-fire every
  # round.  The cooldown never de-escalates within a session: keep whichever
  # is larger, the existing cooldown (set by notyet/end answers) or the base —
  # an unanswered offer after "end" must not collapse 120min back to 20.
  # `now` (which deletes the state file) is the only reset point.
  # unanswered counts offers that were emitted but never answered; any
  # remind-state answer clears it, and MAX_UNANSWERED caps the whole session.
  # If the state cannot be written, stay silent rather than nag.
  local stamped
  stamped=$(jq -c --argjson now "$now" --argjson cd "$BASE_COOLDOWN_MIN" \
    '.last_offer_ts=$now
     | .cooldown_min=(if .cooldown_min > $cd then .cooldown_min else $cd end)
     | .unanswered=((.unanswered // 0) + 1)' \
    "$state_file" 2>/dev/null) || return 0
  write_state_json "$stamped" || return 0

  # Opportunistic stale-state cleanup.
  find "$STATE_DIR" -name '*.json' -mtime +"$STATE_PRUNE_DAYS" -delete 2>/dev/null

  jq -n --arg t "$text" '{hookSpecificOutput:{hookEventName:"Stop",additionalContext:$t}}'
  return 0
}

main || exit 0
exit 0
