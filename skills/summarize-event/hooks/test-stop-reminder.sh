#!/usr/bin/env bash
# Fixtures-driven tests for the summarize-event hook scripts.
#
#   bash test-stop-reminder.sh
#
# Exit 0 when every case passes, 1 otherwise.  Each case prints PASS/FAIL.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STOP="$HERE/stop-reminder.sh"
REMIND="$HERE/remind-state.sh"
CLEANUP="$HERE/session-end-cleanup.sh"

PASS=0
FAIL=0

TMP=$(mktemp -d) || { echo "FAIL: cannot create temp dir"; exit 1; }
# shellcheck disable=SC2329  # invoked indirectly by the EXIT trap
cleanup_tmp() { rm -rf "$TMP"; }
trap cleanup_tmp EXIT

STATE_DIR="$TMP/state"
mkdir -p "$STATE_DIR"

REPO="$TMP/repo"
NONGIT="$TMP/nongit"
mkdir -p "$NONGIT"

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ -- $2}"; }

# ---------------------------------------------------------------------------
# Tool sanity
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required by both the hook and the tests"
  exit 1
fi
pass "sanity: jq available ($(jq --version 2>/dev/null))"

SANITY_OUT=$(bash "$STOP" </dev/null 2>"$TMP/sanity.err")
SANITY_RC=$?
if [ "$SANITY_RC" -eq 0 ] && [ -z "$SANITY_OUT" ] && [ ! -s "$TMP/sanity.err" ]; then
  pass "sanity: real script exits 0 silently on empty stdin"
else
  fail "sanity: real script exits 0 silently on empty stdin" \
    "rc=$SANITY_RC out=$(printf %q "$SANITY_OUT") err=$(printf %q "$(cat "$TMP/sanity.err")")"
fi

# ---------------------------------------------------------------------------
# Fixtures: time helpers, git repo, events stub
# ---------------------------------------------------------------------------
now=$(date +%s)
iso_at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

git init -q "$REPO" || { echo "FAIL: git init failed"; exit 1; }
git -C "$REPO" config user.email "hook-test@example.com"
git -C "$REPO" config user.name "Hook Test"

C1=$(iso_at $((now - 3600)))
C2=$(iso_at $((now - 1800)))
GIT_AUTHOR_DATE="$C1" GIT_COMMITTER_DATE="$C1" \
  git -C "$REPO" commit -q --allow-empty -m "first fixture commit"
GIT_AUTHOR_DATE="$C2" GIT_COMMITTER_DATE="$C2" \
  git -C "$REPO" commit -q --allow-empty -m "second fixture commit"

if [ "$(git -C "$REPO" rev-list --count HEAD 2>/dev/null)" = "2" ]; then
  pass "sanity: temp git repo has 2 dated commits"
else
  fail "sanity: temp git repo has 2 dated commits" "rev-list count mismatch"
fi

# A second repo whose commits are older than the backstop fixture's last
# event, so the backstop case has no commits to trip the commit trigger.
REPO_OLD="$TMP/repo-old"
git init -q "$REPO_OLD" || { echo "FAIL: git init (old) failed"; exit 1; }
git -C "$REPO_OLD" config user.email "hook-test@example.com"
git -C "$REPO_OLD" config user.name "Hook Test"
O1=$(iso_at $((now - 4 * 3600)))
O2=$(iso_at $((now - 3 * 3600)))
GIT_AUTHOR_DATE="$O1" GIT_COMMITTER_DATE="$O1" \
  git -C "$REPO_OLD" commit -q --allow-empty -m "old first commit"
GIT_AUTHOR_DATE="$O2" GIT_COMMITTER_DATE="$O2" \
  git -C "$REPO_OLD" commit -q --allow-empty -m "old second commit"

cat >"$TMP/events-ok.sh" <<'STUB'
#!/usr/bin/env bash
printf '{"events":[{"eventTime":"%s"}]}\n' "${STUB_EVENT_TIME:?}"
STUB
cat >"$TMP/events-empty.sh" <<'STUB'
#!/usr/bin/env bash
printf '{"events":[]}\n'
STUB
cat >"$TMP/events-fail.sh" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
cat >"$TMP/events-counting.sh" <<'STUB'
#!/usr/bin/env bash
echo called >>"${CALL_LOG:?}"
printf '{"events":[{"eventTime":"%s"}]}\n' "${STUB_EVENT_TIME:?}"
STUB
chmod +x "$TMP"/events-*.sh

