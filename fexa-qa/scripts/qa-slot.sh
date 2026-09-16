#!/usr/bin/env bash
# Auto slot detection for parallel fexa-qa instances.
#
# Slot 0 = the user's DEV stack (Rails :3000 / fmdev / PWA :5173, main checkouts).
# It is RESERVED: QA never claims it, even when idle (FEXA_QA_MIN_SLOT=1).
# Slot N>=1 = an isolated stack per O11 (own worktrees, Rails :3000+100N, redis
# :6379+N, PWA :5173+10N, cloned DB). The first instance to claim gets 1, the
# next gets 2, and so on — nobody has to be told they are "the second one".
#
# A claim is a file in /tmp/fexa-qa-slots/<slot>.json holding the pid of the
# Claude session that owns it ($PPID of every tool shell that session runs —
# stable for the session's lifetime). A claim whose pid is dead is stale and
# gets reused. A slot is also treated as taken when its ports are already
# listening. (Slot 0's TANGO DB-lock check is kept for `status` only.)
#
# Usage (from any shell of the instance):
#   eval "$(qa-slot.sh claim <TICKET>)"   # once, in preflight — prints the export block
#   eval "$(qa-slot.sh env)"              # every later shell — re-prints the same block
#   qa-slot.sh release                    # at the end (also safe if never claimed)
#   qa-slot.sh status                     # list claims
set -euo pipefail

CMD=${1:-status}
DIR=${FEXA_QA_SLOT_DIR:-/tmp/fexa-qa-slots}
MAX=${FEXA_QA_MAX_SLOTS:-3}
MIN=${FEXA_QA_MIN_SLOT:-1}   # 0 is the dev stack — never handed to QA by default
# The owner is the Claude session process: walk up from this script's parent
# (a per-call tool shell) to the nearest ancestor named `claude`. Falls back to
# the immediate parent when run outside Claude Code.
session_pid() {
  local p=$PPID c
  while [ "$p" -gt 1 ]; do
    c=$(ps -o comm= -p "$p" 2>/dev/null || true)
    [ "$c" = claude ] && { echo "$p"; return; }
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)
    [ -z "$p" ] && break
  done
  echo "$PPID"
}
OWNER=${FEXA_QA_OWNER_PID:-$(session_pid)}
mkdir -p "$DIR"

alive() { [ -n "${1:-}" ] && [ -d "/proc/$1" ]; }
claim_pid()    { [ -f "$DIR/$1.json" ] && sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$DIR/$1.json" || true; }
claim_ticket() { [ -f "$DIR/$1.json" ] && sed -n 's/.*"ticket": *"\([^"]*\)".*/\1/p' "$DIR/$1.json" || true; }
listening() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }

# TANGO's DB lock (scripts/with-db-lock.mjs) for the normal fmdev stack: held by
# a live pid means slot 0 is busy even without a claim.
db_lock_busy() {
  local f p
  for f in /tmp/tango-cmms-db.*.lock/holder.json; do
    [ -f "$f" ] || continue
    p=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$f" || true)
    alive "$p" && return 0
  done
  return 1
}

slot_busy() {
  local s=$1 p
  p=$(claim_pid "$s")
  if [ -n "$p" ]; then
    if alive "$p"; then [ "$p" = "$OWNER" ] && return 1; return 0; fi
    rm -f "$DIR/$s.json"   # stale
  fi
  if [ "$s" = 0 ]; then db_lock_busy && return 0; return 1; fi
  listening $((3000 + 100 * s)) && return 0
  listening $((5173 + 10 * s)) && return 0
  return 1
}

# Playwright's reuseExistingServer adopts WHATEVER listens on the slot's PWA
# port — a stranger's dev server means the suite silently tests another stack.
# Warn loudly when the port is held by a process outside this slot's worktree.
warn_foreign_listener() {
  local port=$1 pid cwd
  pid=$(ss -ltnp 2>/dev/null | awk -v P=":$port " '$0 ~ P {match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)
  [ -z "$pid" ] && return 0
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  case "$cwd" in
    */.claude/worktrees/qa-*) return 0 ;;
    *) echo "[qa-slot] WARNING: port $port is served by pid $pid from $cwd — NOT a parallel-slot worktree. Playwright would adopt it; pick another FEXA_PWA_PORT or stop that server." >&2 ;;
  esac
}
print_env() {
  local s=$1
  echo "export FEXA_QA_SLOT=$s"
  [ "$s" = 0 ] && return 0
  warn_foreign_listener $((5173 + 10 * s))
  echo "export CMMS_PORT=$((3000 + 100 * s)) REDIS_PORT=$((6379 + s))"
  echo "export TEST_BASE_URL=http://localhost:$((3000 + 100 * s))"
  echo "export FEXA_PWA_PORT=$((5173 + 10 * s))"
  echo "export TANGO_LOCK_LABEL=${2:-slot-$s}"
}

case "$CMD" in
  claim)
    TICKET=${2:?ticket key required}
    # Already claimed by this session? Reuse it.
    for f in "$DIR"/*.json; do
      [ -f "$f" ] || continue
      s=$(basename "$f" .json)
      [ "$(claim_pid "$s")" = "$OWNER" ] && { print_env "$s" "$TICKET"; exit 0; }
    done
    for s in $(seq "$MIN" "$MAX"); do
      slot_busy "$s" && continue
      printf '{"slot": %s, "pid": %s, "ticket": "%s", "claimedAt": "%s"}\n' \
        "$s" "$OWNER" "$TICKET" "$(date -Is)" > "$DIR/$s.json"
      print_env "$s" "$TICKET"
      exit 0
    done
    echo "[qa-slot] no free slot ($MIN..$MAX all busy) — wait, or raise FEXA_QA_MAX_SLOTS" >&2
    exit 75
    ;;
  env)
    for f in "$DIR"/*.json; do
      [ -f "$f" ] || continue
      s=$(basename "$f" .json)
      [ "$(claim_pid "$s")" = "$OWNER" ] && { print_env "$s" "$(claim_ticket "$s")"; exit 0; }
    done
    echo "[qa-slot] this session holds no slot — run: qa-slot.sh claim <TICKET>" >&2
    exit 1
    ;;
  release)
    for f in "$DIR"/*.json; do
      [ -f "$f" ] || continue
      s=$(basename "$f" .json)
      [ "$(claim_pid "$s")" = "$OWNER" ] && { rm -f "$f"; echo "[qa-slot] released slot $s" >&2; }
    done
    ;;
  status)
    for s in $(seq 0 "$MAX"); do
      p=$(claim_pid "$s"); t=$(claim_ticket "$s")
      if [ -n "$p" ] && alive "$p"; then echo "slot $s: $t (pid $p)"
      elif [ -n "$p" ]; then echo "slot $s: stale claim by $t (pid $p dead)"
      elif [ "$s" -lt "$MIN" ]; then echo "slot $s: reserved for dev work$(db_lock_busy && echo ' (TANGO DB lock held)')"
      else echo "slot $s: free"; fi
    done
    ;;
  *) echo "usage: qa-slot.sh claim <TICKET> | env | release | status" >&2; exit 2 ;;
esac
