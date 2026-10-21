# qa-tools — local helpers for running TANGO on this (WSL) machine

TANGO ([facilitiesexchange/TANGO](https://github.com/facilitiesexchange/TANGO)) is the
QA engine and its own `qa-ticket` / `qa-ticket-multi` skills are the pipeline. This
folder is NOT a skill and adds no rules on top of TANGO. It holds:

- scripts that work around problems hit on this machine, until they are fixed in TANGO
  (raise them with TANGO's maintainer — these are candidates to upstream), and
- the slot guard that keeps QA off the dev stack so QA and development run in parallel.

Commit TANGO work straight to TANGO `main`, as its maintainer does
(`git pull --rebase` before running and before pushing).

## The one rule: QA never touches the dev stack

Enforced, not just documented: `hooks/tango-dev-guard.sh` is a Claude Code hook registered
in `~/.claude/settings.json` (user level — every session, whichever repo it starts in).
It blocks any TANGO seed / `playwright test` / `qa:gate` / `cmms:ensure` / seed-via-`rails runner`
whose command does not load the slot env and, when a database is involved, export
`DATABASE_URL`. `tango-local/CLAUDE.local.md` is copied into the TANGO clone (git-excluded via
`.git/info/exclude`, never committed) so Claude takes the isolated path by default.
Both are installed by `bin/setup.sh` and checked by `bin/doctor.sh`. Commands you type
yourself in a terminal are not covered.

Slot 0 — Rails `:3000`, DB `fmdev`, PWA `:5173`, the main checkouts — is development.
Every QA run takes slot ≥ 1 with its own Rails port, Redis port, PWA port and a cloned
database. **Load the slot env in every shell before any TANGO command** (`npm run seed:*`,
`qa:gate`, `playwright test`): TANGO falls back to `../Fexy-Zamo` (= `fmdev`) when
`FEXY_ZAMO_PATH`/`DATABASE_URL` are not exported, and `qa:gate` re-runs the ticket's seed.

```bash
eval "$(bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh claim <TICKET>)"  # once: lowest free slot >= 1
eval "$(bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh env)"            # every later shell
bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh release                   # at the end
```

Slot N gives `CMMS_PORT=3000+100N`, `REDIS_PORT=6379+N`, `TEST_BASE_URL`, `FEXA_PWA_PORT=5173+10N`.

## Isolated stack recipe (slot >= 1)

Run from the TANGO checkout, slot env loaded. TANGO's `qa-ticket-multi` documents the
engine side (fresh-DB mode); these are the extra steps this machine needs.

```bash
cd ~/work/TANGO
# 1. TANGO worktree for the ticket
eval "$(scripts/qa-agent-worktree.sh create <TICKET> $FEXA_QA_SLOT | sed -n 's/^export /export /p')"
eval "$(bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh env)"     # slot ports win
export TANGO_PATH="$HOME/work/TANGO/.claude/worktrees/qa-<lowercased-ticket>"
# 2. (PWA tickets) fexa-pwa worktree, detached at origin/qa — PWA code under test is `qa`, never main
eval "$(bash ~/work/fexa-workflow/qa-tools/scripts/pwa-worktree.sh create <TICKET> | sed -n 's/^export /export /p')"
# 3. Fexy-Zamo worktree (never boot a second Rails from the main checkout: shared tmp/pids, log/)
eval "$(scripts/cmms-checkout.sh ensure develop)"        # or the ticket's branch
grep -q TANGO_FAST_MODE "$FEXY_ZAMO_PATH/config/routes.rb" || bash ~/work/fexa-workflow/qa-tools/scripts/fexa-fast-mode.sh
mkdir -p "$FEXY_ZAMO_PATH/public/scripts" && cp -n ~/work/Fexy-Zamo/public/scripts/translations.js "$FEXY_ZAMO_PATH/public/scripts/" 2>/dev/null || true
# 4. Cloned DB + Rails. Export PG creds first (fresh-cmms-db.sh's YAML read fails on Ruby 2.7).
#    NEVER echo DATABASE_URL — it embeds credentials.
eval "$(ruby -ryaml -rerb -e 'y=YAML.load(ERB.new(File.read(ARGV[0])).result)["default"]; puts "export PGUSER=#{y["username"]} PGPASSWORD=#{y["password"].inspect} PGHOST=#{y["host"]} PGPORT=#{y["port"]}"' "$FEXY_ZAMO_PATH/config/database.yml")"
scripts/fresh-cmms-db.sh template retailer && scripts/fresh-cmms-db.sh create retailer
export DATABASE_URL="$(scripts/fresh-cmms-db.sh url retailer)"
( cd "$FEXY_ZAMO_PATH" && DISABLE_SPRING=true bundle exec rails db:migrate )       # clones can lag a migration
psql -d tango_qa_run_retailer -c "UPDATE site_settings SET value='$TEST_BASE_URL' WHERE name='host_url'"   # else vendor login redirects to :3000
export DISABLE_SENCHA_WATCH=1 FEXA_DEV_PUMA_WORKER_THREADS=0    # both required: otherwise unauthenticated requests 500
npm run cmms:ensure -- redis rails          # add `sidekiq` (with USE_LETTER_OPENER=1) for export/email tickets
```

Then run TANGO's pipeline as usual. Gotchas seen on this machine:

- **Never `source` TANGO's `.env`** — its `TEST_BASE_URL=:3000` clobbers the slot and live
  PWA runs then proxy to the dev Rails. Export only the keys a seed needs, then re-run `qa-slot.sh env`.
- **A fresh clone has no `tango_*` personas** — seed the ones the suite logs in as, in one
  Rails boot: `rails runner "$TANGO_PATH/seeds/run-many.rb" <seed files…>`.
- **Demo vendor password differs from `.env`** — a seed using the vendor must `update!(password: ENV['VENDOR_PASSWORD'])`.
- **PWA port:** Playwright adopts whatever already listens on `FEXA_PWA_PORT`; `qa-slot.sh env` warns when it is not a QA worktree.
- **No Elasticsearch in fresh mode** (index names are shared) — search tickets need a different plan.
- **Prove where records landed** (`psql -d <clone>` vs `fmdev`) before trusting a report.

Teardown:

```bash
npm run cmms:stop && scripts/fresh-cmms-db.sh drop retailer
scripts/qa-agent-worktree.sh remove <TICKET>                       # from the main TANGO checkout
bash ~/work/fexa-workflow/qa-tools/scripts/pwa-worktree.sh remove <TICKET>
bash ~/work/fexa-workflow/qa-tools/scripts/qa-slot.sh release
```

## Contents

| Path | What | Why it exists |
|---|---|---|
| `hooks/tango-dev-guard.sh` | PreToolUse hook (user settings) | blocks Claude's TANGO runs that are not on an isolated slot |
| `tango-local/CLAUDE.local.md` | local rules copied into the TANGO clone | isolated slot by default; overrides qa-ticket's `:3000` check |
| `scripts/qa-slot.sh` | slot claim/env/release/status | keeps QA off slot 0; candidate for a TANGO-side guard |
| `scripts/pwa-worktree.sh` | isolated fexa-pwa worktree at `origin/qa` | parallel PWA runs |
| `scripts/fexa-fast-mode.sh` / `fexa-dev-mode.sh` | Sencha prebuild + routes patch | TANGO's `bin/fexa-fast-mode.sh` targets a Sencha root missing on `develop` — upstream candidate |
| `notes/targets/pwa.md` | PWA selector/timing/screenshot notes | TANGO has no PWA equivalent |
| `notes/targets/cmms.md`, `pwa-repo-prerequisites.md` | WSL + repo notes | reference |
| `notes/jira-comment.md` | format for posting a QA result to Jira | used with `jira-tickets/scripts/jira-attach.sh` + `jira-comment.sh` |
