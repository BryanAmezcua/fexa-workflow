#!/usr/bin/env bash
#
# One-shot machine setup for fexa-workflow. Run from anywhere, inside WSL:
#   bin/setup.sh
#
# Does five things:
#   1. Scaffolds ~/.config/fexa-workflow/ (config.env + jira-token placeholder)
#   2. Installs Claude global rules + settings (~/.claude/) if the machine has none
#   3. Symlinks the skills into ~/.claude/skills/ so Claude auto-discovers them
#   4. Clones the work repos (Fexy-Zamo, fexa-pwa) as siblings of this repo
#   5. Clones the TANGO QA engine as a sibling, checks out the personal branch,
#      installs its Node deps + Playwright chromium, scaffolds TANGO/.env
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "[setup] repo: $ROOT"

case "$ROOT" in
  /mnt/*) echo "[setup] WARNING: $ROOT is on the Windows mount. Clone into WSL home (~/work) — node_modules/Playwright/Sencha are slow across /mnt/c." ;;
esac

# 1. Per-machine config (never in git)
CFG_DIR="$HOME/.config/fexa-workflow"
mkdir -p "$CFG_DIR"
if [ ! -f "$CFG_DIR/config.env" ]; then
  cp "$ROOT/config/config.env.example" "$CFG_DIR/config.env"
  echo "[setup] created $CFG_DIR/config.env — EDIT IT (email, host, paths)"
else
  echo "[setup] $CFG_DIR/config.env already exists — leaving it alone"
fi
if [ ! -f "$CFG_DIR/jira-token" ]; then
  touch "$CFG_DIR/jira-token"
  chmod 600 "$CFG_DIR/jira-token"
  echo "[setup] created empty $CFG_DIR/jira-token — paste your Jira API token into it (one line)"
  echo "        generate at: https://id.atlassian.com/manage-profile/security/api-tokens"
else
  chmod 600 "$CFG_DIR/jira-token"
  echo "[setup] $CFG_DIR/jira-token already exists — leaving it alone"
fi

# 2. Global Claude rules — install if this machine doesn't have them yet
if [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  mkdir -p "$HOME/.claude"
  cp "$ROOT/config/claude-global-CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  echo "[setup] installed global rules to ~/.claude/CLAUDE.md"
else
  echo "[setup] ~/.claude/CLAUDE.md already exists — leaving it alone"
fi
if [ ! -f "$HOME/.claude/settings.json" ]; then
  mkdir -p "$HOME/.claude"
  cp "$ROOT/config/claude-settings.json" "$HOME/.claude/settings.json"
  echo "[setup] installed Claude Code settings to ~/.claude/settings.json"
else
  echo "[setup] ~/.claude/settings.json already exists — leaving it alone (compare with config/claude-settings.json)"
fi

# 3. Skill symlinks — repo stays the single source of truth; git pull updates them
SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"
for skill in jira-tickets fexa-qa pwa-pr-review; do
  link="$SKILLS_DIR/$skill"
  if [ -L "$link" ]; then
    ln -sfn "$ROOT/$skill" "$link"
    echo "[setup] refreshed symlink $link -> $ROOT/$skill"
  elif [ -e "$link" ]; then
    echo "[setup] WARNING: $link exists and is not a symlink — resolve manually" >&2
  else
    ln -s "$ROOT/$skill" "$link"
    echo "[setup] linked $link -> $ROOT/$skill"
  fi
done

# 4. Work repos — cloned as siblings of this repo (~/work/*). Private repos:
#    git must be authenticated (gh auth login configures the credential helper).
WORK_DIR="$(dirname "$ROOT")"
for repo in facilitiesexchange/Fexy-Zamo facilitiesexchange/fexa-pwa; do
  name="${repo##*/}"
  dest="$WORK_DIR/$name"
  if [ -d "$dest" ]; then
    echo "[setup] $dest already exists — leaving it alone"
  else
    echo "[setup] cloning $repo -> $dest"
    git clone "https://github.com/$repo.git" "$dest" \
      || echo "[setup] WARNING: clone of $repo failed — authenticate first (gh auth login, then gh auth setup-git) and clone manually" >&2
  fi
