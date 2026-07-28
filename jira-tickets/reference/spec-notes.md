# Spec mode — parked conventions (not implemented)

A future "spec" capability: take a ticket key, derive a structured planning doc from
description + AC + comments + project context, write it to a local specs directory,
and stop. Preserved conventions so they don't decay:

- **Output**: `specs/<TICKET-KEY>.md`, gitignored, never committed. Exact key as
  filename (`TANGO-9.md`). Never overwrite an existing spec silently — ask.
- **Project context required**: load the Fexy-Zamo memory bank (path from
  `MEMORY_BANK` in `~/.config/fexa-workflow/config.env`) before drafting; stop if
  missing. Use silently.
- **Branch convention encoded in output**: branch = `<TICKET-KEY>` off `develop`;
  PRs target `develop`.
- **Structure**: header (status/type/priority/assignee/parent/source link) →
  Context (2-3 sentence synthesis, domain language) → Acceptance Criteria
  (verbatim, grouped by section) → Open questions (conflicts with established
  patterns, ambiguities, comment-sourced clarifications) → Approach (files,
  models/concerns, migrations, state-machine + multi-tenancy touches) → Test plan
  (one row per AC clause + edges, personas, seed needs) → Suggested next steps.
- **Hard rules**: verbatim AC; never auto-branch/code/test after writing; never
  print the Jira token.
- **Trakref note**: the domain is Fexy-Zamo (enterprise facilities management).
  "Trakref" was a prior HVAC repo; here it's only an external integration — don't
  apply HVAC assumptions.

Reuse `scripts/jira-fetch.sh` for the fetch. Much of this overlaps with what plan
mode in a Fexy-Zamo-launched session already does — reconsider whether a separate
skill is needed before building it.