# Event instants: old enough that both fixture commits are "since" it, and
# recent enough that neither commit is.
EVENT_OLD=$(iso_at $((now - 7200)))
EVENT_RECENT=$(iso_at $((now - 60)))
EVENT_VERY_OLD=$(iso_at $((now - 140 * 60)))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RC=0
OUT=""
ERR=""

run_hook() { # input, events-cmd, event-time
  local input=$1 events_cmd=${2:-$TMP/events-ok.sh} event_time=${3:-}
  WRP_REMIND_STATE_DIR="$STATE_DIR" \
  WRP_EVENTS_CMD="$events_cmd" \
  STUB_EVENT_TIME="$event_time" \
  CALL_LOG="${CALL_LOG:-}" \
  GIT_CEILING_DIRECTORIES="$TMP" \
    bash "$STOP" <<<"$input" >"$TMP/hook.out" 2>"$TMP/hook.err"
  RC=$?
  OUT=$(cat "$TMP/hook.out")
  ERR=$(cat "$TMP/hook.err")
}

input_for() { # sid, cwd, extra-json (optional object)
  local sid=$1 cwd=$2 extra=${3:-}
  if [ -n "$extra" ]; then
    jq -cn --arg sid "$sid" --arg cwd "$cwd" --argjson extra "$extra" \
      '{session_id:$sid,cwd:$cwd,stop_hook_active:false,background_tasks:[],session_crons:[]} + $extra'
  else
    jq -cn --arg sid "$sid" --arg cwd "$cwd" \
      '{session_id:$sid,cwd:$cwd,stop_hook_active:false,background_tasks:[],session_crons:[]}'
  fi
}

state_path() { echo "$STATE_DIR/$1.json"; }
reset_state() { rm -f "$(state_path "$1")"; }
show_state() { jq -r "$2" "$(state_path "$1")" 2>/dev/null; }

make_state() { # sid first_seen last_offer cooldown skip ladder cached fetched [unanswered=0]
  jq -cn \
    --argjson fs "$2" --argjson lo "$3" --argjson cd "$4" --argjson sk "$5" \
    --argjson ls "$6" --argjson cached "$7" --argjson fetched "$8" \
    --argjson ua "${9:-0}" \
    '{skip:$sk,last_offer_ts:$lo,cooldown_min:$cd,ladder_step:$ls,unanswered:$ua,session_first_seen_ts:$fs,last_event_ts_cached:$cached,last_event_fetched_at:$fetched}' \
    >"$(state_path "$1")"
}

assert_silent_pass() {
  local name=$1
  if [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; then
    pass "$name"
  else
    fail "$name" "rc=$RC out=$(printf %q "$OUT") err=$(printf %q "$ERR")"
  fi
}

assert_reminder() { # name sid repo-substring expected-N
  local name=$1 sid=$2 repo_sub=$3 n_expected=$4
  local ok=1 why=""
  local ctx
  if [ "$RC" -ne 0 ]; then ok=0; why="rc=$RC"; fi
  if [ -n "$ERR" ]; then ok=0; why="$why stderr=$(printf %q "$ERR")"; fi
  if [ -z "$OUT" ]; then
    ok=0; why="$why empty stdout"
  else
    printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "Stop"' >/dev/null 2>&1 \
      || { ok=0; why="$why bad hookSpecificOutput shape"; }
    ctx=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)
    case "$ctx" in *"$sid"*) ;; *) ok=0; why="$why missing session id" ;; esac
    case "$ctx" in *"$repo_sub"*) ;; *) ok=0; why="$why missing repo '$repo_sub'" ;; esac
    case "$ctx" in
      *"$n_expected un-logged commit(s)"*) ;;
      *) ok=0; why="$why missing commit count $n_expected" ;;
    esac
  fi
  if [ "$ok" -eq 1 ]; then pass "$name"; else fail "$name" "$why"; fi
}

assert_self_stamped() { # name sid since-epoch [expected-cooldown=20]
  local name=$1 sid=$2 since=$3 want_cd=${4:-20}
  local cd lo
  cd=$(show_state "$sid" '.cooldown_min')
  lo=$(show_state "$sid" '.last_offer_ts')
  if [ "$cd" = "$want_cd" ] && [ -n "$lo" ] && [ "$lo" -ge "$since" ] 2>/dev/null; then
    pass "$name"
  else
    fail "$name" "cooldown_min=$(printf %q "$cd") want=$want_cd last_offer_ts=$(printf %q "$lo")"
  fi
}

# ---------------------------------------------------------------------------
# 1-3. Input guards
# ---------------------------------------------------------------------------
reset_state case1
input=$(jq -cn --arg sid case1 --arg cwd "$REPO" \
  '{session_id:$sid,cwd:$cwd,stop_hook_active:true,background_tasks:[],session_crons:[]}')
