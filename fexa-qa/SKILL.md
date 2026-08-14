---
name: fexa-qa
description: Runs automated GUI QA for Fexa Jira tickets against either app — the Fexy-Zamo CMMS (Rails + Ext JS desktop) or the fexa-pwa mobile PWA (React/Vite) — using the shared Playwright engine in the fexa-workflow repo. Given a ticket key it fetches the verbatim acceptance criteria, resolves which app is under test, plans scenarios, writes seed + spec files, runs them against local Rails, visually verifies every screenshot, and produces a self-contained HTML report. Use when the user asks to QA, test, or verify a ticket — "qa TANGO-9", "QA TANGO-75 on the PWA", "verify TANGO-72". Works from either repo. The app under test is resolved from the request or the working directory and is always echoed before anything runs.
---

# fexa-qa

The engine is a native **Playwright Test** project at `<repo>/qa`, where `<repo>` is
`$FEXA_WORKFLOW_REPO` from `~/.config/fexa-workflow/config.env` (default
`~/work/fexa-workflow`). Verify `<repo>/qa/package.json` exists before starting; if
not, tell the user to clone fexa-workflow and run `bin/setup.sh`.

Job: extend the engine for a new ticket — AC constants + seed + spec — run against
the local stack, produce `qa/reports/latest/<TICKET>.html`, then critique coverage.
`<TICKET>` = full key (`TANGO-5`); `<PROJECT>` = prefix; `<N>` = number.
Flags: `--no-post` (default — never auto-post to Jira), `--no-commit` (skip commit).

## Two apps, one backend

| | `cmms` | `pwa` |
|---|---|---|
| App | Fexy-Zamo (Rails + Ext JS) | fexa-pwa (React + Vite) |
| Base URL | `http://localhost:3000` | `http://localhost:5173` |
| Playwright projects | `admin`, `vendor`, `facility-manager` | `pwa-admin`, `pwa-vendor`, `pwa-facility-manager` |
| Specs | `qa/tests/<area>/` | `qa/tests/pwa/<area>/` |
| Viewport | Desktop Chrome | 390x844 mobile |
| Fast mode | required | N/A |

Both apps run against the **same local Rails and the same database**. Three
consequences that remove most of the apparent complexity:

- **Seeds are app-independent.** `qa/seeds/*.rb` provision fixtures for both. No gating.
- **Auth is app-independent.** One login pass writes `auth/<persona>.json`; the Devise
  cookie is host-only on `localhost` and cookies ignore port, so `:3000`'s session is
  sent to `:5173`. There is no per-app auth file and no second login.
- **Personas are app-independent.** An admin is the same user with the same permissions
  in either app.

Only local is supported. There is no deployed-environment mode in this skill.

## Environment cheatsheet (WSL — learned the hard way)

All commands run from `<repo>/qa`. Non-interactive shells do NOT load the
interactive PATH, so prepend tools explicitly:

```bash
# Ruby (seeds) + Sencha (fast-mode build). Cmd order matters — the project needs
# Sencha Cmd 7.7.0.36, which is ~/bin/Sencha/Cmd/sencha (NOT ~/bin/Sencha/sencha).
export PATH="$HOME/bin/Sencha/Cmd:$HOME/bin/Sencha:$HOME/.rbenv/shims:$HOME/.rbenv/bin:$PATH"
eval "$(rbenv init - bash 2>/dev/null)"
source ~/.config/fexa-workflow/config.env   # FEXY_ZAMO_PATH, FEXA_PWA_PATH live here
export FEXY_ZAMO_PATH FEXA_PWA_PATH
```

## Pipeline

Copy this checklist and check off items as you complete them:

