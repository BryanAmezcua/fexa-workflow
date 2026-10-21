#!/usr/bin/env bash
#
# Checks this machine's Fexa dev setup. Run any time; bin/setup.sh runs it last.
#   bin/doctor.sh
#
# The toolchain checks run in a CLEAN non-interactive shell (env -i + BASH_ENV), the
# way scripts, cron and editor tasks see the machine — not just your terminal.
# Prints PASS/FAIL per check; exits 1 if anything failed.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WORK_DIR="$(dirname "$ROOT")"
fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        fix: %s\n' "$1" "$2"; fails=$((fails + 1)); }

# Run a command the way a script would: clean env, only HOME/USER and BASH_ENV.
clean() { env -i HOME="$HOME" USER="${USER:-$(id -un)}" BASH_ENV="$HOME/.dev-env.sh" bash -c "$1" 2>/dev/null; }

echo "Shell wiring"
[ "$(readlink -f "$HOME/.dev-env.sh" 2>/dev/null)" = "$ROOT/config/dev-env.sh" ] \
  && pass "~/.dev-env.sh -> config/dev-env.sh" \
  || fail "~/.dev-env.sh is not a symlink to $ROOT/config/dev-env.sh" "run bin/setup.sh"
grep -q '\.dev-env\.sh' "$HOME/.bashrc" 2>/dev/null \
  && pass "~/.bashrc loads it" || fail "~/.bashrc does not load ~/.dev-env.sh" "run bin/setup.sh"
grep -q 'BASH_ENV=.*\.dev-env\.sh' "$HOME/.profile" 2>/dev/null \
  && pass "~/.profile exports BASH_ENV" || fail "~/.profile does not export BASH_ENV" "run bin/setup.sh"

echo "Toolchain (clean non-interactive shell)"
want_ruby="2.7.8"
[ -f "$WORK_DIR/Fexy-Zamo/.ruby-version" ] && want_ruby="$(tr -d '[:space:]' < "$WORK_DIR/Fexy-Zamo/.ruby-version")"
got="$(clean 'ruby -e "print RUBY_VERSION"')"
[ "$got" = "$want_ruby" ] && pass "ruby $got" \
  || fail "ruby ${got:-missing} (want $want_ruby)" "install rbenv, then: rbenv install $want_ruby && rbenv global $want_ruby"
clean 'command -v bundle' >/dev/null && pass "bundler" || fail "bundler missing" "gem install bundler (under rbenv ruby $want_ruby)"
got="$(clean 'node -v')"
case "$got" in v20.*) pass "node $got" ;; *) fail "node ${got:-missing} (want v20.x)" "install nvm, then: nvm install 20 && nvm alias default 20" ;; esac
got="$(clean 'sencha which' | grep -o 'v[0-9][0-9.]*' | head -1)"
case "$got" in v7.7.*) pass "sencha $got" ;; *) fail "sencha ${got:-missing} (want v7.7.x)" "install Sencha Cmd 7.7 under ~/bin/Sencha (see Fexy-Zamo README)" ;; esac
got="$(clean 'java -version 2>&1' | head -1 | grep -o '"[0-9][^"]*"')"
case "$got" in '"17'*) pass "java $got" ;; *) fail "java ${got:-missing} (want 17)" "sudo apt install -y openjdk-17-jdk" ;; esac
for t in psql redis-server git gh jq; do
  clean "command -v $t" >/dev/null && pass "$t" || fail "$t missing" "sudo apt install -y $t (gh: see README prereqs)"
done

echo "fexa-workflow config"
CFG="$HOME/.config/fexa-workflow"
[ -f "$CFG/config.env" ] && pass "config.env" || fail "no $CFG/config.env" "run bin/setup.sh, then edit it"
[ -s "$CFG/jira-token" ] && pass "jira-token present" || fail "$CFG/jira-token empty or missing" "paste a Jira API token (one line)"
for s in jira-tickets pwa-pr-review; do
  [ "$(readlink -f "$HOME/.claude/skills/$s" 2>/dev/null)" = "$ROOT/$s" ] \
    && pass "skill $s linked" || fail "skill $s not linked" "run bin/setup.sh"
done

echo "QA guard (keeps TANGO off the dev stack)"
grep -q 'tango-dev-guard' "$HOME/.claude/settings.json" 2>/dev/null \
  && pass "tango-dev-guard hook registered" || fail "tango-dev-guard hook not in ~/.claude/settings.json" "run bin/setup.sh"
echo '{"tool_input":{"command":"cd ~/work/TANGO && npm run seed:x"},"cwd":"/"}' | bash "$ROOT/qa-tools/hooks/tango-dev-guard.sh" 2>/dev/null
[ $? -eq 2 ] && pass "hook blocks an unguarded TANGO seed" || fail "hook did not block an unguarded TANGO seed" "check qa-tools/hooks/tango-dev-guard.sh (needs jq)"

echo "Repos"
for r in Fexy-Zamo fexa-pwa TANGO; do
  [ -d "$WORK_DIR/$r/.git" ] && pass "$r cloned" || fail "$WORK_DIR/$r missing" "run bin/setup.sh (after gh auth login)"
done
if [ -d "$WORK_DIR/TANGO/.git" ]; then
  b="$(git -C "$WORK_DIR/TANGO" branch --show-current)"
  [ "$b" = "main" ] && pass "TANGO on main" || fail "TANGO on '$b' (want main)" "git -C $WORK_DIR/TANGO checkout main && git -C $WORK_DIR/TANGO pull --rebase"
  [ -f "$WORK_DIR/TANGO/.env" ] && pass "TANGO .env" || fail "no TANGO .env" "cp .env.example .env in TANGO and fill the creds"
  cmp -s "$WORK_DIR/TANGO/CLAUDE.local.md" "$ROOT/qa-tools/tango-local/CLAUDE.local.md" \
    && pass "TANGO CLAUDE.local.md current" || fail "TANGO CLAUDE.local.md missing or stale" "run bin/setup.sh"
  git -C "$WORK_DIR/TANGO" check-ignore -q CLAUDE.local.md \
    && pass "TANGO CLAUDE.local.md git-excluded" || fail "TANGO CLAUDE.local.md not excluded" "run bin/setup.sh"
fi

echo
if [ "$fails" -eq 0 ]; then echo "doctor: all checks passed"; else echo "doctor: $fails check(s) failed"; exit 1; fi