run_hook "$input" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "1. stop_hook_active:true passes"

reset_state case2
input=$(jq -cn --arg sid case2 --arg cwd "$REPO" \
  '{session_id:$sid,cwd:$cwd,stop_hook_active:false,background_tasks:[{"id":"bg1"}],session_crons:[]}')
run_hook "$input" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "2. non-empty background_tasks passes"

reset_state case3
input=$(jq -cn --arg sid case3 --arg cwd "$REPO" \
  '{session_id:$sid,cwd:$cwd,stop_hook_active:false,background_tasks:[],session_crons:[{"id":"cron1"}]}')
run_hook "$input" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "3. non-empty session_crons passes"

# ---------------------------------------------------------------------------
# 4-6. State guards and non-triggers
# ---------------------------------------------------------------------------
make_state case4 "$now" 0 0 true 0 0 0
run_hook "$(input_for case4 "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "4. skip:true state passes"

make_state case5 "$now" $((now - 60)) 20 false 0 0 0
run_hook "$(input_for case5 "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "5. last_offer_ts inside cooldown passes"

reset_state case6
run_hook "$(input_for case6 "$REPO")" "$TMP/events-ok.sh" "$EVENT_RECENT"
assert_silent_pass "6. no new commits and young session passes"

# 6b. A fresh event cache avoids re-querying wrp on the next Stop.
reset_state case6b
CALL_LOG="$TMP/cache-calls.log"
: >"$CALL_LOG"
run_hook "$(input_for case6b "$REPO")" "$TMP/events-counting.sh" "$EVENT_RECENT"
first_calls=$(wc -l <"$CALL_LOG")
run_hook "$(input_for case6b "$REPO")" "$TMP/events-counting.sh" "$EVENT_RECENT"
second_calls=$(wc -l <"$CALL_LOG")
if [ "$first_calls" = "1" ] && [ "$second_calls" = "1" ] && [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; then
  pass "6b. fresh event cache skips the wrp query"
else
  fail "6b. fresh event cache skips the wrp query" \
    "first_calls=$first_calls second_calls=$second_calls rc=$RC out=$(printf %q "$OUT")"
fi

# 6c. An empty timeline counts as epoch 0, so every commit is un-logged.
reset_state case6c
run_hook "$(input_for case6c "$REPO")" "$TMP/events-empty.sh" ""
assert_reminder "6c. empty timeline treats every commit as un-logged" case6c "$(basename "$REPO")" 2

# ---------------------------------------------------------------------------
# 7. New commits trigger + self-stamp
# ---------------------------------------------------------------------------
reset_state case7
before=$(date +%s)
run_hook "$(input_for case7 "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_reminder "7. new commits since last event emits reminder" case7 "$(basename "$REPO")" 2
assert_self_stamped "7b. emitted reminder self-stamps base cooldown" case7 "$before"

# 7c. Self-stamp never de-escalates: once a notyet/end answer has raised the
# cooldown (here 120), an unanswered later offer keeps 120 instead of
# collapsing back to the base 20 and re-nagging every 20 minutes.
make_state case7c "$now" $((now - 130 * 60)) 120 false 0 0 0
before=$(date +%s)
run_hook "$(input_for case7c "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_reminder "7c. reminder fires after a 120min cooldown elapsed" case7c "$(basename "$REPO")" 2
assert_self_stamped "7c2. self-stamp keeps the escalated cooldown (120)" case7c "$before" 120

# 7d/7e. Unanswered cap: emitted offers increment the counter (7d), and once
# the cap (3) is reached the session goes quiet even with new commits (7e).
# No auto-answer — un-logged work simply stays un-logged.
make_state case7d "$now" 0 0 false 0 0 0 2
run_hook "$(input_for case7d "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_reminder "7d. third unanswered offer is emitted" case7d "$(basename "$REPO")" 2
ua7d=$(show_state case7d '.unanswered')
if [ "$ua7d" = "3" ]; then
  pass "7d2. emitted offer increments unanswered to 3"
else
  fail "7d2. emitted offer increments unanswered to 3" "unanswered=$(printf %q "$ua7d")"
fi
make_state case7e "$now" 0 0 false 0 0 0 3
run_hook "$(input_for case7e "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "7e. unanswered cap silences the hook despite new commits"

# ---------------------------------------------------------------------------
# 8. Time backstop (no commit trail)
# ---------------------------------------------------------------------------
make_state case8 $((now - 130 * 60)) 0 0 false 0 0 0
before=$(date +%s)
run_hook "$(input_for case8 "$REPO_OLD")" "$TMP/events-ok.sh" "$EVENT_VERY_OLD"
assert_reminder "8. time backstop fires after 120min without an event" case8 "$(basename "$REPO_OLD")" 0
assert_self_stamped "8b. backstop reminder self-stamps base cooldown" case8 "$before"

# 8c. A non-git cwd is an explicit fail-open condition (ADR 0034).
make_state case8c $((now - 130 * 60)) 0 0 false 0 0 0
run_hook "$(input_for case8c "$NONGIT")" "$TMP/events-ok.sh" "$EVENT_VERY_OLD"
assert_silent_pass "8c. non-git cwd passes silently"

# 8d. A stale cache must be refreshed before the backstop baseline is
# computed: an old first_seen plus a *recent* event means no backstop.
make_state case8d $((now - 130 * 60)) 0 0 false 0 $((now - 5000)) $((now - 1000))
run_hook "$(input_for case8d "$REPO")" "$TMP/events-ok.sh" "$EVENT_RECENT"
assert_silent_pass "8d. freshly fetched recent event suppresses the backstop"

# ---------------------------------------------------------------------------
# 9-11. Fail-open paths
# ---------------------------------------------------------------------------
reset_state case9
run_hook "$(input_for case9 "$REPO")" "$TMP/events-fail.sh" ""
assert_silent_pass "9. failing events command without a fresh cache passes"

run_hook 'this is not json' "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "10. malformed stdin passes"

printf '%s\n' '{ this is not valid json' >"$(state_path case11)"
run_hook "$(input_for case11 "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "11. corrupt state file passes"

# 11b. A session id outside the UUID-safe whitelist is rejected outright
# (traversal, spaces, metacharacters) — no state file, no reminder.
input=$(jq -cn --arg sid 'a b;$(id)' --arg cwd "$REPO" \
  '{session_id:$sid,cwd:$cwd,stop_hook_active:false,background_tasks:[],session_crons:[]}')
run_hook "$input" "$TMP/events-ok.sh" "$EVENT_OLD"
assert_silent_pass "11b. metacharacter session id passes silently"

# ---------------------------------------------------------------------------
# 12. remind-state + SessionEnd cleanup behaviors
# ---------------------------------------------------------------------------
# 12a. notyet ladder 30 -> 60
reset_state case12a
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12a notyet >/dev/null 2>&1
ny_rc1=$?
ny_cd1=$(show_state case12a '.cooldown_min')
ny_ls1=$(show_state case12a '.ladder_step')
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12a notyet >/dev/null 2>&1
ny_rc2=$?
ny_cd2=$(show_state case12a '.cooldown_min')
ny_ls2=$(show_state case12a '.ladder_step')
if [ "$ny_rc1" -eq 0 ] && [ "$ny_rc2" -eq 0 ] &&
   [ "$ny_cd1" = "30" ] && [ "$ny_ls1" = "1" ] &&
   [ "$ny_cd2" = "60" ] && [ "$ny_ls2" = "2" ]; then
  pass "12a. remind-state notyet escalates 30 then 60"
else
  fail "12a. remind-state notyet escalates 30 then 60" \
    "cd1=$(printf %q "$ny_cd1") ls1=$(printf %q "$ny_ls1") cd2=$(printf %q "$ny_cd2") ls2=$(printf %q "$ny_ls2")"
fi

# 12a2. The ladder clamps at its last entry (120).
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12a notyet >/dev/null 2>&1
clamp1=$(show_state case12a '.cooldown_min')
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12a notyet >/dev/null 2>&1
clamp2=$(show_state case12a '.cooldown_min')
if [ "$clamp1" = "120" ] && [ "$clamp2" = "120" ]; then
  pass "12a2. remind-state notyet ladder clamps at 120"
else
  fail "12a2. remind-state notyet ladder clamps at 120" \
    "third=$(printf %q "$clamp1") fourth=$(printf %q "$clamp2")"
fi

# 12b. skip silences the Stop hook even when commits exist
reset_state case12b
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12b skip >/dev/null 2>&1
skip_value=$(show_state case12b '.skip')
run_hook "$(input_for case12b "$REPO")" "$TMP/events-ok.sh" "$EVENT_OLD"
if [ "$skip_value" = "true" ]; then
  assert_silent_pass "12b. remind-state skip silences the hook"
else
  fail "12b. remind-state skip silences the hook" "state skip=$(printf %q "$skip_value")"
fi

# 12c. now deletes the state file
make_state case12c "$now" 0 0 false 0 0 0
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12c now >/dev/null 2>&1
if [ ! -f "$(state_path case12c)" ]; then
  pass "12c. remind-state now deletes the state file"
else
  fail "12c. remind-state now deletes the state file"
fi

# 12d. end records the offer time and uses the top cooldown, leaving skip alone
reset_state case12d
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12d end >/dev/null 2>&1
end_cd=$(show_state case12d '.cooldown_min')
end_lo=$(show_state case12d '.last_offer_ts')
end_skip=$(show_state case12d '.skip')
if [ "$end_cd" = "120" ] && [ -n "$end_lo" ] && [ "$end_lo" -gt 0 ] 2>/dev/null && [ "$end_skip" = "false" ]; then
  pass "12d. remind-state end sets 120min cooldown"
else
  fail "12d. remind-state end sets 120min cooldown" \
    "cooldown=$(printf %q "$end_cd") last_offer_ts=$(printf %q "$end_lo") skip=$(printf %q "$end_skip")"
fi

# 12d2. end leaves an existing skip flag alone.
make_state case12d2 "$now" 0 0 true 0 0 0
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12d2 end >/dev/null 2>&1
end2_cd=$(show_state case12d2 '.cooldown_min')
end2_skip=$(show_state case12d2 '.skip')
if [ "$end2_cd" = "120" ] && [ "$end2_skip" = "true" ]; then
  pass "12d2. remind-state end leaves skip untouched"
else
  fail "12d2. remind-state end leaves skip untouched" \
    "cooldown=$(printf %q "$end2_cd") skip=$(printf %q "$end2_skip")"
fi

# 12e. show prints the state, or {} when absent
absent=$(WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" no-such-session show 2>/dev/null)
present=$(WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12d show 2>/dev/null)
if [ "$absent" = "{}" ] && printf '%s' "$present" | jq -e '.cooldown_min == 120' >/dev/null 2>&1; then
  pass "12e. remind-state show prints state or {}"
else
  fail "12e. remind-state show prints state or {}" \
    "absent=$(printf %q "$absent") present=$(printf %q "$present")"
fi

# 12f. unknown usage exits 2 with a one-line message
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" only-one-arg >/dev/null 2>"$TMP/usage.err"
usage_rc=$?
if [ "$usage_rc" -eq 2 ] && [ -s "$TMP/usage.err" ] && [ "$(wc -l <"$TMP/usage.err")" -eq 1 ]; then
  pass "12f. unknown usage exits 2 with one-line stderr"
else
  fail "12f. unknown usage exits 2 with one-line stderr" \
    "rc=$usage_rc err=$(printf %q "$(cat "$TMP/usage.err")")"
fi

# 12g. SessionEnd cleanup removes this session's file
make_state case12g "$now" 0 0 false 0 0 0
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$CLEANUP" <<<"$(jq -cn '{session_id:"case12g"}')" >/dev/null 2>&1
cleanup_rc=$?
if [ "$cleanup_rc" -eq 0 ] && [ ! -f "$(state_path case12g)" ]; then
  pass "12g. session-end-cleanup removes the state file"
else
  fail "12g. session-end-cleanup removes the state file" "rc=$cleanup_rc"
fi

# 12h. Any remind-state answer clears the unanswered counter.
make_state case12h "$now" 0 0 false 0 0 0 5
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" case12h notyet >/dev/null 2>&1
ua12h=$(show_state case12h '.unanswered')
if [ "$ua12h" = "0" ]; then
  pass "12h. remind-state answer resets unanswered"
else
  fail "12h. remind-state answer resets unanswered" "unanswered=$(printf %q "$ua12h")"
fi

# 12i. Path traversal and metacharacter sids are refused by remind-state
# (whitelist) and by the SessionEnd cleanup (which must not delete anything).
for bad_sid in '../evil' 'a b' 'x;y'; do
  if WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$REMIND" "$bad_sid" now >/dev/null 2>&1; then
    fail "12i. remind-state rejects unsafe sid '$bad_sid'" "exit was 0"
  else
    pass "12i. remind-state rejects unsafe sid '$bad_sid'"
  fi
done
printf '%s\n' '{}' >"$(state_path 'x*y')"
WRP_REMIND_STATE_DIR="$STATE_DIR" bash "$CLEANUP" <<<"$(jq -cn '{session_id:"x*y"}')" >/dev/null 2>&1
if [ -f "$(state_path 'x*y')" ]; then
  pass "12j. cleanup ignores unsafe sid and deletes nothing"
else
  fail "12j. cleanup ignores unsafe sid and deletes nothing"
fi
rm -f "$(state_path 'x*y')"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "passed: $PASS  failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
