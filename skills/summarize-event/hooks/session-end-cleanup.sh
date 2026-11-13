#!/usr/bin/env bash
# SessionEnd hook for the summarize-event skill: drop this session's state.
# Always exits 0 and never writes to stderr.
exec 2>/dev/null
set +e

main() {
  local input sid state_dir
  input=$(cat) || return 0
  [ -n "$input" ] || return 0
  sid=$(printf '%s' "$input" | jq -r '(.session_id // empty) | tostring' 2>/dev/null) || return 0
  [ -n "$sid" ] || return 0
  case "$sid" in */*) return 0 ;; esac
  state_dir=${WRP_REMIND_STATE_DIR:-"$HOME/.cache/wrp-remind"}
  rm -f "$state_dir/$sid.json" 2>/dev/null
  return 0
}

main || true
exit 0
