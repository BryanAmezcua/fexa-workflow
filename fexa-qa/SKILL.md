---
name: fexa-qa
description: Runs automated GUI QA for Fexa Jira tickets against either app — the Fexy-Zamo CMMS (Rails + Ext JS desktop) or the fexa-pwa mobile PWA (React/Vite) — by driving the team's TANGO Playwright harness (github.com/facilitiesexchange/TANGO, cloned locally) with a set of local overrides layered on top of TANGO's own qa-ticket pipeline. Given a ticket key it fetches the verbatim acceptance criteria, resolves which app and which mode (live vs mock) is under test, plans scenarios, writes seed + spec files into TANGO, runs them against local Rails, visually verifies every screenshot, critiques coverage, and produces TANGO's self-contained HTML report. Use when the user asks to QA, test, or verify a ticket — "qa TANGO-9", "QA TANGO-75 on the PWA", "verify TANGO-72". Works from any working directory. TANGO must be cloned (bin/setup.sh does it).
---

# fexa-qa — a wrapper over TANGO's `qa-ticket` pipeline

**The engine is TANGO**, the team's harness, cloned at `$TANGO_PATH` (from
`~/.config/fexa-workflow/config.env`, default `~/work/TANGO`). **The pipeline is
TANGO's own skill**, `$TANGO_PATH/.claude/skills/qa-ticket/SKILL.md`, which you read at
run time and follow step by step. This file does not restate that pipeline. It adds
only four things:

1. a **preflight** (TANGO present, right branch, synced, WSL environment),
2. **app + mode resolution** with a mandatory echo line,
3. a short list of **overrides** that win over `qa-ticket` wherever the two conflict,
4. a **coverage critique** step and a **no-auto-commit / no-auto-post** ending.

`<TICKET>` = full key (`TANGO-5`); `<PROJECT>` = prefix; `<N>` = number.
Flags: `--no-post` (default — never post to Jira), `--no-commit` (skip the commit proposal),
`--mock` / `--live` (force the PWA mode, see O3), `--target=cmms|pwa`.

## 0. Preflight — run before reading anything else

```bash
source ~/.config/fexa-workflow/config.env          # TANGO_PATH, TANGO_BRANCH, repo paths, tool dirs
test -f "$TANGO_PATH/package.json" \
  && test -f "$TANGO_PATH/.claude/skills/qa-ticket/SKILL.md" \
  || echo "TANGO is missing at $TANGO_PATH — run: bash $FEXA_WORKFLOW_REPO/bin/setup.sh"
cd "$TANGO_PATH" && git branch --show-current && git rev-parse --short origin/main
cat "$FEXA_WORKFLOW_REPO/fexa-qa/TANGO_KNOWN_GOOD"
```

- **Missing TANGO → stop** and tell the user to run `bin/setup.sh`. Nothing else works.
- **Branch.** All work happens on `$TANGO_BRANCH` (default `bryan/qa`), a personal
  branch on the org remote based on `main`. **Never commit on `main`, never push to
  `main`, never open a pull request.** If the clone is on `main`, `git checkout
  "$TANGO_BRANCH"`.
- **Sync** (global rule — teammates push between sessions):
  `git fetch origin && git rebase origin/main`. A rebase conflict is almost always one
  of TANGO's four append hotspots (`package.json` seed chain, `PERSONAS` in
  `src/support/qa-report.ts`, the projects list in `playwright.config.ts`, `.env`).
  Resolve by keeping both sides; if it is anything else, stop and show the user.
- **Drift check.** `TANGO_KNOWN_GOOD` holds the `origin/main` commit this wrapper was
  last validated against. If `origin/main` has moved past it, print one line —
  `TANGO main moved past the wrapper's known-good commit (<old>→<new>); override
  anchors below may need review` — and continue. Never block on it. After a run that
  went cleanly on the newer commit, offer to bump the file.
- **Now read TANGO's skill in full**: `$TANGO_PATH/.claude/skills/qa-ticket/SKILL.md`.
  Its relative links (`../../../tests/…`) resolve against `$TANGO_PATH`. Ignore its
  "Read `/Users/…/CLAUDE.md`" line — that path is the author's machine. Read
  `qa-ticket-multi` only when the user asks for several tickets at once.

## Environment (WSL — learned the hard way)

Non-interactive shells do not load the interactive PATH. Prepend tools explicitly in
**every** command block that touches Ruby, Sencha, or npm. Tool locations come from
`config.env`, never hardcoded here.

```bash
source ~/.config/fexa-workflow/config.env
export PATH="$SENCHA_CMD_DIR:$RBENV_ROOT/shims:$RBENV_ROOT/bin:$PATH"
eval "$(rbenv init - bash 2>/dev/null)"
export FEXY_ZAMO_PATH FEXA_PWA_PATH            # TANGO's seeds and webServer read these
. "$HOME/.nvm/nvm.sh" && nvm use 20 >/dev/null  # TANGO runs on node 20
cd "$TANGO_PATH"                                # qa-ticket assumes cwd = TANGO
```

