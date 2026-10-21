# Local rules for this TANGO clone (personal — not committed; installed by fexa-workflow/bin/setup.sh)

These override TANGO's skills where they conflict.

- **QA never runs on the dev stack.** Rails `localhost:3000`, the `fmdev` database and the PWA
  on `:5173` belong to development, which runs at the same time. This overrides `qa-ticket`
  step 2 ("check Rails at localhost:3000"): every run uses an isolated slot (slot >= 1, own
  Rails port, cloned database, own worktrees) per `~/work/fexa-workflow/qa-tools/README.md`.
- Each Bash call is a fresh shell: load the slot env (`qa-slot.sh env`) and export
  `DATABASE_URL` in the same command as any seed, `playwright test`, `qa:gate` or
  `cmms:ensure`. A `tango-dev-guard` hook blocks commands that don't.
- Commit to `main` after `git pull --rebase`; follow the maintainer's existing patterns.
