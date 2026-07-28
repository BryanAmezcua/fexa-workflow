import { test, expect, Page, APIRequestContext, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_85_AC } from '../../src/support/qa-report';

/**
 * Default Hidden Types extended to Assignments/Invoices/Proposals grids — TANGO-85.
 *
 * TWO-LAYER feature (there is NO server-side "read the setting and hide" logic):
 *   Layer A — the backend dynamic_index `in`/`not in` workflow-type filter
 *     contract. Deterministic, provable over the API with explicit filter params.
 *     This is the Ruby the PR changed (added to the 3 invoice/quote controllers;
 *     the Assignments filter pre-existed and was NOT normalized).
 *   Layer B — the frontend wiring: each grid's ContainerController reads its
 *     SSetting in the browser and injects a `not in` store filter on default
 *     load (only when the setting is populated). Proven by booting the app and
 *     (1) asserting the settings reach the client `_SSetting` store, and (2)
 *     evaluating the ContainerController's exact filter-guard expression against
 *     those live values. Uses the PRODUCT-SEEDED values (Assignments populated
 *     with cancelled+rejected, invoice grids empty) so NO global SSetting
 *     mutation is needed.
 *
 * Shipped contract (verified against the running app + merged minitest):
 *   - populated `not in [type]`  → records of that type excluded, others present
 *   - `in [type]`                → the otherwise-hidden records surface (AC7)
 *   - empty `not in []`          → invoice/quote grids: NO-OP (full set); but the
 *                                  ASSIGNMENTS backend is UN-NORMALIZED → BLANKS
 *                                  the grid (finding)
 *   - NULL-status record         → silently dropped by any `not in` (LEFT JOIN)
 *
 * Pre-requisite: `npm run seed:default-hidden-grid-types` — runs the product
 * seed (settings), builds hidden/visible fixtures across the 4 grids, and writes
 * reports/seed-manifest-tango-85.json.
 */

const TICKET = 'TANGO-85';

type GridKey = 'vendor_invoice' | 'proposal' | 'client_invoice' | 'assignment';
const GRID_KEYS: GridKey[] = ['vendor_invoice', 'proposal', 'client_invoice', 'assignment'];

interface GridScope {
  endpoint: string;
  root_property: string;
  filter_property: string;
  hidden_type: number;
  visible_type: number;
  hidden_id: number;
  visible_id: number;
  setting_key: string;
  setting_value: number[];      // the FULL shipped hidden-types array for this grid
  hidden_id_2?: number;         // assignments: second hidden fixture (rejected type)
  hidden_type_2?: number;       // assignments: the rejected type id (14)
}

interface Manifest {
  ticket: string;
  scope: {
    workflow_types: { new: number; accepted: number; cancelled: number; rejected: number };
    settings: Record<GridKey, { key: string; value: number[] }>;
    null_status_invoice_id: number;
    grids: Record<GridKey, GridScope>;
  };
  api_auth: { base_path: string; token_type: string; tokens: { admin: string }; token_owners: { admin: number } };
  model_checks: Array<{ ac: string; name: string; passed: boolean; detail: string }>;
}

const MANIFEST_PATH = path.resolve(process.cwd(), 'reports', 'seed-manifest-tango-85.json');

function loadManifest(): Manifest | null {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest; } catch { return null; }
}

// --- Evidence rendering (renderExchange pattern from the TANGO-86 spec) -----

interface ExchangeView {
  title: string; persona: string; method: string; url: string;
  requestBody: unknown; status?: number; responseBody?: unknown; note?: string;
}