TANGO's skill assumes the working directory is the TANGO checkout. Sessions here are
usually launched from `fexa-pwa` or `Fexy-Zamo`, so **always `cd "$TANGO_PATH"`** and
use absolute paths. Reports land at `$TANGO_PATH/reports/latest/<TICKET>.html`.

## Overrides — these win over `qa-ticket` on conflict

### O1. Ticket fetch — REST scripts, not the Atlassian MCP
`qa-ticket` step 1 expects the Atlassian MCP connector. This machine uses the
`jira-tickets` skill's scripts instead:
```bash
bash "$FEXA_WORKFLOW_REPO/jira-tickets/scripts/jira-fetch.sh" <TICKET>          # raw JSON
bash "$FEXA_WORKFLOW_REPO/jira-tickets/scripts/jira-attachments.sh" <TICKET>    # design mocks, when the AC is visual
```
Everything `qa-ticket` says about what to capture (verbatim AC by section, "Dev Context
— Grooming" comments, attachments as the visual oracle) still applies.

### O2. Resolve the app before anything runs — and echo it
`qa-ticket` infers the app from labels. Use these tiers instead; stop at the first hit:

1. **Explicit** — `pwa`/`mobile`/`fexa-pwa` or `cmms`/`desktop`/`fexy-zamo`/`ext` in the
   request, or `--target=`.
2. **Working directory** — session launched in `$FEXA_PWA_PATH` → `pwa`; in
   `$FEXY_ZAMO_PATH` → `cmms`.
3. **Linked PR** — `gh pr list --search <TICKET> --repo facilitiesexchange/fexa-pwa`, then
   the same for `Fexy-Zamo`. Exactly one hit is strong evidence. **Confirm with the user.**
4. **Ticket text** — parent epic ("Mobile: …"), labels (`mobile-fexaai`). Weak. **Confirm.**
5. **Ask.**

Never infer from the ticket key: TANGO numbers interleave both apps.

**Code under test.** The report pins the commit of whatever is checked out, so it must
be the ticket's code, not whatever the user happened to be working on:
- `pwa` → find the ticket's PR branch (tier 3 query) and check it out in `$FEXA_PWA_PATH`.
  Require a clean tree there; if it is dirty, tell the user and stop. If there is no
  PR, use `main` and say so.
- `cmms` → same idea with `$FEXY_ZAMO_PATH`, and remember fast mode serves a
  **prebuilt bundle**: if the ticket touched Fexy-Zamo frontend source, rebuild with
  `FORCE_REBUILD=1` (O6) or the run silently exercises old JS.

**Echo one line before running anything**, then proceed silently for tiers 1–2 and
require a yes for tiers 3–4:
```
Resolved: TANGO-75 · app=pwa · mode=live · code=fexa-pwa@TANGO-75-branch (a1b2c3d) · base=http://localhost:5173
```

### O3. PWA mode — live by default, mock by exception
`qa-ticket` defaults PWA tickets to `dev:mock` (MSW, no Rails). Here the default is the
opposite, because a mock run proves nothing about permission gates or real data shape:

| Mode | When | How TANGO runs it |
|---|---|---|
| **live** (default) | Anything that touches permissions, Rails-derived data, a `docs/parity/<screen>.md`, or desktop parity | `TANGO_INCLUDE_PWA_LIVE=1`, project `fexa-pwa-live`. Rails on `:3000` in fast mode; Playwright boots `npm run dev` in `$FEXA_PWA_PATH`. The spec logs in through the PWA's own Devise form — copy the `loginToPwa` pattern from `tests/work-order/mobile-notes-tab.spec.ts`. Seed is a `.rb` with `scope.app: 'fexa-pwa'`, so the report shows both application rows. |
| **mock** | Pure frontend behaviour with no server-derived state: offline/connectivity, camera/scanner, service worker, SSO redirect choreography | `TANGO_TARGET=fexa-pwa`, project `fexa-pwa`, `.mjs` seed — exactly as `qa-ticket` describes. |

Say which mode in the echo line. `--mock` / `--live` force it. When the AC genuinely
spans both (a mock-only UI behaviour plus a live round-trip), use TANGO's opt-in pairs
(`TANGO_INCLUDE_*_LIVE=1`) so both land in one report.

**Live preflight** — TANGO's `global-setup` does not check these, so do it yourself:
```bash
curl -s -o /dev/null -w "%{redirect_url}\n" --max-time 10 http://localhost:3000/      # must be /main/index
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:5173/mockServiceWorker.js
```
- `/main/development` → dev mode. Flip it with O6 (never with `npm run fexa:fast-mode`).
- Nothing on `:3000` → ask the user to start Fexy-Zamo (`overmind start -f Procfile.dev -D` in `$FEXY_ZAMO_PATH`).
- `mockServiceWorker.js` → `200` on `:5173` → something already runs `dev:mock` there.
  Playwright's `reuseExistingServer` would adopt it and the suite would pass against
  fabricated data. **Stop that server before a live run.** Mock mode is never a
  substitute for a live run.

### O4. Read exactly one target reference per run
- `pwa` → `reference/targets/pwa.md` (this folder). Selector policy, timing traps,
  mobile screenshot rules, known addressability gaps. TANGO has no equivalent doc.
- `cmms` → `qa-ticket` itself is the reference (its flake taxonomy and helper pointers
  are current); `reference/targets/cmms.md` adds only the WSL notes.

Reading both is how Ext selector idioms end up in a React spec.

### O5. Parity docs are an AC source (pwa)
`$FEXA_PWA_PATH/docs/parity/<screen>.md` enumerates every element's permission gate
with CONFIRMED/ASSUMED tags and `file:line` citations. In the planning step ask which
doc covers the screen, fold its universal gates into the scenario list, and hand it to
critique lens (d) in step 9.5. A gate is universal; only presentation differs mobile↔desktop.

### O6. Fast mode uses the wrapper's script
TANGO's `bin/fexa-fast-mode.sh` targets a Sencha app root that does not exist on the
`develop` checkout here. Use the copy in this folder:
```bash
bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/fexa-fast-mode.sh"       # ~2 min build + routes.rb patch, idempotent
cd "$FEXY_ZAMO_PATH" && overmind restart web                       # then wait for / → /main/index
# revert: bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/fexa-dev-mode.sh" && overmind restart web
```
**Never run fast mode for a mock PWA run** — it costs two minutes and buys nothing.

### O7. Seeds — the full chain once, per-ticket seeds after
TANGO's per-ticket seeds have ordering prerequisites (a seed aborts with the name of
the seed it needs). On a fresh clone or fresh DB run the whole chain once, in one Rails
boot: `npm run seed:all:fast`. After that, re-run only the ticket's own seed right
before its suite. Every persona password TANGO's `.env.example` prefills is set by a
seed, so login-failure PNGs in `auth/` mean the chain has not run yet.

