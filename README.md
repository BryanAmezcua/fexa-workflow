# fexa-workflow

Skills and tooling for Claude Code used across the Fexy-Zamo (Fexa CMMS) and
fexa-pwa repos. This repo is the single source of truth — skills are symlinked
into `~/.claude/skills/` so every Claude session on the machine discovers them
automatically, whichever repo it's launched from.

The QA **engine** is not here. It is the team's harness,
[facilitiesexchange/TANGO](https://github.com/facilitiesexchange/TANGO), cloned as a
sibling repo. The `fexa-qa` skill here is a wrapper that drives TANGO's own
`qa-ticket` pipeline with a few local overrides. **TANGO is a hard requirement for
`fexa-qa`** — `bin/setup.sh` clones it.

## Layout

```
jira-tickets/      Skill: list open-sprint tickets + render a ticket brief
  SKILL.md         Instructions (list + brief modes)
  reference/       ADF→markdown rules; parked spec-mode conventions
  scripts/         jira-*.sh REST helpers (config-driven, no secrets inside)
fexa-qa/           Skill: ticket-scoped GUI QA — a wrapper over TANGO's qa-ticket skill
  SKILL.md         Preflight, WSL env, app/mode resolution, overrides, critique, ending
  TANGO_KNOWN_GOOD The TANGO main commit the wrapper was last validated against
  scripts/         fexa-fast-mode.sh / fexa-dev-mode.sh (this checkout's Sencha layout)
  reference/       targets/pwa.md (PWA selectors, timing, screenshots), targets/cmms.md
                   (WSL notes), pwa-repo-prerequisites.md, jira-comment.md
pwa-pr-review/     Skill: agent-committee PR review for fexa-pwa
  SKILL.md         The pipeline (scout → AC verify + lenses → refute → report → post)
  SPEC.md          Design rationale and the rules behind it
  reference/       The six lens prompts
  scripts/         pr-context.sh, diff-anchors.py, post-review.py (gh + jq)
config/config.env.example    Template for ~/.config/fexa-workflow/config.env
config/claude-global-CLAUDE.md   Template for ~/.claude/CLAUDE.md (global rules)
config/claude-settings.json      Template for ~/.claude/settings.json (Claude Code prefs)
bin/setup.sh       One-shot machine setup (config scaffold + symlinks + repos + TANGO deps)
```

Sibling repos (`~/work/*`), all required by `fexa-qa`:

```
~/work/TANGO          QA engine. origin = facilitiesexchange/TANGO. main is pull-only;
                      ticket work lives on the personal branch in TANGO_BRANCH (bryan/qa),
                      based on origin/main and pushed to the org remote. Never a PR.
~/work/Fexy-Zamo      app under test (cmms) — TANGO's seeds boot it with rails runner
~/work/fexa-pwa       app under test (pwa)  — tested on its `qa` branch (FEXA_PWA_BRANCH), in a worktree
```

Machine-specific files (never in this repo):

```
~/.config/fexa-workflow/config.env    JIRA_EMAIL, JIRA_HOST, repo paths, TANGO_PATH/BRANCH, tool dirs
~/.config/fexa-workflow/jira-token    Jira API token, one line, chmod 600
~/.claude/skills/{jira-tickets,fexa-qa,pwa-pr-review}   symlinks into this repo
~/.cache/fexa-workflow/reviews/       PR review work dirs (diff, anchors, findings)
~/work/TANGO/.env, ~/work/TANGO/auth/ test-account creds + session state (gitignored there)
```

## New machine setup

Everything happens **inside WSL** (Ubuntu). Repos must live on ext4 (`~/work`),
never under `/mnt/c` — node_modules/Playwright/Sencha are slow and flaky across
the Windows↔WSL boundary.

```bash
# 0. Prereqs (once per machine)
sudo apt update && sudo apt install -y jq git curl gh
gh auth login && gh auth setup-git   # private org repos (TANGO, Fexy-Zamo, fexa-pwa)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell, then:
nvm install 20

# 1. Install Claude Code (native installer, lands in ~/.local/bin)
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude --version   # log in on first launch

# 2. This repo — skills
mkdir -p ~/work
git clone https://github.com/BryanAmezcua/fexa-workflow.git ~/work/fexa-workflow
bash ~/work/fexa-workflow/bin/setup.sh
#    then fill in:
#    ~/.config/fexa-workflow/config.env   # JIRA_EMAIL / JIRA_HOST / repo paths / TANGO_PATH / tool dirs
#    ~/.config/fexa-workflow/jira-token   # paste token from id.atlassian.com/manage-profile/security/api-tokens
#    ~/work/TANGO/.env                    # admin / vendor / facility-manager / pricing-admin creds

# 3. Work repos — setup.sh cloned Fexy-Zamo, fexa-pwa and TANGO next to this repo.
#    If a clone failed (git not yet authenticated), authenticate and rerun:
bash ~/work/fexa-workflow/bin/setup.sh

# 4. Seed TANGO's personas + fixtures once (Rails must be up in fast mode — see below)
cd ~/work/TANGO && npm run seed:all:fast
```

Notes on the work repos:

- **Fexy-Zamo** (Rails 5.2 + Ext JS): follow its own README for the full app setup
  (Ruby via rbenv, Postgres/Redis/Elasticsearch, `bin/dev`). `fexa-qa` needs it running
  on `localhost:3000` in fast mode: `bash fexa-qa/scripts/fexa-fast-mode.sh` then
  `overmind restart web`. Sencha Cmd of the pinned version must be at `$SENCHA_CMD_DIR`.
- **fexa-pwa** (React 19 / Vite / TS): `cd ~/work/fexa-pwa && nvm use 20 && npm install`.
  npm only — the preinstall hook enforces it. TANGO boots its dev server itself.
- **TANGO**: `setup.sh` leaves it on `$TANGO_BRANCH`. To sync with the team:
  `git fetch origin && git rebase origin/main` (the skill does this in preflight).

`setup.sh` installs `config/claude-settings.json` to `~/.claude/settings.json`
on machines that don't have one — bypass-permissions mode, model pin, fullscreen
TUI, dark theme. On a machine that already has settings it leaves them alone;
diff against the template if the experience feels different across machines.

**Update on any machine:** `git -C ~/work/fexa-workflow pull` — symlinked skills
pick up changes immediately. Re-run `bin/setup.sh` if new skills or repos were added.
If `~/work/fexa-workflow/qa/` still exists from the retired local engine, delete it.

## Daily use

```bash
wsl ~                       # or open Windows Terminal straight into WSL home
cd ~/work/fexa-pwa          # or ~/work/Fexy-Zamo
claude
```

The repo's CLAUDE.md + global rules + the skills load automatically — the first
message is just the task:

- "what's in my sprint" / `/jira-tickets` → sprint table
- "brief TANGO-9" → full ticket rendering
- "qa TANGO-9" / "QA TANGO-75 on the PWA" → the TANGO pipeline with local overrides →
  `~/work/TANGO/reports/latest/TANGO-9.html`, commit proposed on `bryan/qa`

## Environment notes (WSL)

- Everything runs in WSL on ext4 — `node_modules`, Playwright browsers, and Sencha
  builds are slow/flaky across the Windows↔WSL filesystem boundary.
- TANGO drives the app on `http://localhost:3000` and runs seeds via
  `bundle exec rails runner`, so rbenv Ruby must be on PATH (the fexa-qa SKILL.md
  has the exact exports for non-interactive shells, driven by config.env).
- Fast mode is required for CMMS and live-PWA runs: TANGO's `global-setup` refuses
  dev mode. Use `fexa-qa/scripts/fexa-fast-mode.sh` (TANGO's own copy targets a
  Sencha root that does not exist on `develop`); `fexa-dev-mode.sh` reverts. Restart
  Rails after either toggle.
- Node 20 for TANGO. Its standalone `npm run report:summary` wants Node 22, but the
  summary regenerates automatically at the end of every test run, so it is not needed.

## Conventions

- TANGO's `qa-ticket` rules apply in full (verbatim AC, domain-language names,
  exact-match assertions, desired-behaviour reds, no catch-all personas, `qa:gate`).
- The wrapper's overrides live in `fexa-qa/SKILL.md` and win on conflict: live-by-default
  for PWA tickets, one target reference per run, parity docs as an AC source, coverage
  critique, no auto-commit / no auto-post.
- Never modify TANGO's engine files to fix an environment problem — fix it in this repo.
- Never commit to TANGO `main`; never open a PR from `bryan/qa`.
- Never commit `~/work/TANGO/.env`, `auth/`, or anything under `~/.config/fexa-workflow/`.