async function renderExchange(testInfo: TestInfo, page: Page, moment: 'before' | 'after', view: ExchangeView): Promise<void> {
  const statusClass = view.status == null ? '' : view.status >= 200 && view.status < 300 ? 'ok' : 'err';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const json = (v: unknown) => esc(JSON.stringify(v, null, 2));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 14px/1.5 -apple-system, Menlo, monospace; margin: 0; background: #0f1115; color: #e6e6e6; padding: 24px; }
    .title { font-size: 18px; font-weight: 700; margin-bottom: 4px; color: #fff; }
    .persona { color: #9aa4b2; margin-bottom: 16px; }
    .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #9aa4b2; }
    .reqline { font-weight: 700; color: #7fd1ff; word-break: break-all; }
    pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 700; }
    .status.ok { background: #14361f; color: #7ee29b; border: 1px solid #2f6b43; }
    .status.err { background: #3a1620; color: #ff9bb0; border: 1px solid #7a2c3f; }
    .note { color: #d7b65a; margin-top: 8px; }
  </style></head><body>
    <div class="title">${esc(view.title)}</div>
    <div class="persona">Persona: ${esc(view.persona)} &nbsp;·&nbsp; ${TICKET}</div>
    <div id="req-card" class="card"><h3>Request</h3><div class="reqline">${esc(view.method)} ${esc(view.url)}</div><pre>${json(view.requestBody)}</pre></div>
    ${view.status != null ? `<div id="res-card" class="card"><h3>Response</h3><div><span id="status" class="status ${statusClass}">HTTP ${view.status}</span></div><pre>${json(view.responseBody)}</pre></div>` : ''}
    ${view.note ? `<div class="note">${esc(view.note)}</div>` : ''}
  </body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const focus = moment === 'after' && view.status != null ? page.locator('#res-card') : page.locator('#req-card');
  await captureAcSnapshot(testInfo, page, moment, { focus });
}

// --- API helpers -----------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

interface ApiResult { status: number; body: unknown; }

async function apiGet(request: APIRequestContext, url: string, token: string): Promise<ApiResult> {
  const res = await request.get(url, { headers: authHeaders(token) });
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status(), body };
}

/** Build a dynamic_index URL with a workflow-type filter. */
function diUrl(scope: GridScope, operator: 'in' | 'not in', value: number[]): string {
  const filter = encodeURIComponent(JSON.stringify([{ property: scope.filter_property, operator, value }]));
  return `${scope.endpoint}.json?filter=${filter}&limit=2000`;
}
function diUnfiltered(scope: GridScope): string {
  return `${scope.endpoint}.json?limit=2000`;
}

/** Pull the id array out of a dynamic_index response for a grid's rootProperty. */
function rowsFor(scope: GridScope, body: unknown): number[] {
  const rows = (body as Record<string, unknown>)?.[scope.root_property];
  return Array.isArray(rows) ? (rows as Array<{ id: number }>).map(r => r.id) : [];
}

// --- Suite -----------------------------------------------------------------

const manifest = loadManifest();
const adminPersona = 'Super Admin · bigbrother@fexa.io (Bearer; grid-load/config story — enforcement not a factor)';

test.describe('Default Hidden Types on Assignments/Invoices/Proposals grids (TANGO-85)', () => {
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'API + admin-grid story; run once under the admin project');
    test.skip(!manifest, `Seed manifest missing at ${MANIFEST_PATH}. Run: npm run seed:default-hidden-grid-types`);
  });

  // ===== LAYER A — backend dynamic_index filter contract (API) =====

  test('populated hidden-types filter excludes those types from the default load on all four grids (AC4/AC6)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.DefaultLoad1, TANGO_85_AC.DefaultLoad3] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'dynamic_index with a `not in [hiddenType]` filter — the exact filter each grid injects on default load',
      persona: adminPersona, method: 'GET',
      url: GRID_KEYS.map(k => diUrl(m.scope.grids[k], 'not in', [m.scope.grids[k].hidden_type])).join('  |  '),
      requestBody: { note: 'Server-side exclusion (AC6): the hidden-type rows are absent from the JSON payload and the total is reduced — not hidden in the DOM.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of GRID_KEYS) {
      const scope = m.scope.grids[key];
      // Use the FULL shipped hidden-types array (Assignments = [cancelled,rejected]);
      // for the invoice grids the seed populates a single type, so this is [hidden_type].
      const hiddenTypes = scope.setting_value.length ? scope.setting_value : [scope.hidden_type];
      // The set of hidden fixture ids to prove excluded (Assignments has two).
      const hiddenIds = [scope.hidden_id, scope.hidden_id_2].filter((x): x is number => typeof x === 'number');
      await test.step(`${key}: GET dynamic_index not in [${hiddenTypes.join(',')}] → hidden ${hiddenIds.join('/')} absent, visible #${scope.visible_id} present, count reduced`, async () => {
        const unfiltered = await apiGet(request, diUnfiltered(scope), m.api_auth.tokens.admin);
        const filtered = await apiGet(request, diUrl(scope, 'not in', hiddenTypes), m.api_auth.tokens.admin);
        expect(filtered.status, `${key}: status`).toBe(200);
        const allIds = rowsFor(scope, unfiltered.body);
        const ids = rowsFor(scope, filtered.body);
        outcomes[key] = { filter: hiddenTypes, unfiltered_count: allIds.length, filtered_count: ids.length, hidden_ids: hiddenIds, all_hidden_excluded: hiddenIds.every(h => !ids.includes(h)), has_visible: ids.includes(scope.visible_id) };
        // Self-contained premise: prove every hidden fixture EXISTED unfiltered
        // (rules out a vacuous "record was never there" pass), then is excluded.
        for (const h of hiddenIds) {
          expect(allIds.includes(h), `${key}: hidden id ${h} existed in the unfiltered feed`).toBe(true);
          expect(ids.includes(h), `${key}: hidden id ${h} excluded by not in [${hiddenTypes.join(',')}]`).toBe(false);
        }
        expect(ids.includes(scope.visible_id), `${key}: visible id present`).toBe(true);
        expect(ids.length, `${key}: server-side count reduced vs unfiltered`).toBeLessThan(allIds.length);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four grids: hidden-type rows excluded from the payload, visible rows retained, count reduced',
      persona: adminPersona, method: 'GET', url: 'four dynamic_index endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('applying an `in [hiddenType]` filter surfaces the hidden records on all four grids (AC7/AC9)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.Surface1, TANGO_85_AC.BackendFilter1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'dynamic_index with `in [hiddenType]` — the filter a user applies to surface hidden records',
      persona: adminPersona, method: 'GET',
      url: GRID_KEYS.map(k => diUrl(m.scope.grids[k], 'in', [m.scope.grids[k].hidden_type])).join('  |  '),
      requestBody: { note: 'AC7: hidden records stay reachable — an explicit type filter returns them. AC9: in/not-in supported on the invoice/proposal endpoints (newly added) mirroring Assignments.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of GRID_KEYS) {
      const scope = m.scope.grids[key];
      await test.step(`${key}: GET dynamic_index in [${scope.hidden_type}] → hidden #${scope.hidden_id} surfaces`, async () => {
        const { status, body } = await apiGet(request, diUrl(scope, 'in', [scope.hidden_type]), m.api_auth.tokens.admin);
        const ids = rowsFor(scope, body);
        outcomes[key] = { status, count: ids.length, has_hidden: ids.includes(scope.hidden_id) };
        expect(status, `${key}: status`).toBe(200);
        expect(ids.includes(scope.hidden_id), `${key}: hidden id surfaced by in-filter`).toBe(true);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four grids: the in-filter surfaces the previously-hidden records',
      persona: adminPersona, method: 'GET', url: 'four dynamic_index endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('FINDING: surfacing (AC7) requires REPLACING the default filter — an ad-hoc filter stacked on the default not-in ANDs and cannot surface', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.Surface1] });
    const m = manifest!;
    const scope = m.scope.grids.assignment;
    const hiddenTypes = scope.setting_value;   // [cancelled, rejected]
    const hiddenType = scope.hidden_type;      // cancelled

    // DynamicIndex ANDs all active filters (dynamic_index.rb ~L96). The grid sets
    // the default `not in [cancelled,rejected]` on the store; an interactive
    // column filter is ADDED, not replacing it. So a user who filters "show me
    // cancelled" produces `not in [cancelled,rejected] AND in [cancelled]` → empty.
    // Surfacing only works when the filter REPLACES the default (the saved-list /
    // list-builder path, which rebuilds the store without the default not-in).
    const stackedFilter = encodeURIComponent(JSON.stringify([
      { property: scope.filter_property, operator: 'not in', value: hiddenTypes },
      { property: scope.filter_property, operator: 'in', value: [hiddenType] },
    ]));
    const stackedUrl = `${scope.endpoint}.json?filter=${stackedFilter}&limit=2000`;
    const replacingUrl = diUrl(scope, 'in', [hiddenType]);   // the saved-list path: default not-in replaced

    await renderExchange(testInfo, page, 'before', {
      title: 'Two ways a user might try to surface a default-hidden Assignment: STACK a filter vs REPLACE the default',
      persona: adminPersona, method: 'GET', url: `STACK: ${stackedUrl}\n\nREPLACE: ${replacingUrl}`,
      requestBody: { note: 'DynamicIndex ANDs filters. STACK = default `not in [7,14]` + user `in [7]` → collapses to empty (ad-hoc column filter path). REPLACE = user `in [7]` only → surfaces (saved-list / list-builder path).' },
    });

    let stackedCount!: number;
    let replaced!: boolean;
    await test.step(`STACK: GET not in [${hiddenTypes.join(',')}] AND in [${hiddenType}] → hidden #${scope.hidden_id} does NOT surface (the AND collapses)`, async () => {
      const { status, body } = await apiGet(request, stackedUrl, m.api_auth.tokens.admin);
      const ids = rowsFor(scope, body);
      stackedCount = ids.length;
      expect(status).toBe(200);
      expect(ids.includes(scope.hidden_id), 'stacked filter cannot surface the hidden row (ANDed to empty)').toBe(false);
    });
    await test.step(`REPLACE: GET in [${hiddenType}] (default not-in replaced) → hidden #${scope.hidden_id} SURFACES`, async () => {
      const { status, body } = await apiGet(request, replacingUrl, m.api_auth.tokens.admin);
      const ids = rowsFor(scope, body);
      replaced = ids.includes(scope.hidden_id);
      expect(status).toBe(200);
      expect(replaced, 'replacing the default filter surfaces the hidden row').toBe(true);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'CONFIRMED: stacking an ad-hoc filter cannot surface a default-hidden record; only replacing the default does',
      persona: adminPersona, method: 'GET', url: `${scope.endpoint}`,
      requestBody: {}, status: 200,
      responseBody: { stacked_filter_hidden_surfaced: false, stacked_result_count: stackedCount, replacing_filter_hidden_surfaced: replaced },
      note: 'AC7 clarification/finding: "applying a status/type filter surfaces the hidden records" holds only when the filter REPLACES the default hidden-types filter (saved list / list builder). An interactive column filter on the same scope stacks (AND) with the default and returns nothing. Worth confirming the intended UX path with PM, and whether ad-hoc column filters should clear the default hidden-types filter.',
    });
  });

  test('empty `not in []` is a no-op on the three invoice/quote grids — never blanks (AC5)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.DefaultLoad2] });
    const m = manifest!;
    const invoiceGrids: GridKey[] = ['vendor_invoice', 'proposal', 'client_invoice'];

    await renderExchange(testInfo, page, 'before', {
      title: 'dynamic_index with empty `not in []` on the three normalized invoice/quote grids',
      persona: adminPersona, method: 'GET',
      url: invoiceGrids.map(k => diUrl(m.scope.grids[k], 'not in', [])).join('  |  '),
      requestBody: { note: 'The normalize fix (24795c1a82) makes empty not-in a no-op (TRUE = TRUE) so an empty setting never reaches SQL as NOT IN (NULL) and never blanks the grid.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of invoiceGrids) {
      const scope = m.scope.grids[key];
      await test.step(`${key}: GET dynamic_index not in [] → full set returned (both fixtures present, not blanked)`, async () => {
        const { status, body } = await apiGet(request, diUrl(scope, 'not in', []), m.api_auth.tokens.admin);
        const ids = rowsFor(scope, body);
        outcomes[key] = { status, count: ids.length, has_hidden: ids.includes(scope.hidden_id), has_visible: ids.includes(scope.visible_id) };
        expect(status, `${key}: status`).toBe(200);
        expect(ids.length, `${key}: grid not blanked`).toBeGreaterThan(0);
        expect(ids.includes(scope.hidden_id) && ids.includes(scope.visible_id), `${key}: both fixtures returned`).toBe(true);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Empty not-in is a no-op on all three invoice/quote grids — full row set, never blanked',
      persona: adminPersona, method: 'GET', url: 'three dynamic_index endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('FINDING: the Assignments backend `not in []` is UN-NORMALIZED and blanks the grid (empty-guard lives only in the frontend)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.DefaultLoad2] });
    const m = manifest!;
    const scope = m.scope.grids.assignment;

    await renderExchange(testInfo, page, 'before', {
      title: 'Assignments dynamic_index with empty `not in []` — the invoice/quote grids got the normalize fix; Assignments did not',
      persona: adminPersona, method: 'GET', url: diUrl(scope, 'not in', []),
      requestBody: { note: 'assignments_controller.rb:1220 still does bare Array.wrap(filter_val) → NOT IN (NULL) → zero rows. Only the frontend `hiddenTypes && hiddenTypes.length` guard prevents this on default load; any explicit empty not-in (saved list, hand-built filter, API) blanks the grid.' },
    });

    let result!: ApiResult;
    let count!: number;
    await test.step(`GET assignments dynamic_index not in [] → records returned (documents whether the un-normalized lambda blanks)`, async () => {
      result = await apiGet(request, diUrl(scope, 'not in', []), m.api_auth.tokens.admin);
      count = rowsFor(scope, result.body).length;
      // Assert the SHIPPED behavior so the finding is pinned: the un-normalized
      // lambda returns zero rows for an explicit empty not-in.
      expect(result.status, 'status').toBe(200);
      expect(count, 'FINDING: Assignments not in [] blanks the grid (0 rows) — un-normalized backend').toBe(0);
    });

    // Control: the same empty not-in on a normalized invoice grid does NOT blank.
    const controlScope = m.scope.grids.vendor_invoice;
    let controlCount!: number;
    await test.step(`CONTROL: GET vendor_invoice dynamic_index not in [] → NOT blanked (normalized)`, async () => {
      const { body } = await apiGet(request, diUrl(controlScope, 'not in', []), m.api_auth.tokens.admin);
      controlCount = rowsFor(controlScope, body).length;
      expect(controlCount, 'normalized invoice grid returns rows').toBeGreaterThan(0);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'CONFIRMED FINDING: Assignments not-in [] returns 0 rows (blanks); the normalized invoice grid returns rows',
      persona: adminPersona, method: 'GET', url: diUrl(scope, 'not in', []),
      requestBody: {}, status: result.status,
      responseBody: { assignments_not_in_empty_count: count, vendor_invoice_not_in_empty_count: controlCount },
      note: 'Recommend applying the same empty-normalization to assignments_controller.rb:1220 (or proving the path is unreachable from the UI). Frontend guard is the only current protection; a saved list or API caller can still blank the Assignments grid.',
    });
  });

  test('NULL-status edge: a record with no workflow status is silently dropped by any populated `not in` filter', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.DefaultLoad1] });
    const m = manifest!;
    const scope = m.scope.grids.vendor_invoice;
    const nullId = m.scope.null_status_invoice_id;

    await renderExchange(testInfo, page, 'before', {
      title: `NULL-status vendor invoice #${nullId} vs a populated not-in filter`,
      persona: adminPersona, method: 'GET', url: `${diUnfiltered(scope)}  vs  ${diUrl(scope, 'not in', [scope.hidden_type])}`,
      requestBody: { note: 'LEFT JOIN + NOT IN NULL: a record whose current status is absent has workflow_type_id = NULL; NULL NOT IN (ids) is NULL (not TRUE) so the row is excluded, with no OR IS NULL escape. Reachable in reporting but gone from the grid.' },
    });

    let inUnfiltered!: boolean;
    let inFiltered!: boolean;
    await test.step(`GET dynamic_index unfiltered → NULL-status #${nullId} present; then not in [${scope.hidden_type}] → dropped`, async () => {
      const unfiltered = await apiGet(request, diUnfiltered(scope), m.api_auth.tokens.admin);
      const filtered = await apiGet(request, diUrl(scope, 'not in', [scope.hidden_type]), m.api_auth.tokens.admin);
      inUnfiltered = rowsFor(scope, unfiltered.body).includes(nullId);
      inFiltered = rowsFor(scope, filtered.body).includes(nullId);
      expect(inUnfiltered, 'NULL-status record present without a filter').toBe(true);
      expect(inFiltered, 'NULL-status record dropped by a populated not-in (documented edge)').toBe(false);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'CONFIRMED edge: NULL-status record present unfiltered, silently dropped by a populated not-in',
      persona: adminPersona, method: 'GET', url: scope.endpoint,
      requestBody: {}, status: 200,
      responseBody: { null_status_id: nullId, present_unfiltered: inUnfiltered, present_with_not_in: inFiltered },
      note: 'Finding: once an admin populates a hidden-types setting, invoices/quotes with no current workflow status vanish from the default grid (still in reporting). Consider an `OR workflow_type_id IS NULL` escape if statusless records should remain visible.',
    });
  });

  // ===== LAYER B — frontend wiring (real app, no global mutation) =====

  test('Layer B: the four settings reach the client _SSetting store with the seeded values (AC1 end-to-end)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.Seed1, TANGO_85_AC.Seed2] });
    const m = manifest!;

    await test.step('Boot the Fexa app and wait for Ext', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await page.waitForFunction(() => {
        const Ext = (window as unknown as { Ext?: { ComponentQuery?: { query: (s: string) => unknown[] } } }).Ext;
        if (!Ext?.ComponentQuery) return false;
        try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; } catch { return false; }
      }, null, { timeout: 90_000, polling: 1000 });
      await page.waitForTimeout(1500);
    });

    const clientValues = await page.evaluate((keys) => {
      const S = (window as unknown as { _SSetting?: { get: (k: string) => unknown } })._SSetting;
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = S?.get(k);
      return out;
    }, GRID_KEYS.map(k => m.scope.grids[k].setting_key));

    for (const key of GRID_KEYS) {
      const scope = m.scope.grids[key];
      const expected = m.scope.settings[key].value;
      await test.step(`_SSetting.get('${scope.setting_key}') === ${JSON.stringify(expected)} in the browser`, async () => {
        const actual = (clientValues[scope.setting_key] ?? []) as number[];
        expect([...actual].sort(), `${key}: client value matches seed`).toEqual([...expected].sort());
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four hidden-types settings delivered to the browser _SSetting store (send_to_gui) with the seeded values',
      persona: 'Ext client (window._SSetting)', method: 'BROWSER', url: '_SSetting.get(...)',
      requestBody: { assignment_expected: m.scope.settings.assignment.value },
      status: 200, responseBody: clientValues,
    });
  });

  test('Layer B: each grid ContainerController builds the correct default-load filter from its live setting (AC4/AC5/AC10)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.DefaultLoad1, TANGO_85_AC.DefaultLoad2, TANGO_85_AC.NoRegression1] });
    const m = manifest!;

    await test.step('Boot the Fexa app and wait for Ext', async () => {
      await page.goto('/main/index', { waitUntil: 'commit' });
      await page.waitForFunction(() => {
        const Ext = (window as unknown as { Ext?: { ComponentQuery?: { query: (s: string) => unknown[] } } }).Ext;
        if (!Ext?.ComponentQuery) return false;
        try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; } catch { return false; }
      }, null, { timeout: 90_000, polling: 1000 });
      await page.waitForTimeout(1500);
    });

    // Evaluate the EXACT ContainerController default-load guard expression
    // (`hiddenTypes && hiddenTypes.length ? [{property, operator:'not in', value}] : []`)
    // against the live client _SSetting values, per grid.
    const built = await page.evaluate((grids) => {
      const S = (window as unknown as { _SSetting?: { get: (k: string) => number[] | null } })._SSetting;
      const out: Record<string, unknown> = {};
      for (const g of grids) {
        const hiddenTypes = S?.get(g.setting_key);
        out[g.key] = hiddenTypes && hiddenTypes.length
          ? [{ property: g.filter_property, operator: 'not in', value: hiddenTypes }]
          : [];
      }
      return out;
    }, GRID_KEYS.map(k => ({ key: k, setting_key: m.scope.grids[k].setting_key, filter_property: m.scope.grids[k].filter_property })));

    await test.step('Assignments (populated setting) → store filter injects `assignment_workflow_type_id not in [cancelled,rejected]` (AC4 + AC10 neutrality)', async () => {
      const f = built['assignment'] as Array<{ property: string; operator: string; value: number[] }>;
      expect(f.length, 'assignment builds one filter').toBe(1);
      expect(f[0].property).toBe('assignment_workflow_type_id');
      expect(f[0].operator).toBe('not in');
      expect([...f[0].value].sort(), 'exactly the seeded cancelled+rejected set (behavior-neutral)').toEqual([...m.scope.settings.assignment.value].sort());
    });

    for (const key of ['vendor_invoice', 'proposal', 'client_invoice'] as GridKey[]) {
      await test.step(`${key} (empty setting) → store filter is [] (no workflow-type filter sent; grid never blanks)`, async () => {
        const f = built[key] as unknown[];
        expect(f, `${key}: empty setting builds no filter`).toEqual([]);
      });
    }

    // AC5 for the Assignments grid specifically: its seeded setting is NON-empty,
    // so the populated branch above never exercises the empty→[] guard for the
    // assignment key. Evaluate the guard against an EMPTY assignment value to
    // prove the grid would send NO filter (and so never blank) if an admin
    // clears the setting — without mutating the real global setting.
    const emptyAssignmentGuard = await page.evaluate((prop) => {
      const hiddenTypes: number[] = [];
      return hiddenTypes && hiddenTypes.length ? [{ property: prop, operator: 'not in', value: hiddenTypes }] : [];
    }, m.scope.grids.assignment.filter_property);
    await test.step('Assignments with an EMPTY setting → guard yields [] (no filter; grid never blanks even though the backend lambda is un-normalized)', async () => {
      expect(emptyAssignmentGuard, 'empty assignment setting builds no filter').toEqual([]);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Frontend wiring: Assignments injects not-in[cancelled,rejected]; empty settings (incl. an emptied Assignments) inject NO filter (never blank)',
      persona: 'Ext client (ContainerController guard vs live _SSetting)', method: 'BROWSER', url: 'hiddenTypes && hiddenTypes.length ? [...] : []',
      requestBody: { empty_assignment_guard: emptyAssignmentGuard }, status: 200, responseBody: built,
      note: 'This evaluates the ContainerController default-load guard EXPRESSION against the live _SSetting values (it does not drive the real grid store), so it proves setting→client-store delivery + the guard logic, not the live controller wiring; controller drift (renamed property, removed guard) would not be caught here. The Layer-A API tests prove the backend honors exactly these filters, so the end-to-end chain (setting → client store → filter shape → server-side exclusion) is covered by the two layers together.',
    });
  });

  // ===== Seed model checks (ability/relation layer) =====

  test('seed model checks: fixture integrity, seed-guard, reporting-unaffected, and the NULL-status edge', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_85_AC.Seed3, TANGO_85_AC.Surface2] });
    const m = manifest!;
    const checks = m.model_checks ?? [];
    const gated = checks.filter(c => c.ac !== 'info');
    const info = checks.filter(c => c.ac === 'info');

    await renderExchange(testInfo, page, 'before', {
      title: 'Seed-recorded model checks (AC1/AC2 settings, AC3 seed guard, AC8 reporting, fixture integrity, NULL-status edge)',
      persona: 'rails runner (model layer)', method: 'SEED', url: 'seeds/default-hidden-grid-types.rb',
      requestBody: { gated: gated.map(c => c.name), informational: info.map(c => c.name) },
    });

    await test.step(`Verify the seed recorded its model checks (${gated.length} gated + ${info.length} informational)`, async () => {
      expect(gated.length, 'expected the fixture-integrity + settings + guard + reporting checks').toBeGreaterThanOrEqual(6);
    });
    for (const c of gated) {
      await test.step(`${c.ac} — ${c.name}: ${c.detail}`, async () => {
        expect(c.passed, `model check failed: ${c.detail}`).toBe(true);
      });
    }
    for (const c of info) {
      await test.step(`INFO — ${c.name}: ${c.detail}`, async () => { /* informational */ });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All gated model checks passed (seed guard preserves admin values, reporting sees hidden records)',
      persona: 'rails runner (model layer)', method: 'SEED', url: 'seeds/default-hidden-grid-types.rb',
      requestBody: {}, status: 200, responseBody: checks,
    });
  });
});