### O8. Personas
Adopt `qa-ticket`'s rule unchanged: **no catch-all accounts** (`adminofall`,
`bigbrother`) unless the AC is about them. The `ADMIN_*` slot exists for discovery
only. Seed a purpose-built `tango_<group>@fexa.io` user and surface its group in the
report's `PERSONAS` entry. (The retired local engine ran everything as admin; do not
bring that habit back.)

### O9. Coverage critique — inserted after `qa-ticket`'s screenshot verification (9a), before its commit step
Spawn **parallel subagents**, distinct lenses, each given the verbatim AC + the spec path:
(a) **coverage completeness** — every AC clause has a real assertion, not just navigation;
(b) **edge/negative rigor** — absence assertions prove the region is empty; edges from
    AC + dev-context (server-side enforcement on save, etc.) are covered;
(c) **evidence validity** — each `focus`/assertion actually proves its AC per 9a;
(d) **permission parity** (pwa only) — against `docs/parity/<screen>.md`: universal
    gates asserted, or only the happy path?
Synthesize into a prioritized gap list. Fix high-value gaps, re-run, re-verify.

### O10. Ending — gate, propose, never auto-commit, never auto-post
`qa-ticket` step 10 commits on its own. Here:
1. `npm run qa:gate -- <TICKET>` must pass (matchers, catch-all auth, naming, seed
   idempotency, typecheck). Fix, don't suppress.
2. Report to the user: report path, **which app, mode and code commit** were tested,
   pass/fail with every red explained (desired-behaviour reds are the deliverable, not
   a problem), that screenshots were eyeballed (9a), and the critique gap list (O9).
3. **Propose** a Conventional-Commits message on `$TANGO_BRANCH`. Commit only after an
   explicit yes; `--no-commit` skips the proposal. On yes: commit, then
   `git push origin "$TANGO_BRANCH"`. The tracked report HTML + `summary.json` for the
   ticket are part of the commit (that is how the branch carries results between machines).
4. **Never post to Jira** unless explicitly asked. The comment format is in
   `reference/jira-comment.md` — read it only then.

## Hard rules (delta over `qa-ticket`'s own list, which also applies)

- **Preflight first; echo the resolved line before running anything.**
- **Never touch TANGO `main`.** No commits, no pushes, no PRs. Branch is `$TANGO_BRANCH`.
- **Never modify TANGO's engine files to fix an environment problem** — fix it in this
  wrapper (scripts/, reference/, config.env). TANGO stays a pristine, pullable clone.
- **PWA defaults to live.** Mock only for the exceptions in O3, and never when
  `/mockServiceWorker.js` is being served on the live port.
- **Read exactly one `reference/targets/*.md` per run.**
- **Fast mode via the wrapper's script only**; never for a mock run.
- **Verbatim AC, domain-language names, `focus` on positive snapshots, input values
  in `test.step()` labels** — as `qa-ticket` says.
- **Don't commit, push, or post without an explicit yes.**
