---
name: fexa-qa
description: Runs automated GUI QA for Fexy-Zamo (Fexa CMMS) Jira tickets using the Playwright engine in the fexa-workflow repo. Given a ticket key, it fetches the acceptance criteria, plans scenarios, writes seed + spec files, runs them against the local Rails app in fast mode, visually verifies screenshots, and produces a self-contained HTML report. Use when the user asks to QA, test, or verify a ticket (e.g. "qa TANGO-9"). Requires a Fexy-Zamo checkout running on localhost:3000, rbenv Ruby, and Sencha Cmd — only applies when working on Fexy-Zamo.
---

# fexa-qa

The engine is a native **Playwright Test** project at `<repo>/qa`, where `<repo>` is
`$FEXA_WORKFLOW_REPO` from `~/.config/fexa-workflow/config.env` (default
`~/work/fexa-workflow`). Verify `<repo>/qa/package.json` exists before starting; if
not, tell the user to clone fexa-workflow and run `bin/setup.sh`.

Job: extend the engine for a new ticket — AC constants + seed + spec — run against
local Fexy-Zamo in **fast mode**, produce `qa/reports/latest/<TICKET>.html`, then
critique coverage. `<TICKET>` = full key (`TANGO-5`); `<PROJECT>` = prefix; `<N>` = number.
Flags: `--no-post` (default — never auto-post to Jira), `--no-commit` (skip commit).

## Environment cheatsheet (WSL — learned the hard way)

All commands run from `<repo>/qa`. Non-interactive shells do NOT load the
interactive PATH, so prepend tools explicitly:

```bash
# Ruby (seeds) + Sencha (fast-mode build). Cmd order matters — the project needs
# Sencha Cmd 7.7.0.36, which is ~/bin/Sencha/Cmd/sencha (NOT ~/bin/Sencha/sencha).
export PATH="$HOME/bin/Sencha/Cmd:$HOME/bin/Sencha:$HOME/.rbenv/shims:$HOME/.rbenv/bin:$PATH"
eval "$(rbenv init - bash 2>/dev/null)"
source ~/.config/fexa-workflow/config.env   # FEXY_ZAMO_PATH lives here
export FEXY_ZAMO_PATH
```

## Pipeline

Copy this checklist and check off items as you complete them:

```
QA Progress — <TICKET>:
- [ ] 1. Fetch ticket + verbatim AC
- [ ] 2. Verify environment + fast mode
- [ ] 3. Plan with the user
- [ ] 4. Add AC constants
- [ ] 5. Write + run the seed
- [ ] 6. Explore UI (only if new screens)
- [ ] 7. Write the spec
- [ ] 8. Run + iterate to green
- [ ] 9. Visually verify report + screenshots
- [ ] 10. Multi-agent coverage critique
- [ ] 11. Report to user (no auto-post)
```

