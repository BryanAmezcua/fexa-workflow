# fexa-workflow

Skills and tooling for Claude Code used across the Fexy-Zamo (Fexa CMMS) and
fexa-pwa repos. This repo is the single source of truth — skills are symlinked
into `~/.claude/skills/` so every Claude session on the machine discovers them
automatically, whichever repo it's launched from.

QA is not here. It is the team's harness,
[facilitiesexchange/TANGO](https://github.com/facilitiesexchange/TANGO), cloned as a
sibling repo and driven by its own `qa-ticket` skill. Work is committed straight to
TANGO `main`, following its maintainer's conventions. `qa-tools/` only holds local
helpers for running it on this WSL machine without touching the dev stack.

## Layout

```
jira-tickets/      Skill: list open-sprint tickets + render a ticket brief
  SKILL.md         Instructions (list + brief modes)
  reference/       ADF→markdown rules; parked spec-mode conventions
  scripts/         jira-*.sh REST helpers (config-driven, no secrets inside)
qa-tools/          NOT a skill: local helpers for running TANGO on this machine (see its README)
  hooks/           tango-dev-guard.sh — Claude hook that blocks TANGO runs on the dev stack
  tango-local/     CLAUDE.local.md copied into the TANGO clone (git-excluded, never committed)
  scripts/         qa-slot.sh (keeps QA off the dev stack), pwa-worktree.sh,
                   fexa-fast-mode.sh / fexa-dev-mode.sh (TANGO's copy fails on develop)
  notes/           PWA selector/timing notes, WSL notes, Jira QA-comment format
pwa-pr-review/     Skill: agent-committee PR review for fexa-pwa
  SKILL.md         The pipeline (scout → AC verify + lenses → refute → report → post)
  SPEC.md          Design rationale and the rules behind it
  reference/       The six lens prompts
  scripts/         pr-context.sh, diff-anchors.py, post-review.py (gh + jq)
config/dev-env.sh            Dev toolchain env (rbenv/nvm/Sencha/Android), linked as ~/.dev-env.sh
config/config.env.example    Template for ~/.config/fexa-workflow/config.env
config/claude-global-CLAUDE.md   Template for ~/.claude/CLAUDE.md (global rules)
config/claude-settings.json      Template for ~/.claude/settings.json (Claude Code prefs)
bin/setup.sh       One-shot machine setup (shell env + config scaffold + symlinks + repos + TANGO deps), re-runnable
bin/doctor.sh      Checks the setup in a clean shell; PASS/FAIL per tool, config, skill and repo
```

Sibling repos (`~/work/*`):

```
~/work/TANGO          QA engine. origin = facilitiesexchange/TANGO. Work is committed
                      straight to main (git pull --rebase before running and pushing).
~/work/Fexy-Zamo      app under test (cmms) — TANGO's seeds boot it with rails runner
~/work/fexa-pwa       app under test (pwa)  — tested on its `qa` branch (FEXA_PWA_BRANCH), in a worktree
```

Machine-specific files (never in this repo):

```
~/.config/fexa-workflow/config.env    JIRA_EMAIL, JIRA_HOST, repo paths, TANGO_PATH, tool dirs
~/.config/fexa-workflow/jira-token    Jira API token, one line, chmod 600
~/.claude/skills/{jira-tickets,pwa-pr-review}   symlinks into this repo
~/.dev-env.sh                         symlink to config/dev-env.sh (loaded by ~/.bashrc and BASH_ENV)
~/.claude/settings.json hooks         tango-dev-guard (setup.sh adds it if missing)
~/work/TANGO/CLAUDE.local.md          copy of qa-tools/tango-local/CLAUDE.local.md (excluded in .git/info/exclude)
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
nvm install 20 && nvm alias default 20

# 1. Install Claude Code (native installer, lands in ~/.local/bin)
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"   # setup.sh makes this permanent via ~/.dev-env.sh
claude --version   # log in on first launch

# 2. This repo — skills
mkdir -p ~/work
git clone https://github.com/BryanAmezcua/fexa-workflow.git ~/work/fexa-workflow
bash ~/work/fexa-workflow/bin/setup.sh
#    then fill in:
#    ~/.config/fexa-workflow/config.env   # JIRA_EMAIL / JIRA_HOST / repo paths / TANGO_PATH
#    ~/.config/fexa-workflow/jira-token   # paste token from id.atlassian.com/manage-profile/security/api-tokens
#    ~/work/TANGO/.env                    # admin / vendor / facility-manager / pricing-admin creds

# 3. Work repos — setup.sh cloned Fexy-Zamo, fexa-pwa and TANGO next to this repo.
#    If a clone failed (git not yet authenticated), authenticate and rerun:
bash ~/work/fexa-workflow/bin/setup.sh

# 4. Open a new terminal, then check everything — fix each FAIL and re-run until clean
bash ~/work/fexa-workflow/bin/doctor.sh
```

The toolchain itself (rbenv + the Ruby in Fexy-Zamo's `.ruby-version`, Java 17,
Sencha Cmd 7.7, Postgres/PostGIS, Redis, Elasticsearch) is installed per the Fexy-Zamo
README; `doctor.sh` names whatever is still missing and how to fix it.

Notes on the work repos:

- **Fexy-Zamo** (Rails 5.2 + Ext JS): follow its own README for the full app setup
  (Ruby via rbenv, Postgres/Redis/Elasticsearch, `bin/dev`). QA runs boot their own
  isolated Rails from a worktree — see `qa-tools/README.md`.
- **fexa-pwa** (React 19 / Vite / TS): `cd ~/work/fexa-pwa && npm install`.
  npm only — the preinstall hook enforces it. TANGO boots its dev server itself.
- **TANGO**: on `main`. Before a run and before pushing: `git pull --rebase`.

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
- QA: launch Claude in `~/work/TANGO` and use its `qa-ticket` skill, on an isolated
  slot (`qa-tools/README.md`) → `~/work/TANGO/reports/latest/TANGO-9.html`

## Environment notes (WSL)

- Everything runs in WSL on ext4 — `node_modules`, Playwright browsers, and Sencha
  builds are slow/flaky across the Windows↔WSL filesystem boundary.
- Tools are on PATH in every shell, interactive or not, via `~/.dev-env.sh`
  (`config/dev-env.sh`). Edit that file, not `~/.bashrc`; check with `bin/doctor.sh`.
- QA never runs on the dev stack (`:3000` / `fmdev` / `:5173`): load the slot env first
  (`qa-tools/README.md`). TANGO falls back to `../Fexy-Zamo` = `fmdev` otherwise.
- Fast mode is required for CMMS and live-PWA runs: use
  `qa-tools/scripts/fexa-fast-mode.sh` (TANGO's own copy targets a Sencha root that does
  not exist on `develop`); `fexa-dev-mode.sh` reverts. Restart Rails after either toggle.
- Node 20 for TANGO. Its standalone `npm run report:summary` wants Node 22, but the
  summary regenerates automatically at the end of every test run, so it is not needed.

## Conventions

- TANGO's `qa-ticket` rules apply in full (verbatim AC, domain-language names,
  exact-match assertions, desired-behaviour reds, no catch-all personas, `qa:gate`).
- Follow TANGO's existing patterns; propose engine changes to its maintainer rather
  than layering overrides here.
- Suites can be written against the AC before development; scenarios that cannot pass
  yet are marked with TANGO's `test.fail()` + annotation pattern (label: TODO, agree with
  TANGO's maintainer).
- Never commit `~/work/TANGO/.env`, `auth/`, or anything under `~/.config/fexa-workflow/`.