done

# 5. TANGO — the QA engine the fexa-qa skill drives. Cloned pristine as a sibling;
#    all ticket work goes on a personal branch (TANGO_BRANCH) based on origin/main.
#    main is never edited here.
if ! command -v node >/dev/null 2>&1; then
  echo "[setup] ERROR: node not on PATH. Install Node 20 in WSL (nvm install 20)." >&2; exit 1
fi
# shellcheck disable=SC1090
source "$CFG_DIR/config.env"
TANGO_PATH="${TANGO_PATH:-$WORK_DIR/TANGO}"
TANGO_BRANCH="${TANGO_BRANCH:-bryan/qa}"
if [ -d "$TANGO_PATH/.git" ]; then
  echo "[setup] TANGO already at $TANGO_PATH — fetching"
  git -C "$TANGO_PATH" fetch origin --quiet || echo "[setup] WARNING: fetch failed — authenticate (gh auth login) and rerun" >&2
else
  echo "[setup] cloning facilitiesexchange/TANGO -> $TANGO_PATH"
  git clone "https://github.com/facilitiesexchange/TANGO.git" "$TANGO_PATH" \
    || { echo "[setup] ERROR: TANGO clone failed — authenticate first (gh auth login, then gh auth setup-git) and rerun" >&2; exit 1; }
fi
if git -C "$TANGO_PATH" show-ref --verify --quiet "refs/remotes/origin/$TANGO_BRANCH"; then
  git -C "$TANGO_PATH" checkout --quiet "$TANGO_BRANCH" 2>/dev/null \
    || git -C "$TANGO_PATH" checkout --quiet -b "$TANGO_BRANCH" --track "origin/$TANGO_BRANCH"
  echo "[setup] TANGO on $TANGO_BRANCH (tracking origin/$TANGO_BRANCH)"
else
  git -C "$TANGO_PATH" checkout --quiet -b "$TANGO_BRANCH" origin/main
  echo "[setup] created $TANGO_BRANCH from origin/main — push it when ready: git -C $TANGO_PATH push -u origin $TANGO_BRANCH"
fi
cd "$TANGO_PATH"
echo "[setup] installing TANGO deps (npm install)..."
npm install
echo "[setup] installing Playwright chromium (+ system libs; may prompt for sudo)..."
npx playwright install --with-deps chromium
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[setup] created $TANGO_PATH/.env from .env.example — fill ADMIN/VENDOR/FACILITY_MANAGER/PRICING_ADMIN creds"
fi
cd "$ROOT"

# Leftovers from the retired local engine (gitignored, so git pull does not remove them)
if [ -d "$ROOT/qa" ]; then
  echo "[setup] NOTE: $ROOT/qa is left over from the retired local QA engine (node_modules/.env/auth/reports)."
  echo "        The engine now lives in TANGO. Remove it with:  rm -rf $ROOT/qa"
fi

cat <<'EOF'

[setup] Done. Remaining manual steps:
  1) edit ~/.config/fexa-workflow/config.env    # JIRA_EMAIL / JIRA_HOST / repo paths
  2) paste Jira token into ~/.config/fexa-workflow/jira-token
  3) edit $TANGO_PATH/.env                     # admin/vendor/facility-manager/pricing-admin creds (the rest are seeded)
  4) app setup: Fexy-Zamo per its own README (rbenv/Postgres/bin/dev);
     fexa-pwa: cd ../fexa-pwa && nvm use 20 && npm install
  5) (fexa-qa only) fast mode: bash fexa-qa/scripts/fexa-fast-mode.sh, then overmind restart web;
     then seed everything once: cd $TANGO_PATH && npm run seed:all:fast

Sanity check: bash jira-tickets/scripts/jira-list.sh   -> your sprint table
EOF