```
QA Progress — <TICKET> (<app>):
- [ ] 1. Fetch ticket + verbatim AC
- [ ] 2. Resolve app + verify environment
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

### 2. Resolve app + verify environment

**Resolve the app first**, in this order. Stop at the first hit:

1. **Explicit** — the request says `pwa`/`mobile`/`fexa-pwa`, or `cmms`/`desktop`/
   `fexy-zamo`/`ext`, or passes `--target=`.
2. **Working directory** — session launched in `$FEXA_PWA_PATH` → `pwa`; in
   `$FEXY_ZAMO_PATH` → `cmms`.
3. **Linked PR** — `gh pr list --search <TICKET> --repo facilitiesexchange/fexa-pwa`
   and the same for `Fexy-Zamo`. Exactly one match is strong evidence. **Confirm with
   the user before proceeding.**
4. **Ticket text** — parent epic ("Mobile: …"), summary prefix, labels
   (`mobile-foundation`). Weak. **Confirm with the user before proceeding.**
5. **Ask.**

Never infer from the ticket key. TANGO numbers interleave both apps — TANGO-5 is
CMMS, TANGO-71 is PWA — so the key carries no signal.

**Echo one line before running anything:**
```
Resolved: TANGO-75 · app=pwa (from cwd) · base=http://localhost:5173
```
Proceed silently when the app came from tier 1 or 2. Require an explicit yes for
tiers 3 and 4. A wrong guess triggers a ~2-minute Sencha build against the wrong
checkout, and at worst yields a green report claiming the wrong app satisfies the AC.

**Then read exactly one target reference and follow it for steps 6-9:**
- `cmms` → `reference/targets/cmms.md`
- `pwa` → `reference/targets/pwa.md`

Reading both is worse than reading neither — it is how Ext selector idioms end up in
a React spec.

**Preflight.** Rails must be up for both apps.

```bash
curl -s -o /dev/null -w "%{redirect_url}\n" --max-time 10 http://localhost:3000/
```
- `→ /main/index` = fast mode ✓.
- `→ /main/development` = dev mode. **Only matters for `cmms`** — Ext tests time out.
  Flip it:
  ```bash
  cd "$FEXA_WORKFLOW_REPO/qa" && npm run fexa:fast-mode   # sencha prod build (~2 min) + patches routes.rb
  cd "$FEXY_ZAMO_PATH" && overmind restart web            # reload routes; wait for /main/index
  ```
  Revert when done: `npm run fexa:dev-mode` + `overmind restart web`.
  **Never run fast mode for a `pwa` run** — it costs two minutes and buys nothing.
- Not listening → ask the user to start Fexy-Zamo (`bin/dev`).

For `pwa`, also start the PWA dev server and let global-setup verify the rest:
```bash
cd "$FEXA_PWA_PATH" && npm run dev    # :5173, proxies /api /users /main -> :3000
```
`global-setup` hard-fails if Vite is down, if the proxy is not forwarding, or if
`/mockServiceWorker.js` returns 200. That last one means the app was started with
`npm run dev:mock`, where MSW answers every endpoint with fabricated data — a suite
run against it passes while proving nothing. **Mock mode is never a QA target.**

### 3. Plan with the user
Ask 2–4 high-leverage questions: **persona(s)** (`admin` always; `vendor`/
`facility-manager` need creds in `qa/.env`), **scope** (models/xtypes/screens,
reuse vs new fixtures), **scenarios** (one per AC clause + edges, each mapped to
its AC ref; fold in comment-sourced edges), **seed needs**.

For `pwa` also ask: which `docs/parity/<screen>.md` covers this screen (it enumerates
every element's permission gate with `file:line` citations — a richer AC source than
Jira), and whether offline behavior is in AC scope.

### 4. Add AC constants
Append `<PROJECT>_<N>_AC` to `qa/src/support/qa-report.ts`:
```ts
export const TANGO_7_AC = {
  Calculation1: { ref: 'Calculation #1', text: 'Verbatim text…' },
} as const satisfies Record<string, AcClause>;
```
**Verbatim** — no paraphrasing, preserve quotes/em-dashes/typos.

One AC object per ticket regardless of app. A gate is universal; only presentation
differs between desktop and mobile.

### 5. Write the seed
`qa/seeds/<descriptor>.rb` — idempotent (clean prior fixtures by name prefix),
reuse existing seeded entities, emit `qa/reports/seed-manifest-<lower-ticket>.json`
(`ticket`, `source_seed`, `generated_at`, `scope`, `fixtures[]`). Add an npm
script mirroring the pattern, then run it:
```bash
# PATH/rbenv/config exports from the cheatsheet above, then:
cd "$FEXA_WORKFLOW_REPO/qa" && npm run seed:<descriptor>
```
Same for both apps — one Rails, one database. Prefix new fixtures `[QA] <TICKET>` so
they are identifiable and never collide with real records.

### 6. Explore if the UI is new
Follow the exploration section of the target reference read in step 2 — the idioms
are completely different per app and do not transfer.

### 7. Write the spec
Domain-language filename (never the ticket key). CMMS specs go in
`qa/tests/<area>/`, PWA specs in `qa/tests/pwa/<area>/`.

Structure is identical on both apps: `test.describe.configure({mode:'serial'})`,
`annotateAc(testInfo, {ticket, ac:[…]})`, `test.skip(testInfo.project.name !== '<project>', …)`,
`test.step()` labels **with input values**, and `captureAcSnapshot(testInfo, page,
'before'|'after', {focus})` bracketing the AC action (`focus` REQUIRED for positive
assertions).

Note the project names differ per app (`admin` vs `pwa-admin`) — see the table above.
Use `personaOf(testInfo.project.name)` from `src/targets` when a spec needs the
persona rather than the project.

Timeouts, waiting strategy and selector policy come from the target reference.

### 8. Run + iterate
```bash
cd "$FEXA_WORKFLOW_REPO/qa"
npx playwright test tests/<area>/<descriptor>.spec.ts --project=admin        # cmms
npx playwright test tests/pwa/<area>/<descriptor>.spec.ts --project=pwa-admin # pwa
```
Run the admin project first (avoids missing vendor/fm `auth/*.json`). The flake
taxonomy is app-specific — see the target reference. **Don't skip failures** — fix or
document as an AC deviation.

### 9. Verify the report + screenshots
`ls -lh qa/reports/latest/<TICKET>.html` (one file per ticket). **A green test is
necessary but not sufficient** — open every before/after PNG (or eyeball in the
report) and confirm each shows the AC-proving element (locked field greyed, helper
text rendered, dialog copy, persisted row, or the empty region for absence
assertions). Re-run and re-verify before declaring done.

The mobile checklist differs materially — see `reference/targets/pwa.md` §Screenshots.

### 10. Critique the coverage (multi-agent)
After the report is green, spawn **multiple subagents in parallel** to critique
whether the suite truly tests every aspect of the AC — distinct lenses:
(a) **coverage completeness** (each AC clause has a real assertion, not just
navigation), (b) **edge/negative rigor** (absence assertions prove the area is
empty; missing edges from AC + dev-context, e.g. server-side enforcement on save),
(c) **evidence validity** (each `focus`/assertion actually proves its AC per §9).

For `pwa` add (d) **permission parity** — hand the agent `docs/parity/<screen>.md`
and ask whether the spec asserts the doc's universal gates or only the happy path.

Give each agent the verbatim AC + the spec path; synthesize their findings into a
prioritized gap list for the user. Fix high-value gaps and re-run before finishing.

### 11. Report to the user (NO auto-post to Jira)
Tell the user: report path (`qa/reports/latest/<TICKET>.html`), **which app was
tested**, pass/fail summary, any AC deviations, that you visually verified the
screenshots (§9), and the critique gap list (§10). **Never post to Jira unless
explicitly asked.** Commit only with approval (`--no-commit` skips); don't push.

Jira comment format lives in `reference/jira-comment.md` — read it only when the
user asks you to draft or post one.

## Hard rules

- **Verbatim AC text** — never paraphrase.
- **Resolve the app before running anything**, and echo the resolved line.
- **Read exactly one `reference/targets/*.md` per run.**
- **Never run fast mode for a `pwa` run.**
- **Abort if `/mockServiceWorker.js` returns 200** — mock mode is never a QA target.
- **Domain-language names** — never the ticket key in file/test names.
- **`focus` locator required** for positive-assertion snapshots.
- **`test.step()` labels include input values** — the report is the repro script.
- **One report file per ticket** — `qa/reports/latest/<TICKET>.html`.
- **Don't modify app source** beyond the routes fast-mode toggle (handled by
  `qa/bin/fexa-fast-mode.sh`).
- **Don't post to Jira / don't push** without explicit user instruction.
