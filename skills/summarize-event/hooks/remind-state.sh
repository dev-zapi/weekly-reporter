#!/usr/bin/env bash
# remind-state.sh <session-id> <now|notyet|skip|end|show>
#
# Lands a summarize-event offer answer in the per-session reminder state.
# Internal errors fail open silently; malformed usage exits 2 with a one-line
# usage message (this script is driven by an agent, not the harness).
set +e

# Mirrors the tuning constants in stop-reminder.sh.  Env overrides of the same
# names win, so both scripts stay consistent.
NOTYET_LADDER_MIN=${NOTYET_LADDER_MIN:-"30 60 120"}
END_COOLDOWN_MIN=${END_COOLDOWN_MIN:-120}

STATE_DIR=${WRP_REMIND_STATE_DIR:-"$HOME/.cache/wrp-remind"}

usage() {
  echo "usage: remind-state.sh <session-id> <now|notyet|skip|end|show>" >&2
  exit 2
}

write_state_json() {
  local tmp
  tmp=$(mktemp "$state_file.XXXXXX" 2>/dev/null) || return 1
  printf '%s\n' "$1" > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$state_file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  return 0
}

ensure_state() {
  [ -f "$state_file" ] && return 0
  local now fresh
  now=$(date +%s 2>/dev/null) || return 1
  fresh=$(jq -cn --argjson now "$now" '{
    skip: false,
    last_offer_ts: 0,
    cooldown_min: 0,
    ladder_step: 0,
    unanswered: 0,
    session_first_seen_ts: $now,
    last_event_ts_cached: 0,
    last_event_fetched_at: 0
  }' 2>/dev/null) || return 1
  write_state_json "$fresh" || return 1
  return 0
}

main() {
  [ $# -eq 2 ] || usage
  local sid=$1 action=$2
  # Strict whitelist: the sid becomes a filename under the state dir; reject
  # anything beyond UUID-safe characters rather than just slashes.
  case "$sid" in ''|*[!A-Za-z0-9_-]*) usage ;; esac
  case "$action" in now|notyet|skip|end|show) ;; *) usage ;; esac

  state_file="$STATE_DIR/$sid.json"

  if [ "$action" = "show" ]; then
    if [ -f "$state_file" ]; then
      jq -c . "$state_file" 2>/dev/null || echo '{}'
    else
      echo '{}'
    fi
    return 0
  fi

  mkdir -p "$STATE_DIR" 2>/dev/null || return 0

  if [ "$action" = "now" ]; then
    # Full reset: the next Stop hook run re-creates a fresh baseline.
    rm -f "$state_file" 2>/dev/null
    return 0
  fi

  ensure_state || return 0

  local now json
  case "$action" in
    notyet)
      local step cooldown idx last
      local -a ladder
      step=$(jq -r '((.ladder_step // 0) | tonumber? // 0 | floor)' "$state_file" 2>/dev/null) || return 0
      [ -n "$step" ] || step=0
      [ "$step" -ge 0 ] 2>/dev/null || step=0
      read -r -a ladder <<<"$NOTYET_LADDER_MIN"
      if [ "${#ladder[@]}" -eq 0 ]; then
        ladder=(30 60 120)
      fi
      last=$(( ${#ladder[@]} - 1 ))
      idx=$step
      if [ "$idx" -gt "$last" ]; then idx=$last; fi
      cooldown=${ladder[$idx]}
      now=$(date +%s 2>/dev/null) || return 0
      json=$(jq -c --argjson cd "$cooldown" --argjson step "$((step + 1))" --argjson now "$now" \
        '.cooldown_min=$cd | .ladder_step=$step | .last_offer_ts=$now | .unanswered=0' \
        "$state_file" 2>/dev/null) || return 0
      write_state_json "$json"
      ;;
    skip)
      json=$(jq -c '.skip=true | .unanswered=0' "$state_file" 2>/dev/null) || return 0
      write_state_json "$json"
      ;;
    end)
      now=$(date +%s 2>/dev/null) || return 0
      json=$(jq -c --argjson cd "$END_COOLDOWN_MIN" --argjson now "$now" \
        '.cooldown_min=$cd | .last_offer_ts=$now | .unanswered=0' "$state_file" 2>/dev/null) || return 0
      write_state_json "$json"
      ;;
  esac
  return 0
}

main "$@"
exit 0
