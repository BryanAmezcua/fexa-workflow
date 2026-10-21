# Target: cmms — Fexy-Zamo (Rails + Ext JS, desktop) — WSL notes only

Loaded at SKILL.md O4 when the resolved app is `cmms`. TANGO's own `qa-ticket` skill is
the reference for Ext selectors, the flake taxonomy, and the proven helpers
(`tests/pricing/overlap-warning.spec.ts`, `tests/pricing/approved-rate-reference.spec.ts`,
`src/support/fexa-app.ts`, `src/support/lineitem-grid.ts`). This file adds only what is
specific to this machine.

## Fast mode

Dev mode serves unpacked Sencha sources; the app takes minutes to boot and TANGO's
`global-setup` refuses to run. Confirm `/` redirects to `/main/index` first.

Use the wrapper's script, not TANGO's (`npm run fexa:fast-mode` points at a Sencha app
root that does not exist on `develop` here):

```bash
bash "$FEXA_WORKFLOW_REPO/fexa-qa/scripts/fexa-fast-mode.sh"   # idempotent; FORCE_REBUILD=1 after frontend changes
cd "$FEXY_ZAMO_PATH" && overmind restart web
```

Sencha Cmd must be the version the project pins (`$SENCHA_CMD_DIR` in config.env —
the `Cmd/` subdirectory, not the launcher one level up).

## Rails here

`bin/dev` / `overmind start -f Procfile.dev -D` from `$FEXY_ZAMO_PATH` runs web +
sidekiq (the `sencha` watcher line stays commented). Postgres, Redis and Elasticsearch
are systemd services inside WSL. `overmind restart web` after any routes change.

## Seeds here

`bundle exec rails runner` needs rbenv Ruby on PATH — use the environment block in
SKILL.md. Every seed is a cold Rails boot (~30–60 s); `seed:all:fast` does the whole
chain in one boot.

## Do not touch

The Ext interaction knowledge in TANGO's specs and support modules is undocumented
protocol knowledge whose only spec is the code. Reuse; never rewrite as part of
unrelated work.
