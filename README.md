# fexa-workflow

Skills and tooling for Claude Code used across the Fexy-Zamo (Fexa CMMS) and
fexa-pwa repos. This repo is the single source of truth — skills are symlinked
into `~/.claude/skills/` so every Claude session on the machine discovers them
automatically, whichever repo it's launched from.

## Layout

```
jira-tickets/      Skill: list open-sprint tickets + render a ticket brief
  SKILL.md         Instructions (list + brief modes)
  reference/       ADF→markdown rules; parked spec-mode conventions
  scripts/         jira-*.sh REST helpers (config-driven, no secrets inside)
fexa-qa/           Skill: ticket-scoped GUI QA pipeline for Fexy-Zamo
  SKILL.md         The pipeline (fetch AC → seed → spec → run → verify → critique)
qa/                The QA engine (native Playwright Test)
  playwright.config.ts   Projects (admin/vendor/facility-manager) + reporters
  tests/<area>/*.spec.ts One spec file per ticket; tests/_explore = throwaway
  src/support/qa-report.ts   Verbatim AC constants + annotateAc/captureAcSnapshot
  src/reporters/qa-report.ts Custom reporter → reports/latest/<TICKET>.html
  seeds/*.rb       Idempotent rails-runner fixtures
  bin/fexa-{fast,dev}-mode.sh  Toggle Fexy-Zamo fast vs dev mode
config/config.env.example    Template for ~/.config/fexa-workflow/config.env
bin/setup.sh       One-shot machine setup (config scaffold + symlinks + qa deps)
```

Machine-specific files (never in this repo):

```
~/.config/fexa-workflow/config.env    JIRA_EMAIL, JIRA_HOST, repo paths
~/.config/fexa-workflow/jira-token    Jira API token, one line, chmod 600
~/.claude/skills/{jira-tickets,fexa-qa}   symlinks into this repo
qa/.env, qa/auth/                     test-account creds + session state (gitignored)
```

## New machine setup

Everything happens **inside WSL** (Ubuntu). Repos must live on ext4 (`~/work`),
never under `/mnt/c` — node_modules/Playwright/Sencha are slow and flaky across
the Windows↔WSL boundary.

```bash
# 0. Prereqs (once per machine)
sudo apt update && sudo apt install -y jq git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell, then:
nvm install 20

# 1. Install Claude Code (native installer, lands in ~/.local/bin)
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude --version   # log in on first launch

# 2. This repo — skills + QA engine
mkdir -p ~/work
git clone https://github.com/BryanAmezcua/fexa-workflow.git ~/work/fexa-workflow
bash ~/work/fexa-workflow/bin/setup.sh
#    then fill in:
#    ~/.config/fexa-workflow/config.env   # JIRA_EMAIL / JIRA_HOST / repo paths
#    ~/.config/fexa-workflow/jira-token   # paste token from id.atlassian.com/manage-profile/security/api-tokens
#    qa/.env                              # test-account creds (fexa-qa machines only)

# 3. Work repos (clone whichever this machine needs)
git clone https://github.com/facilitiesexchange/Fexy-Zamo.git ~/work/Fexy-Zamo
git clone https://github.com/facilitiesexchange/fexa-pwa.git  ~/work/fexa-pwa
```

Notes on the work repos:

- **Fexy-Zamo** (Rails 5.2 + Ext JS): follow its own README for the full app setup
  (Ruby via rbenv, Postgres/Redis/Elasticsearch, `bin/dev`). The fexa-qa skill needs
  it running on `localhost:3000`. Sencha Cmd 7.7.0.36 must be at `~/bin/Sencha/Cmd`
  for fast-mode builds.
- **fexa-pwa** (React 19 / Vite / TS): `cd ~/work/fexa-pwa && nvm use 20 && npm install`.
  npm only — the preinstall hook enforces it.

Optional: start every Claude session in bypass-permissions mode by adding to
`~/.claude/settings.json`:

```json
{ "permissions": { "defaultMode": "bypassPermissions" } }
```

**Update on any machine:** `git -C ~/work/fexa-workflow pull` — symlinked skills
pick up changes immediately. Re-run `bin/setup.sh` only if new skills were added.

## Daily use

```bash
wsl ~                       # or open Windows Terminal straight into WSL home
cd ~/work/fexa-pwa          # or ~/work/Fexy-Zamo
claude
```

The repo's CLAUDE.md + global rules + both skills load automatically — the first
message is just the task:

- "what's in my sprint" / `/jira-tickets` → sprint table
- "brief TANGO-9" → full ticket rendering
- "qa TANGO-9" (from Fexy-Zamo work) → the full QA pipeline →
  `qa/reports/latest/TANGO-9.html`

## Environment notes (WSL)

- Everything runs in WSL on ext4 — `node_modules`, Playwright browsers, and Sencha
  builds are slow/flaky across the Windows↔WSL filesystem boundary.
- The QA engine drives the app on `http://localhost:3000` and runs seeds via
  `bundle exec rails runner`, so rbenv Ruby must be on PATH (the fexa-qa SKILL.md
  has the exact exports for non-interactive shells).
- Fast mode is required for QA runs: dev-mode Sencha boots too slowly and tests
  time out. `qa/bin/fexa-fast-mode.sh` flips it; `fexa-dev-mode.sh` reverts. The
  Rails app must be restarted after either toggle.

## Conventions

- Verbatim AC text in `qa/src/support/qa-report.ts` — never paraphrase.
- Domain-language file/test names (`enforced-rate`, not `TANGO-5`).
- `test.step()` labels include input values so a human can reproduce by hand.
- Every positive-assertion `captureAcSnapshot` passes a `focus` locator.
- Branch = `<TICKET-KEY>` off `develop`; PRs target `develop`.
- Never commit `qa/.env`, `qa/auth/`, `qa/reports/`, or anything under
  `~/.config/fexa-workflow/`.