### 1. Fetch ticket
Use the Jira connector (MCP) if available, else the jira-tickets skill:
`bash ~/.claude/skills/jira-tickets/scripts/jira-fetch.sh <TICKET>`.
Capture: summary, **verbatim AC** grouped by section, comments (esp. "Dev Context —
Grooming"), status/assignee/parent. Summarize to the user: title, AC count, comment
count, dev-context findings.

### 2. Verify environment + fast mode
```bash
curl -s -o /dev/null -w "%{redirect_url}\n" --max-time 10 http://localhost:3000/
```
- `→ /main/index` = fast mode ✓. Proceed.
- `→ /main/development` = dev mode → tests time out. Flip it:
  ```bash
  cd "$FEXA_WORKFLOW_REPO/qa" && npm run fexa:fast-mode   # sencha prod build (~2 min) + patches routes.rb
  cd "$FEXY_ZAMO_PATH" && overmind restart web            # reload routes; wait for /main/index
  ```
- Not listening → ask the user to start Fexy-Zamo (`bin/dev`).

Revert when done: `npm run fexa:dev-mode` + `overmind restart web`.

### 3. Plan with the user
Ask 2–4 high-leverage questions: **persona(s)** (`admin` always; `vendor`/
`facility-manager` need creds in `qa/.env`), **scope** (models/xtypes/screens,
reuse vs new fixtures), **scenarios** (one per AC clause + edges, each mapped to
its AC ref; fold in comment-sourced edges), **seed needs**.

### 4. Add AC constants
Append `<PROJECT>_<N>_AC` to `qa/src/support/qa-report.ts`:
```ts
export const TANGO_7_AC = {
  Calculation1: { ref: 'Calculation #1', text: 'Verbatim text…' },
} as const satisfies Record<string, AcClause>;
```
**Verbatim** — no paraphrasing, preserve quotes/em-dashes/typos.

### 5. Write the seed
`qa/seeds/<descriptor>.rb` — idempotent (clean prior fixtures by name prefix),
reuse existing seeded entities, emit `qa/reports/seed-manifest-<lower-ticket>.json`
(`ticket`, `source_seed`, `generated_at`, `scope`, `fixtures[]`). Add an npm
script mirroring the pattern, then run it:
```bash
# PATH/rbenv/config exports from the cheatsheet above, then:
cd "$FEXA_WORKFLOW_REPO/qa" && npm run seed:<descriptor>
```

### 6. Explore if the UI is new
`qa/tests/_explore/<descriptor>.explore.spec.ts` that navigates + dumps component
metadata to `qa/exploration/`. Run:
`cd qa && TANGO_INCLUDE_EXPLORE=1 npx playwright test tests/_explore/<descriptor>.explore.spec.ts --project=admin`.
Read the JSON to discover real selectors before asserting. Common Ext patterns:
deep-link `Ext.History.add('<ctype>/<id>')`; `button[reference=…Btn]`;
`formpanel [name=…]`; InfiniteCombo = setValue then poll `getValue()!=null`.

### 7. Write the spec
`qa/tests/<area>/<descriptor>.spec.ts` — domain-language filename (never the
ticket key). Structure: `test.describe.configure({mode:'serial'})`,
`test.setTimeout(180_000)`, `annotateAc(testInfo, {ticket, ac:[…]})`,
`test.skip(testInfo.project.name !== '<persona>', …)`, `test.step()` labels
**with input values**, and `captureAcSnapshot(testInfo, page, 'before'|'after',
{focus})` bracketing the AC action (`focus` REQUIRED for positive assertions).
Reuse the proven helpers in `tests/pricing/enforced-rate.spec.ts`
(`gotoInvoice` cold-start retry, `openNewLineItemForm`, `selectProduct`).

### 8. Run + iterate
```bash
cd "$FEXA_WORKFLOW_REPO/qa" && npx playwright test tests/<area>/<descriptor>.spec.ts --project=admin
```
Run `--project=admin` (avoids missing vendor/fm `auth/*.json`). Common fixes:
InfiniteCombo retry 5×; form-open defensive close + retry 3×; dates via
`Date.UTC(...)` (tz pinned UTC); bump `setTimeout`; first-test cold-start is
covered by helper retries. **Don't skip failures** — fix or document as an AC
deviation.

### 9. Verify the report + screenshots
`ls -lh qa/reports/latest/<TICKET>.html` (one file per ticket). **A green test is
necessary but not sufficient** — open every before/after PNG (or eyeball in the
report) and confirm each shows the AC-proving element (locked field greyed, helper
text rendered, dialog copy, persisted row, or the empty region for absence
assertions). Fix transient-UI captures (hover/tooltip) by triggering state +
`waitFor({state:'visible'})` then a direct `page.screenshot()`, bypassing the
helper's scroll. Re-run and re-verify before declaring done.

### 10. Critique the coverage (multi-agent)
After the report is green, spawn **multiple subagents in parallel** to critique
whether the suite truly tests every aspect of the AC — distinct lenses:
(a) **coverage completeness** (each AC clause has a real assertion, not just
navigation), (b) **edge/negative rigor** (absence assertions prove the area is
empty; missing edges from AC + dev-context, e.g. server-side enforcement on save),
(c) **evidence validity** (each `focus`/assertion actually proves its AC per §9).
Give each agent the verbatim AC + the spec path; synthesize their findings into a
prioritized gap list for the user. Fix high-value gaps and re-run before finishing.

### 11. Report to the user (NO auto-post to Jira)
Tell the user: report path (`qa/reports/latest/<TICKET>.html`), pass/fail summary,
any AC deviations, that you visually verified the screenshots (§9), and the
critique gap list (§10). **Never post to Jira unless explicitly asked.** Commit
only with approval (`--no-commit` skips); don't push.

## Jira comment format (only when the user asks to draft/post)

Fixed-width **AC-coverage matrix** — one line per acceptance criterion, wrapped in
a code fence so alignment holds in Jira. The HTML report carries all detail — keep
the comment to the matrix.

```
TANGO QA REPORT
================================================================
Ticket:      <TICKET> — <JIRA_HOST>/browse/<TICKET>
Personas:    <persona label(s), " | "-separated>
Environment: <TEST_BASE_URL, e.g. http://localhost:3000>
Run:         <YYYY-MM-DD> (duration: <mm:ss or ~Ns>)

Result: <N> passed | <M> failed | <S> skipped  ·  AC <first>–<last> covered

Acceptance criteria:
  [PASS]  <AC ref>  <one-line AC summary, plain language>
  ...

Report: <TICKET>.html (attached) — per-test evidence: request/response cards + before/after screenshots
================================================================
```

- `<AC ref>` = the ticket's own AC identifiers (`AC1`, `Site Setting #2`) —
  verbatim, one matrix row per AC clause.
- All-passing is the assumed case. Any unverified AC → `[FAIL]`/`[PARTIAL]` row +
  a short `Details:` block below the matrix (observed vs expected + evidence pointer).
- Findings that don't fail an AC stay OUT of the comment — report + summary only.

## Hard rules

- **Verbatim AC text** — never paraphrase.
- **Domain-language names** — never the ticket key in file/test names.
- **`focus` locator required** for positive-assertion snapshots.
- **`test.step()` labels include input values** — the report is the repro script.
- **One report file per ticket** — `qa/reports/latest/<TICKET>.html`.
- **Don't modify Fexy-Zamo source** beyond the routes fast-mode toggle (handled by
  `qa/bin/fexa-fast-mode.sh`).
- **Don't post to Jira / don't push** without explicit user instruction.
