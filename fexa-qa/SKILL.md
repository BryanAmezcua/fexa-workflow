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
eval "$(bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" claim <TICKET>)"   # auto slot — see below
```

- **Missing TANGO → stop** and tell the user to run `bin/setup.sh`. Nothing else works.
- **Slot.** `qa-slot.sh claim` hands out the lowest free slot **starting at 1**.
  **Slot 0 (`:3000`, `fmdev`, `:5173`, the main checkouts) is reserved for the user's
  dev work and QA never runs there, even when it is idle.** Every QA run is therefore
  an isolated stack: **follow O11 with the claimed slot** — the claim already exported
  `CMMS_PORT`, `REDIS_PORT`, `TEST_BASE_URL`, `FEXA_PWA_PORT`, `TANGO_LOCK_LABEL`.
  Never override the slot by hand; a second instance gets the next slot without being
  told it is "the second one". Exit 75 = every slot busy — tell the user and stop.
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
eval "$(bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" env)"   # slot ports (always slot ≥ 1)
cd "$TANGO_PATH"                                # qa-ticket assumes cwd = TANGO
```

The O11 worktree paths must also be re-exported in every shell
(`TANGO_PATH`, `FEXA_PWA_PATH`, `FEXY_ZAMO_PATH`, `DATABASE_URL`) — O11 shows the block.

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
- `pwa` → **always the integration branch `$FEXA_PWA_BRANCH` (config.env, `qa`), never
  a PR branch and never `main`.** fexa-pwa runs a two-branch model: PRs merge into `qa`
  (deploys to qatesting.fexa.io) and `qa` is promoted to `main` (production) by PR
  later — so `main` lags and is not the code under test. The O11 PWA worktree checks
  out `origin/$FEXA_PWA_BRANCH` detached; the user's own checkout is never touched.
  If the tier-3 query (`gh pr list --search <TICKET> --base "$FEXA_PWA_BRANCH" …`)
  shows the ticket's PR still **open**, say so and stop — `qa` does not contain the
  change yet, so a run would test the wrong code.
- `cmms` → unchanged: the ticket's PR branch in `$FEXY_ZAMO_PATH` if one exists, else
  `develop`, and remember fast mode serves a
  **prebuilt bundle**: if the ticket touched Fexy-Zamo frontend source, rebuild with
  `FORCE_REBUILD=1` (O6) or the run silently exercises old JS.

**Echo one line before running anything**, then proceed silently for tiers 1–2 and
require a yes for tiers 3–4:
```
Resolved: TANGO-75 · app=pwa · mode=live · slot=1 · code=fexa-pwa@qa (a1b2c3d) · base=http://localhost:5183
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

**Live preflight** — TANGO's `global-setup` does not check these, so do it yourself
(against the slot's ports from `qa-slot.sh env`, never `:3000`/`:5173` — those are dev):
```bash
curl -s -o /dev/null -w "%{redirect_url}\n" --max-time 10 "$TEST_BASE_URL/"           # must be /main/index
# Is something already on the PWA port, and is it in mock mode? The mock worker
# file (public/mockServiceWorker.js) is a static asset every dev server serves,
# so its status code proves NOTHING. Vite inlines the flag into the entry module:
curl -s --max-time 3 "http://localhost:$FEXA_PWA_PORT/src/main.tsx" | grep -c 'VITE_USE_MOCKS: *"true"'   # 1 = mock mode
```
- `/main/development` → dev mode. Flip it with O6 (never with `npm run fexa:fast-mode`).
- Nothing on `$CMMS_PORT` → the O11 step 4 `npm run cmms:ensure` has not run yet; run it. Never ask the user to start their own Fexy-Zamo for QA.
- A server already on the PWA port: Playwright's `reuseExistingServer` adopts whatever
  is there — a plain `npm run dev` would be adopted as the *mock* server (and a
  `dev:mock` as the *live* one), so a paired run would prove the wrong thing. Do not
  ask the user to stop their dev server; **move the run instead**:
  `FEXA_PWA_PORT=5163` (mock on 5163, the live pair on 5165). **Never 5183, 5193 or
  5203 — those are the parallel slots' ports (O11); adopting a server there tests
  another instance's stack** (observed 2026-09-10: a slot-0 run moved to 5183 and the
  slot-1 suite silently ran against `:3000`/`fmdev`). Mock mode is never a substitute
  for a live run.
- Live runs mutate the shared DB — wrap seed + run in TANGO's lock:
  `npm run qa:locked -- bash -c "npm run seed:<x> && npm run test:<x>"`.

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
5. **Release the slot** — `bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" release` —
   on every ending, including a stop. (A crashed session's claim is reused
   automatically once its pid is gone.)

### O11. Every run is an isolated stack — own worktrees, own Rails, own DB
Every fexa-qa run gets its own TANGO worktree, its own fexa-pwa worktree, its own
Fexy-Zamo worktree booted on its own port, and its own cloned database, so any number
of tickets can run **truly in parallel** and none of them touches the user's dev stack.
TANGO's `qa-ticket-multi` skill documents the engine side (fresh-DB mode); this is the
per-instance recipe for it on this machine. Preflight's `qa-slot.sh claim` gave you
`FEXA_QA_SLOT` ≥ 1; slot 0 (`:3000`, `fmdev`, `:5173`, the main checkouts) is the
user's dev environment and is never claimed by QA.

