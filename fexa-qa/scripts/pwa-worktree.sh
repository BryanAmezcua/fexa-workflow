#!/usr/bin/env bash
# Provision (or tear down) an isolated fexa-pwa worktree for ONE parallel fexa-qa
# instance. PWA tickets are tested on the integration branch (wrapper O2:
# $FEXA_PWA_BRANCH from config.env, default `qa` — NOT main, which is production
# and lags), so the worktree is a detached checkout of origin/$FEXA_PWA_BRANCH by
# default; the user's own checkout and dev server are never touched. The main
# tree's node_modules is symlinked in (a fresh worktree has none).
#
# Usage:
#   pwa-worktree.sh create <TICKET> [ref]   # default origin/$FEXA_PWA_BRANCH (detached); ref only for a deliberate exception
#   pwa-worktree.sh remove <TICKET>
#
# `create` prints `export FEXA_PWA_PATH=<worktree>`; eval it in the instance's
# shell before running the pipeline (config.env keeps a pre-exported value).
set -euo pipefail

CMD=${1:?usage: create|remove <TICKET> [ref]}
TICKET=${2:?ticket key required}
REF=${3:-}
LC_TICKET=$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]')

source ~/.config/fexa-workflow/config.env
MAIN="${FEXA_PWA_MAIN:-$HOME/work/fexa-pwa}"   # the user's checkout; only used as the repo to fork worktrees from
BRANCH="${FEXA_PWA_BRANCH:-qa}"                 # integration branch = code under test (O2)
[ -d "$MAIN/.git" ] || { echo "[pwa-worktree] fexa-pwa checkout not found at $MAIN (set FEXA_PWA_MAIN)" >&2; exit 1; }
WT="$MAIN/.claude/worktrees/qa-$LC_TICKET"

case "$CMD" in
  create)
    git -C "$MAIN" fetch origin --quiet
    if [ -d "$WT" ]; then
      echo "[pwa-worktree] reusing existing $WT" >&2
    elif [ -z "$REF" ]; then
      git -C "$MAIN" worktree add --detach "$WT" "origin/$BRANCH" >&2
    else
      # Deliberate exception to "test $BRANCH": check a named ref out.
      git -C "$MAIN" worktree add "$WT" "$REF" >&2
    fi
    [ -e "$MAIN/node_modules" ] && ln -sfn "$MAIN/node_modules" "$WT/node_modules"
    # The symlink is not matched by a `node_modules/` (trailing-slash) ignore
    # rule; exclude it locally so a stray `git add -A` never tracks it.
    EXCL="$(git -C "$WT" rev-parse --git-path info/exclude)"
    grep -qxF '/node_modules' "$EXCL" 2>/dev/null || printf '/node_modules\n' >> "$EXCL"
    echo "WORKTREE=$WT"
    echo "COMMIT=$(git -C "$WT" rev-parse --short HEAD) ($(git -C "$WT" rev-parse --abbrev-ref HEAD))"
    echo "export FEXA_PWA_PATH=$WT"
    ;;
  remove)
    git -C "$MAIN" worktree remove --force "$WT" 2>/dev/null || true
    git -C "$MAIN" worktree prune
    echo "[pwa-worktree] removed $WT" >&2
    ;;
  *)
    echo "unknown command: $CMD (create|remove)" >&2; exit 2 ;;
esac
