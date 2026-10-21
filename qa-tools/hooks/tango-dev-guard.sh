#!/usr/bin/env bash
#
# Claude Code PreToolUse hook (Bash): TANGO runs never touch the dev stack.
#
# Registered in ~/.claude/settings.json (user level, so it guards EVERY Claude session,
# whichever repo it was launched from — bin/setup.sh installs it). Reads the hook JSON on
# stdin; exit 2 blocks the command and the message on stderr goes back to Claude.
#
# A Bash command that runs TANGO (seeds, playwright, qa:gate, cmms:ensure, a seed via
# rails runner) is allowed only when the command itself:
#   - loads the slot env  (qa-slot.sh env|claim -> ports of slot >= 1), and
#   - for anything that touches a database, exports DATABASE_URL (the cloned DB) —
#     without it TANGO falls back to ../Fexy-Zamo = fmdev.
# Deployed runs (TANGO_ENV=…) never touch the local stack and are allowed.
# Each Bash call is a fresh shell, so the env must be loaded in the same command.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# Ignore text that is data, not commands: heredoc bodies (file contents, scripts piped
# to an interpreter) and git commit messages. Otherwise writing docs ABOUT TANGO trips it.
cmd="$(printf '%s\n' "$cmd" | awk '
  eof != "" { t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t); if (t == eof) eof = ""; next }
  { print }
  match($0, /<<-?[ \t]*["'\'']?[A-Za-z_][A-Za-z0-9_]*/) {
    w = substr($0, RSTART, RLENGTH); gsub(/^<<-?[ \t]*["'\'']?/, "", w); eof = w
  }' | perl -0pe 's/ -m\s*"(?:[^"\\]|\\.)*"//gs; s/ -m\s*'\''[^'\'']*'\''//gs')"

# Only commands in a TANGO context (run from TANGO / a TANGO worktree, or naming it).
case "$cwd" in */TANGO|*/TANGO/*) ;; *) printf '%s' "$cmd" | grep -q 'TANGO' || exit 0 ;; esac

runs_tango='npm run( -s)? (seed:|test(:|[[:space:]]|$)|qa:gate|verify:seeds|cmms:ensure)|playwright test|rails runner[^|;&]*seeds/'
# `qa:gate … --no-seeds` is static checks + typecheck only (no app, no DB): not a run.
scan="$(printf '%s' "$cmd" | sed -E 's/qa:gate[^|;&]*--no-seeds//g')"
printf '%s' "$scan" | grep -Eq "$runs_tango" || exit 0

# Deployed-environment runs (qatesting etc.) don't use local Rails or a local DB.
printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])TANGO_ENV=' && exit 0

block() {
  printf '%s\n' "BLOCKED by tango-dev-guard: $1" \
    "TANGO runs never touch the dev stack (Rails :3000, DB fmdev, PWA :5173)." \
    "In the SAME command: eval \"\$(bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh env)\" (claim first)," \
    "and for seeds / qa:gate / cmms:ensure / rails runner also export DATABASE_URL for the slot's cloned DB." \
    "Recipe: ~/work/fexa-workflow/qa-tools/README.md" >&2
  exit 2
}

printf '%s' "$cmd" | grep -Eq 'localhost:3000([^0-9]|$)|:5173([^0-9]|$)|fmdev' \
  && block "the command names the dev stack (localhost:3000 / :5173 / fmdev)."

printf '%s' "$cmd" | grep -Eq 'qa-slot\.sh"? (env|claim)' \
  || block "the slot env is not loaded in this command."

needs_db='npm run( -s)? (seed:|verify:seeds|cmms:ensure)|rails runner|qa:gate'
if printf '%s' "$cmd" | grep -Eq "$needs_db" \
   && ! printf '%s' "$cmd" | grep -Eq 'qa:gate[^|;&]*--no-seeds' \
   && ! printf '%s' "$cmd" | grep -Eq 'DATABASE_URL='; then
  block "this command touches a database but does not export DATABASE_URL (it would default to fmdev)."
fi
exit 0