```bash
source ~/.config/fexa-workflow/config.env
export PATH="$SENCHA_CMD_DIR:$RBENV_ROOT/shims:$RBENV_ROOT/bin:$PATH"; eval "$(rbenv init - bash 2>/dev/null)"
. "$HOME/.nvm/nvm.sh" && nvm use 20 >/dev/null
eval "$(bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" env)"   # FEXA_QA_SLOT + ports
SLOT=$FEXA_QA_SLOT
cd "$TANGO_PATH"
# 1. TANGO worktree (branch qa/<ticket>; node_modules + .env symlinked). The
#    helper's own FEXA_PWA_PORT (5173+slot) is overridden by the claim's
#    5173+10*slot, clear of the first instance's +1/+2 pair ports.
eval "$(scripts/qa-agent-worktree.sh create <TICKET> $SLOT | sed -n 's/^export /export /p')"
eval "$(bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" env)"
export TANGO_PATH="$TANGO_PATH/.claude/worktrees/qa-<lowercased-ticket>"
# 2. fexa-pwa worktree (pwa tickets only) — detached at origin/$FEXA_PWA_BRANCH (qa), per O2
eval "$(bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/pwa-worktree.sh" create <TICKET> | sed -n 's/^export /export /p')"
# 3. Fexy-Zamo worktree — a second Rails must NOT boot from the main checkout
#    (shared tmp/pids, tmp/restart.txt, log/). One-time per worktree: the
#    wrapper's fast-mode build (~2 min, O6 — TANGO's own script fails here) and
#    the hand-built translations file the desktop UI reads.
eval "$(scripts/cmms-checkout.sh ensure develop)"  # -> FEXY_ZAMO_PATH=<Fexy-Zamo>/.claude/worktrees/cmms-develop, QA_CMMS_REF
grep -q TANGO_FAST_MODE "$FEXY_ZAMO_PATH/config/routes.rb" || bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/fexa-fast-mode.sh"
mkdir -p "$FEXY_ZAMO_PATH/public/scripts" && cp -n "$HOME/work/Fexy-Zamo/public/scripts/translations.js" "$FEXY_ZAMO_PATH/public/scripts/" 2>/dev/null || true
# 4. Isolated DB + Rails. The template is built once (migrate + demo seed);
#    every later run clones it in seconds. NEVER echo DATABASE_URL — it embeds creds.
#    TANGO's fresh-cmms-db.sh reads PG creds with `YAML.load(..., aliases:)`, which
#    Ruby 2.7 (this machine) rejects — export them first so its own read is a no-op:
eval "$(ruby -ryaml -rerb -e 'y=YAML.load(ERB.new(File.read(ARGV[0])).result)["default"]; puts "export PGUSER=#{y["username"]} PGPASSWORD=#{y["password"].inspect} PGHOST=#{y["host"]} PGPORT=#{y["port"]}"' "$FEXY_ZAMO_PATH/config/database.yml")"
scripts/fresh-cmms-db.sh template retailer        # no-op when current
scripts/fresh-cmms-db.sh create retailer          # -> tango_qa_run_retailer
export DATABASE_URL="$(scripts/fresh-cmms-db.sh url retailer)"
#    CMMS_PORT / REDIS_PORT / TEST_BASE_URL / FEXA_PWA_PORT came from the claim
#    (TANGO derives VITE_BACKEND_URL from TEST_BASE_URL).
#    Both flags below are REQUIRED. Puma's sencha plugin writes into app/assets
#    after boot and Rails 5.2's file checker flags a reload in every forked
#    worker; either reload leaves Devise holding a stale SSOCustomFailure class,
#    and every unauthenticated request then 500s (verified 2026-09-10).
export DISABLE_SENCHA_WATCH=1 FEXA_DEV_PUMA_WORKER_THREADS=0
npm run cmms:ensure -- redis rails                # isolated Rails, fast mode, single-process, on $CMMS_PORT
```

Then run the pipeline exactly as usual — the exported paths and ports carry through.
The PWA's vite proxy follows `VITE_BACKEND_URL`, which TANGO's live projects derive
from `TEST_BASE_URL`, so the second PWA talks to the second Rails. Deltas while parallel:

- **Preflight** still applies to the TANGO worktree: it is on `qa/<ticket>`, not
  `main`, so do not check out `$TANGO_BRANCH` there. Sync onto `origin/main` as normal.
- **Code under test (O2)** — the Fexy-Zamo worktree is pinned to `origin/develop`; for
  a cmms ticket with its own branch, `cmms-checkout.sh ensure <branch>` instead. When
  `ensure` moves the worktree's HEAD it calls TANGO's fast-mode script, which fails
  here — re-run the wrapper's with `FORCE_REBUILD=1` afterwards.
