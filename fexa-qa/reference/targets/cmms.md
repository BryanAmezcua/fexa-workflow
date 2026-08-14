# Target: cmms — Fexy-Zamo (Rails + Ext JS, desktop)

Loaded at SKILL.md step 2 when the resolved app is `cmms`. Covers steps 6-9 only.
It never redefines the pipeline, the hard rules, or the report format.

Base URL `http://localhost:3000` · projects `admin`, `vendor`, `facility-manager` ·
Desktop Chrome · per-test timeout 240s.

## Fast mode is mandatory here

Dev mode serves unpacked Sencha sources and the app takes minutes to boot, so tests
time out rather than fail. Confirm `/` redirects to `/main/index` before running.
`npm run fexa:fast-mode` runs a Sencha production build (~2 min) and patches
`routes.rb`; `overmind restart web` reloads it. Revert with `npm run fexa:dev-mode`.

## §Exploration (step 6)

`qa/tests/_explore/<descriptor>.explore.spec.ts` navigates and dumps component
metadata to `qa/exploration/`. Run:

```bash
cd "$FEXA_WORKFLOW_REPO/qa"
TANGO_INCLUDE_EXPLORE=1 npx playwright test tests/_explore/<descriptor>.explore.spec.ts --project=admin
```

Read the emitted JSON to discover real selectors before asserting. Never guess an
Ext selector — the component tree is generated and the class names are not stable.

## §Selectors

Address components through the Ext component tree via `page.evaluate`, not the DOM.

- Deep-link a record: `Ext.History.add('<ctype>/<id>')`
- Buttons: `button[reference=…Btn]`
- Form fields: `formpanel [name=…]`
- InfiniteCombo: `setValue` then poll `getValue() != null` — it resolves async
- Grids: query the store, not the rendered rows (virtualized)

## §Timing and flake taxonomy (step 8)

- **Cold start** — the first test in a run pays Ext boot. The `gotoInvoice` helper in
  `tests/pricing/enforced-rate.spec.ts` has the proven retry loop; reuse it.
- **InfiniteCombo** — retry 5x.
- **Form open** — defensive close + retry 3x.
- **"Execution context was destroyed"** — Ext navigations tear down the page context
  mid-evaluate. `safeEval` in `tests/workorder/assignment-nte-revert.spec.ts` wraps it.
- **Dates** — construct via `Date.UTC(...)`; the runner pins `timezoneId: 'UTC'`.
- Bump `test.setTimeout()` per spec if a flow genuinely needs longer than 240s.

Proven helpers to reuse rather than rewrite: `gotoInvoice`, `openNewLineItemForm`,
`selectProduct` in `tests/pricing/enforced-rate.spec.ts`.

## §Screenshots (step 9)

Desktop viewport, so the AC-proving element is usually in frame. Confirm each
before/after PNG actually shows the proving element — locked field greyed, helper
text rendered, dialog copy, persisted grid row, or the empty region for absence
assertions.

Transient UI (hover, tooltip) is captured by triggering the state, awaiting
`waitFor({state:'visible'})`, then calling `page.screenshot()` directly — bypassing
the helper's scroll, which dismisses it.

## §Do not touch

The Ext interaction knowledge in these specs is undocumented protocol knowledge whose
only spec is the code. Restyle nothing, dedupe nothing as part of unrelated work.