- **A fresh clone has no `tango_*` persona users**, and on the `fexa-pwa-live` project
  `global-setup` logs every `.env` role in first — each failed login costs ~30 s per run.
  Seed the personas once per clone in one Rails boot (`seed:all:fast` aborts partway on a
  fresh clone at the first invoice-dependent seed, so name them explicitly):
  ```bash
  cd "$FEXY_ZAMO_PATH" && DISABLE_SPRING=true bundle exec rails runner "$TANGO_PATH/seeds/run-many.rb" \
    pricing-admin-user.rb vendor-class-filtering.rb approved-rate-reference.rb client-custom-field-export.rb \
    default-hidden-types.rb hidden-invoice-direct-link.rb asset-criteria-pricing.rb assignment-nte-stale-overwrite.rb
  ```
  (verified 2026-09-10: all eight OK, ~1 min). Then the ticket's own seed.
- **Before every run, check nobody else sits on your PWA port.** `qa-slot.sh env` warns
  when the slot's port is served from outside a `qa-*` worktree; Playwright's
  `reuseExistingServer` would adopt that server and the suite would silently test the
  other instance's stack (happened 2026-09-10: a slot-0 run had moved to 5183). If it
  warns, `export FEXA_PWA_PORT=<next free slot port>` for the run and say so in the report.
- **No lock waiting.** The DB lock keys on `DATABASE_URL`, so `qa:locked` never
  contends with the user's `:3000` stack. Keep using it anyway (habit + safety).
- **No Elasticsearch / Sidekiq in fresh mode** — index names aren't isolated. A
  search-dependent ticket must run on the shared `:3000` stack behind the lock
  instead; say so and fall back to the plain O3 flow.
- **Ending (O10 delta):** the commit proposal is for branch `qa/<ticket>` in the
  worktree. On yes: commit there, then in the main TANGO clone
  `git merge --no-ff qa/<ticket>` into `$TANGO_BRANCH` (append-conflicts are
  keep-both; `reports/latest/summary.html` is regenerated, never hand-merged — see
  `qa-ticket-multi` §6). If `bryan/qa` was rebased since the branch was cut, replay
  only the ticket commit first: `git rebase --onto bryan/qa <old-base> qa/<ticket>`.
  `npm run report:summary` cannot run on Node 20 (plain `node` on a `.ts` file, no
  TS runner installed) — compile it instead, from the main clone:
  ```bash
  OUT=/tmp/tango-summary-js; npx tsc src/reporters/summary.ts --outDir "$OUT" --rootDir . --module commonjs --target es2020 --esModuleInterop --skipLibCheck --resolveJsonModule && node "$OUT/src/reporters/summary.js"
  ```
  Then push `$TANGO_BRANCH` and tear down:
  ```bash
  npm run cmms:stop                                # same CMMS_PORT/REDIS_PORT env
  scripts/fresh-cmms-db.sh drop retailer           # keeps the template
  scripts/qa-agent-worktree.sh remove <TICKET>     # from the main TANGO clone
  bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/pwa-worktree.sh" remove <TICKET>
  bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/qa-slot.sh" release
  ```
  The Fexy-Zamo worktree stays (it is reused; `cmms-checkout.sh remove develop` drops it).
- **Budget:** each parallel instance is a Rails boot plus a Chromium. Two or three at
  once is the practical ceiling on a 32 GB machine.
- **Status (2026-09-10):** dry-run verified end to end on this machine — Fexy-Zamo
  worktree + wrapper fast-mode build, retailer template (370s, 94 MB), 1-second clone,
  isolated Rails on :3100 against the clone, a PWA worktree on :5183 proxying to it,
  and a Devise sign-in landing in the isolated log only. The fexa-pwa `VITE_BACKEND_URL`
  vite change is on `origin/qa` (2026-09-16), so the worktree needs no copied config.

## Hard rules (delta over `qa-ticket`'s own list, which also applies)

- **Preflight first; echo the resolved line before running anything.**
- **Never touch TANGO `main`.** No commits, no pushes, no PRs. Branch is `$TANGO_BRANCH`.
- **Never modify TANGO's engine files to fix an environment problem** — fix it in this
  wrapper (scripts/, reference/, config.env). TANGO stays a pristine, pullable clone.
- **PWA defaults to live.** Mock only for the exceptions in O3; probe the port with the
  inlined `VITE_USE_MOCKS` flag, never with the static worker file.
- **Read exactly one `reference/targets/*.md` per run.**
- **Fast mode via the wrapper's script only**; never for a mock run.
- **Verbatim AC, domain-language names, `focus` on positive snapshots, input values
  in `test.step()` labels** — as `qa-ticket` says.
- **Don't commit, push, or post without an explicit yes.**
- **QA never runs on slot 0.** `:3000`/`fmdev`/`:5173` and the main checkouts belong to
  the user's dev work; every run is an isolated O11 stack on the slot the claim gave it.
  Never pick a slot by hand. Instances never share a checkout, a Rails port, or a DB.
- **PWA code under test is `$FEXA_PWA_BRANCH` (`qa`), never `main`** (O2).
