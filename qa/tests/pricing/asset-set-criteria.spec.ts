import { test, expect, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_65_AC } from '../../src/support/qa-report';

/**
 * Asset as a product-pricing set-criteria field — TANGO-65.
 *
 * CS escalation (Cushman & Wakefield, flagged at risk of leaving Fexa; CSM
 * Christina Schechter). Two assets of the same type at the same facility carry
 * different contracted rates and no pre-existing criteria combination could
 * disambiguate them.
 *
 * TWO TRACKS, because the AC splits cleanly along that line:
 *
 *   TRACK A — GUI (this file's browser tests). Configuration #1/#1a/#2/#3 are
 *   claims about what the pricing configuration modals and the pricings grid
 *   render, so they are proven here by driving the real Ext side edit menu and
 *   the real grid on both admin screens.
 *
 *   TRACK B — model layer (seeds/asset-pricing-criterion.rb, asserted here from
 *   reports/seed-manifest-tango-65.json). Matching #1/#2/#4 and Edge #1/#2 are
 *   numeric outcomes — WHICH RATE WINS — not visual states. A screenshot cannot
 *   prove that an asset-scoped rule outranked a product-scoped one. The seed
 *   creates real line items inside rolled-back transactions and records the
 *   resolved unit_price for each scenario; these tests assert those results and
 *   the reporter renders them as evidence.
 *
 * The GUI matching arm (asset-scoped rate resolving in the line-item form, and
 * the two preview regressions) runs on invoice 24 rather than invoice 23:
 * `enforcement_reevaluatable?` and the price preview only re-resolve on an
 * invoice that is not approved/completed, and invoice 23 is closed. Verified as
 * pre-existing behavior — a control run with a NON-asset-scoped enforced rule on
 * invoice 23 behaved identically, so it is not a TANGO-65 regression.
 *
 * DELIBERATELY NOT TESTED — the ticket puts the duplicate-warning extension
 * ("extend to client pricings", "if the asset has another pricing that is active
 * we would flag as duplicate") explicitly out of scope.
 *
 * KNOWN EVIDENCE LIMIT — Configuration #3 covers import/export keys. These tests
 * prove the template downloads, the export completes, and the grid's Asset
 * column round-trips a bound asset, but they do NOT read spreadsheet cell
 * contents. Kevin's merged test/services/importers/products/
 * product_pricing_asset_key_test.rb covers the key contents.
 *
 * Pre-requisite: `npm run seed:asset-pricing-criterion`.
 */

const TICKET = 'TANGO-65';

// --- Manifest --------------------------------------------------------------
// Asset and pricing ids are re-created on every seed run, so everything is read
// from the manifest rather than hardcoded. Hardcoding would silently test the
// wrong records after a re-seed.

interface ModelCheck {
  ac: string;
  scenario: string;
  name: string;
  unit_price: number | null;
  expected_unit_price: number | null;
  matched_pricing_id?: number | null;
  expected_pricing_id?: number | null;
  enforced?: boolean | null;
  error?: string | null;
  passed: boolean;
  detail: string;
  /** Recorded by the seed on the enforcement tamper check. */
  enforcement_reevaluatable?: boolean | null;
  [k: string]: unknown;
}

interface SeedAsset {
  id: number;
  name: string;
  state: string;
  facility_id: number;
  active: boolean;
  deleted: boolean;
}

interface Manifest {
  ticket: string;
  scope: {
    facility: { id: number; name: string };
    assets: SeedAsset[];
    products: { probe: { id: number; name: string }; enforced: { id: number; name: string } };
    gui_arm: {
      invoice_id: number;
      product_id: number;
      asset_id: number;
      asset_rate: number;
      fallback_rate: number;
      enforced_product_id: number;
      enforced_rate: number;
    };
    precedence: Record<string, { asset_index: number; product_index: number; asset_outranks_product: boolean }>;
    workorder_asset_ids: number[];
    edge2_discriminating: boolean;
  };
  generated_at: string;
  observations?: {
    inactive_asset_still_matches?: {
      resolved_unit_price: number | null;
      inactive_asset_rule_rate: number;
      non_asset_fallback_rate: number;
      mechanism: string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  fixtures: Array<{ id: number; name: string; kind: string; asset_group_id: number | null; asset_name: string | null }>;
  model_checks: ModelCheck[];
}

const MANIFEST_PATH = path.resolve(process.cwd(), 'reports', 'seed-manifest-tango-65.json');

function loadManifest(): Manifest {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as Manifest;
}

const manifest = loadManifest();

function assetByState(state: string): SeedAsset {
  const found = manifest.scope.assets.filter((a) => a.state === state);
  if (!found.length) throw new Error(`No seeded asset in state "${state}" — re-run the seed.`);
  return found[0];
}

function assetByName(fragment: string): SeedAsset {
  const found = manifest.scope.assets.find((a) => a.name.includes(fragment));
  if (!found) throw new Error(`No seeded asset matching "${fragment}" — re-run the seed.`);
  return found;
}

function checkFor(scenario: string): ModelCheck {
  const c = manifest.model_checks.find((m) => m.scenario === scenario);
  if (!c) throw new Error(`Model check "${scenario}" missing from the manifest — re-run the seed.`);
  return c;
}

function fixtureByName(fragment: string) {
  const f = manifest.fixtures.find((x) => x.name.includes(fragment));
  if (!f) throw new Error(`No seeded pricing matching "${fragment}" — re-run the seed.`);
  return f;
}

const ASSET_NORTH    = assetByName('Rooftop HVAC North');
const ASSET_SOUTH    = assetByName('Rooftop HVAC South');
const ASSET_INACTIVE = assetByState('inactive');
const ASSET_DELETED  = assetByState('soft-deleted');
const ASSET_EAST     = assetByName('Rooftop HVAC East');
const GUI            = manifest.scope.gui_arm;
const LABOR_CLASSIFICATION_ID = 1;

// The Asset criterion field's `name` in the side edit menu, and the Asset
// filter's `property` at the top of the grid. The filter is TABLE-QUALIFIED on
// purpose: object_assets has its own asset_group_id column (an AssetGroup
// template FK) while product_pricings.asset_group_id holds an ObjectAsset id,
// and the index eager-loads :object_asset — unqualified, Postgres raises
// PG::AmbiguousColumn (the 500 fixed by 013552eb76).
const ASSET_FIELD_NAME  = 'asset_group_id';
const ASSET_FILTER_PROP = 'product_pricings.asset_group_id';
const ENFORCEMENT_FIELD = 'prevent_price_modification';

// --- Helpers (idioms proven by tests/pricing/enforcement-toggle.spec.ts and
// tests/pricing/enforced-rate.spec.ts — reused, not reinvented) -------------

async function waitForFexaApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; }
    catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(2000);
}

type PricingCtype = 'subcontractorproductpricings' | 'clientproductpricings';

async function gotoPricingsGrid(page: Page, ctype: PricingCtype): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((c) => { (window as any).Ext.History.add(c); }, ctype);
    try {
      await page.waitForFunction(
        () => (window as any).Ext.ComponentQuery.query('accountingpricinggrid').length > 0,
        null, { timeout: 30_000 },
      );
      await page.waitForTimeout(2500);
      return;
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  throw new Error(`gotoPricingsGrid: ${ctype} grid never mounted after 3 attempts`);
}

/**
 * Deep-link a Client or Vendor record and open its Pricings tab, which mounts
 * the SAME accountingpricinggrid as the admin screens.
 *
 * The tab is lazily instantiated: navigating to the record alone never creates
 * the grid, so the tab has to be activated first. That is why a plain
 * History.add + wait-for-grid silently fails on these two surfaces.
 */
async function gotoRecordPricingsTab(
  page: Page,
  ctype: 'client' | 'vendor',
  id: number,
): Promise<{ reached: boolean; detail: string }> {
  const pricingsXtype = ctype === 'client' ? 'clientpricings' : 'vendorpricings';

  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);

  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(({ c, i }) => { (window as any).Ext.History.add(`${c}/${i}`); }, { c: ctype, i: id });

    // Wait for the record view itself.
    try {
      await page.waitForFunction(
        (x) => (window as any).Ext.ComponentQuery.query(x).some((v: any) => v.isVisible?.()),
        ctype, { timeout: 30_000 },
      );
    } catch {
      await page.waitForTimeout(2000);
      continue;
    }
    await page.waitForTimeout(2500);

    // Activate the Pricings tab so its grid is instantiated. The tab is a lazy,
    // permission-gated item (`launchLoad: 'Pricings'`, `permissible` on
    // Products::*ProductPricing), so the pane does NOT exist as a component
    // until it is selected — querying for its xtype first always misses. Find
    // the tab by its config instead and activate it through its container.
    const activated = await page.evaluate(({ x, rec }) => {
      const Ext = (window as any).Ext;
      const record = Ext.ComponentQuery.query(rec).filter((v: any) => v.isVisible?.())[0]
        || Ext.ComponentQuery.query(rec)[0];
      if (!record) return 'no record view';

      // Already instantiated?
      const existing = Ext.ComponentQuery.query(x)[0];
      const container = existing?.getParent?.()
        || record.query?.('*').find((c: any) => typeof c.setActiveItem === 'function' && (c.getItems?.()?.items || []).some((i: any) => i.xtype === x || i.launchLoad === 'Pricings'))
        || (typeof record.setActiveItem === 'function' ? record : null);
      if (!container) return 'no container holding the pricings tab';

      const items = container.getItems?.()?.items || [];
      const target = items.find((i: any) => i.xtype === x || i.launchLoad === 'Pricings');
      if (!target) return `pricings tab not among ${items.length} items: ${items.map((i: any) => i.xtype).join(',')}`;
      try { container.setActiveItem(target); return 'activated via container'; }
      catch (e) { return `setActiveItem threw: ${e}`; }
    }, { x: pricingsXtype, rec: ctype });

    // Fall back to clicking the tab by its rendered label.
    if (!activated.startsWith('activated')) {
      const tab = page.locator('.x-tab, .x-listitem, .x-button').filter({ hasText: /^Pricings$/ }).first();
      try {
        await tab.waitFor({ state: 'visible', timeout: 8_000 });
        await tab.click();
      } catch { /* leave the failure to the grid wait below */ }
    }

    try {
      await page.waitForFunction(
        () => (window as any).Ext.ComponentQuery.query('accountingpricinggrid').length > 0,
        null, { timeout: 30_000 },
      );
      await page.waitForTimeout(3000);
      return { reached: true, detail: `tab activation: ${activated}` };
    } catch {
      if (attempt === 2) return { reached: false, detail: `tab activation: ${activated}; grid never mounted` };
      await page.waitForTimeout(2000);
    }
  }
  return { reached: false, detail: 'record view never became visible' };
}

async function openNewPricingForm(page: Page): Promise<void> {
  const rect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery.query('button[reference=createItemBtn]')[0];
    const el = btn?.element?.dom;
    el?.scrollIntoView?.({ block: 'center' });
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!rect) throw new Error('createItemBtn not found');
  await page.mouse.click(rect.x, rect.y);
  await page.waitForFunction(
    () => (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.()),
    null, { timeout: 10_000 },
  );
  await page.waitForTimeout(1000);
}

async function openPricingForEdit(page: Page, name: string): Promise<void> {
  const row = page.locator('.x-gridrow').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.locator('.x-gridcell').first().dblclick();
  await page.waitForFunction(
    () => (window as any).Ext.ComponentQuery.query('sideeditmenu').some((m: any) => m.isVisible?.()),
    null, { timeout: 10_000 },
  );
  await page.waitForTimeout(800);
}

async function clickCancel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    Ext.ComponentQuery.query('button[reference=cancelButton]')[0]?.element?.dom?.click?.();
  });
  await page.waitForTimeout(500);
}

interface FieldState {
  exists: boolean;
  visible?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  value?: unknown;
  label?: string;
  xtype?: string;
  displayText?: string;
}

/** Read a field's state from the open side edit menu. */
async function readMenuField(page: Page, name: string): Promise<FieldState> {
  return await page.evaluate((fieldName) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu').filter((m: any) => m.isVisible?.())[0]
      || Ext.ComponentQuery.query('sideeditmenu')[0];
    if (!menu) return { exists: false };
    const f = menu.query(`[name=${fieldName}]`)[0];
    if (!f) return { exists: false };
    const inputEl = f.element?.dom?.querySelector?.('input');
    return {
      exists: true,
      visible: !!f.isVisible?.(),
      disabled: !!f.getDisabled?.(),
      hidden: !!f.getHidden?.(),
      value: f.getValue?.() ?? null,
      label: f.getLabel?.() || f.getFieldLabel?.() || f.fieldLabel || f.label,
      xtype: f.xtype,
      // What the user actually SEES in the combo — this is the part that must
      // stay blank for an asset the picker would exclude.
      displayText: inputEl?.value ?? '',
    };
  }, name);
}

/** Resolve an Ext menu field to a Playwright Locator so snapshot `focus` is real. */
async function menuFieldLocator(page: Page, name: string): Promise<Locator> {
  const id = await page.evaluate((n) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu').filter((m: any) => m.isVisible?.())[0]
      || Ext.ComponentQuery.query('sideeditmenu')[0];
    const f = menu?.query?.(`[name=${n}]`)[0];
    return f?.element?.dom?.id || f?.id;
  }, name);
  if (!id) throw new Error(`menuFieldLocator: no field name="${name}" in the side edit menu`);
  return page.locator(`#${id}`);
}

interface PickerQueryResult {
  ok: boolean;
  reason?: string;
  url?: string;
  filters?: Array<Record<string, unknown>>;
  status?: number;
  total?: number | null;
  pageSize?: number | null;
  rootProperty?: string;
  rows?: Array<{ id: number; name: string; active: boolean; deleted: boolean }>;
}

/**
 * Load the Asset picker's own store through its own proxy with its own
 * configured filters. This exercises the REAL endpoint with the REAL picker
 * filters rather than a hand-built request, so a missing active/deleted filter
 * would show up here.
 *
 * `extraFilters` appends to (never replaces) the store's filters — used for the
 * by-id arm, which mirrors InfiniteComboField#loadTillValue when
 * lookupHonorsStoreFilters is on.
 *
 * NOTE on why there is no name/typeahead filter: the simple_list endpoint treats
 * a plain `{property, value}` name filter as an EXACT match, not a LIKE (probed
 * directly: "[QA] TANGO-65" returns 0 rows while the full unfiltered load
 * returns every asset). Since the store's pageSize (100) exceeds the total
 * active asset count, one unfiltered page returns them all — and the test
 * asserts total <= pageSize so an absence can never be a paging artifact.
 */
async function queryAssetPicker(
  page: Page,
  fieldName: string,
  extraFilters: Array<Record<string, unknown>> = [],
): Promise<PickerQueryResult> {
  return await page.evaluate(async ({ n, extra }) => {
    const Ext = (window as any).Ext;
    const menu = Ext.ComponentQuery.query('sideeditmenu').filter((m: any) => m.isVisible?.())[0]
      || Ext.ComponentQuery.query('sideeditmenu')[0];
    const field = menu?.query?.(`[name=${n}]`)[0];
    if (!field) return { ok: false, reason: 'field not found' };
    const store = field.getStore?.();
    if (!store) return { ok: false, reason: 'field has no store' };

    const proxy = store.getProxy?.();
    const url   = proxy?.url;
    // Read the reader's root off the proxy rather than guessing — this store
    // roots its payload at "object_assets", not "data".
    const rootProperty = proxy?.getReader?.()?.getRootProperty?.() || 'object_assets';

    const filters: any[] = [];
    store.getFilters?.()?.each?.((f: any) => {
      const entry: any = { property: f.getProperty(), value: f.getValue() };
      const op = f.getOperator?.();
      if (op) entry.operator = op;
      filters.push(entry);
    });
    for (const e of extra) filters.push(e);

    const resp = await new Promise<any>((resolve) => {
      Ext.Ajax.request({
        url,
        method: 'GET',
        params: { filter: JSON.stringify(filters), limit: store.getPageSize?.() || 100 },
        success: (r: any) => resolve({ status: r.status, text: r.responseText }),
        failure: (r: any) => resolve({ status: r.status, text: r.responseText }),
      });
    });

    let rows: Array<{ id: number; name: string; active: boolean; deleted: boolean }> = [];
    let total: number | null = null;
    try {
      const body = JSON.parse(resp.text);
      total = body.total_count ?? null;
      rows = (body[rootProperty] || []).map((r: any) => ({
        id: r.id, name: r.name, active: !!r.active, deleted: !!r.deleted,
      }));
    } catch { /* status + empty rows are asserted by the caller */ }

    return {
      ok: true, url, filters, status: resp.status, total,
      pageSize: store.getPageSize?.() ?? null, rootProperty, rows,
    };
  }, { n: fieldName, extra: extraFilters });
}

interface AssetCell {
  id: number | null;
  name: string;
  /** Mirrors the column renderer: the bound asset's name, or '*' when unscoped. */
  asset: string;
  assetId: number | null;
}

/** Read the grid's Asset column config + the rendered cell text per row. */
async function readAssetColumn(page: Page) {
  return await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    if (!grid) return { exists: false, cells: [] as AssetCell[] };
    const col = grid.getHeaderContainer?.()
      ?.getVisibleColumns?.()
      ?.find?.((c: any) => c.getDataIndex?.() === 'asset_group_id');
    if (!col) return { exists: false, cells: [] as AssetCell[] };

    const colIndex = grid.getHeaderContainer().getVisibleColumns().indexOf(col);

    // This grid is `infinite: true`, so its store is a VIRTUAL store: records
    // live in a paged map, and the plain Store accessors (each/getRange with no
    // args/getData().items) all come back empty even when getCount() reports
    // rows. Walk the loaded pages explicitly, falling back through the simpler
    // accessors for any surface where the store is an ordinary one.
    const store = grid.getStore?.();
    const count = store?.getCount?.() ?? 0;
    let records: any[] = [];
    let strategy = 'none';

    const tryStrategy = (label: string, fn: () => any[]) => {
      if (records.length) return;
      try {
        const out = (fn() || []).filter(Boolean);
        if (out.length) { records = out; strategy = label; }
      } catch { /* try the next one */ }
    };

    tryStrategy('getRange(0,count-1)', () => (count ? store.getRange(0, count - 1) : []));
    tryStrategy('getAt loop', () => {
      const acc: any[] = [];
      for (let i = 0; i < count; i++) { const r = store.getAt?.(i); if (r) acc.push(r); }
      return acc;
    });
    tryStrategy('data.each', () => {
      const acc: any[] = [];
      store.getData?.()?.each?.((r: any) => { acc.push(r); });
      return acc;
    });
    tryStrategy('data.getValues', () => store.getData?.()?.getValues?.() || []);
    tryStrategy('data.items', () => store.getData?.()?.items || []);
    tryStrategy('store.each', () => {
      const acc: any[] = [];
      store.each?.((r: any) => { acc.push(r); });
      return acc;
    });

    const cells = records.map((rec: any) => {
      const oa = rec?.get?.('object_asset') ?? rec?.data?.object_asset;
      const assetId = rec?.get?.('asset_group_id') ?? rec?.data?.asset_group_id;
      return {
        id: rec?.get?.('id') ?? rec?.data?.id ?? null,
        name: rec?.get?.('name') ?? rec?.data?.name ?? '',
        // Mirrors the column renderer: object_asset.name when bound, else '*'.
        asset: assetId && oa ? oa.name : '*',
        assetId: assetId ?? null,
      };
    });

    return {
      exists: true,
      text: col.getText?.(),
      hidden: !!col.getHidden?.(),
      colIndex,
      storeCount: store?.getCount?.() ?? null,
      storeTotal: store?.getTotalCount?.() ?? null,
      strategy,
      cells,
    };
  });
}

/**
 * Apply the top-of-grid Asset filter and capture the resulting index request's
 * HTTP status. A pre-fix build raises PG::AmbiguousColumn → 500.
 */
async function applyAssetFilterAndCaptureStatus(page: Page, assetId: number): Promise<{ statuses: number[]; applied: boolean }> {
  const statuses: number[] = [];
  const listener = (resp: any) => {
    const u = resp.url();
    if (/product_pricings|client_product_pricings|subcontractor_product_pricings/.test(u)) {
      statuses.push(resp.status());
    }
  };
  page.on('response', listener);

  const applied = await page.evaluate(({ prop, id }) => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
    if (!grid) return false;
    const store = grid.getStore();
    if (!store) return false;
    // Filter exactly the way the grid's own Asset filter field does: on the
    // TABLE-QUALIFIED property.
    store.addFilter({ property: prop, value: id });
    store.load();
    return true;
  }, { prop: ASSET_FILTER_PROP, assetId, id: assetId } as any);

  await page.waitForTimeout(6000);
  page.off('response', listener);
  return { statuses, applied };
}

// --- Line-item form helpers (invoice track) --------------------------------

async function gotoInvoice(page: Page, id: number): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate((i) => { (window as any).Ext.History.add(`invoice/${i}`); }, id);
    try {
      await page.waitForFunction(
        () => (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0,
        null, { timeout: attempt === 0 ? 45_000 : 30_000 },
      );
      await page.waitForTimeout(2500);
      return;
    } catch {
      await page.waitForTimeout(1500);
    }
  }
  throw new Error(`gotoInvoice: lineitemgrid never appeared after 5 attempts (invoice/${id})`);
}

async function openNewLineItemForm(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
      if (form?.isVisible?.()) form.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
    });
    await page.waitForTimeout(500);

    const rect = await page.evaluate(() => {
      const btn = (window as any).Ext.ComponentQuery.query('button[reference=createLineItemBtn]')[0];
      const el = btn?.element?.dom;
      el?.scrollIntoView?.({ block: 'center' });
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (!rect) throw new Error('createLineItemBtn not found');
    await page.waitForTimeout(400);
    await page.mouse.click(rect.x, rect.y);
    try {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
        const saveBtn = Ext.ComponentQuery.query('button[reference=saveLineItemBtn]').some((b: any) => b.isVisible?.());
        const pf = form?.query?.('[name=product_id]')[0];
        return saveBtn && pf && pf.isVisible?.();
      }, null, { timeout: 25_000 });
      await page.waitForTimeout(2500);
      return;
    } catch { /* retry */ }
  }
  throw new Error('openNewLineItemForm: failed to open form after 3 attempts');
}

async function selectProduct(page: Page, productId: number, classificationId: number): Promise<void> {
  await page.evaluate((cid) => {
    const Ext = (window as any).Ext;
    const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    form?.query?.('[name="product.product_classification_id"]')[0]?.setValue(cid);
  }, classificationId);
  await page.waitForTimeout(800);

  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate((pid) => {
      const Ext = (window as any).Ext;
      const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
      form?.query?.('[name=product_id]')[0]?.setValue(pid);
    }, productId);
    try {
      await page.waitForFunction(() => {
        const Ext = (window as any).Ext;
        const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
        return form?.query?.('[name=product_id]')[0]?.getValue?.() != null;
      }, null, { timeout: 5_000 });
      break;
    } catch {
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForTimeout(3000);
}

/** Set (or clear, with null) the line item's asset field and let the re-fired
 * unit-price lookup settle. */
async function setLineItemAsset(page: Page, assetId: number | null): Promise<boolean> {
  const found = await page.evaluate((id) => {
    const Ext = (window as any).Ext;
    const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    const f = form?.down?.('[reference=assetGroupIdField]');
    if (!f) return false;
    f.setValue(id);
    return true;
  }, assetId);
  await page.waitForTimeout(4000);
  return found;
}

async function readLineItemUnitPrice(page: Page): Promise<{ value: number | null; assetValue: unknown; assetFieldExists: boolean }> {
  return await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    const up = form?.query?.('[name=unit_price]')[0];
    const af = form?.down?.('[reference=assetGroupIdField]');
    return {
      value: up?.getValue?.() ?? null,
      assetValue: af?.getValue?.() ?? null,
      assetFieldExists: !!af,
    };
  });
}

function unitPriceLocator(page: Page) {
  return page.locator('input[name=unit_price]').first();
}

async function lineItemAssetFieldExists(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const form = Ext.ComponentQuery.query('lineitemgrid')[0]?.down?.('formpanel');
    return !!form?.down?.('[reference=assetGroupIdField]');
  });
}

interface PriceRequest {
  path: string;
  /** The asset_group_id query param as sent: the id, '' when explicitly empty, or null when absent. */
  asset: string | null;
  status: number;
  body: string;
}

/**
 * Capture every unit-price / markup-preview request with the asset_group_id it
 * carried. Whether a request fires AT ALL — and with which asset — is the
 * evidence that separates "the form asked the server the right question" from
 * "the server answered the wrong question".
 */
function capturePriceRequests(page: Page, sink: PriceRequest[]): () => void {
  const handler = async (resp: any) => {
    const url = resp.url();
    if (!/get_unit_price|get_marked_up_price/.test(url)) return;
    let body = '';
    try { body = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    const m = /[?&]asset_group_id=([^&]*)/.exec(url);
    sink.push({
      path: url.replace(/^https?:\/\/[^/]+/, ''),
      asset: m ? decodeURIComponent(m[1]) : null,
      status: resp.status(),
      body,
    });
  };
  page.on('response', handler);
  return () => page.off('response', handler);
}

// --- Tests ----------------------------------------------------------------

// Serial is configured PER TRACK below, not file-wide. A file-wide serial mode
// makes the first failure suppress every later test, and this suite contains a
// genuine AC failure whose presence must not erase the configuration and
// model-layer evidence from the report. Within each track, order still matters
// (shared Ext app state), so each track declares serial for itself.

test.describe('TANGO-65 — Asset as a pricing set-criteria field', () => {
  test.slow();

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Pricing configuration is an admin screen; admin project only.');
  });

  // ---------------------------------------------------------------- TRACK A
  // Configuration — what the two pricing modals render.
  //
  // Each track is its OWN serial group. Playwright skips the remaining tests in
  // a serial group once one fails, and this suite contains a genuine AC failure
  // (the order-dependent GUI re-resolve). Grouping keeps that one failure from
  // suppressing the configuration and model-layer evidence in the report.

  test.describe('Configuration — the pricing modals and grid', () => {
    test.describe.configure({ mode: 'serial' });

  test('Asset is a selectable criteria field in the Subcontractor Product Pricing modal', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1] });

    await test.step('Navigate to Admin > Accounting > Subcontractor Pricings (#subcontractorproductpricings)', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
    });

    await test.step('Click "+" to open the pricing configuration side edit menu', async () => {
      await openNewPricingForm(page);
    });
    await captureAcSnapshot(testInfo, page, 'before', { label: 'Subcontractor pricing modal opened' });

    const field = await readMenuField(page, ASSET_FIELD_NAME);
    expect(field.exists, `Asset field (name="${ASSET_FIELD_NAME}") must exist in the Subcontractor pricing modal`).toBe(true);
    expect(field.visible, 'Asset field must be visible on the Subcontractor side').toBe(true);
    expect(field.disabled, 'Asset field must be editable, not disabled').toBe(false);

    const focus = await menuFieldLocator(page, ASSET_FIELD_NAME);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus,
      label: `Asset criteria field present and selectable (label "${field.label ?? ''}", xtype ${field.xtype ?? '?'})`,
    });

    await clickCancel(page);
  });

  test('Asset is a selectable criteria field in the Client Product Pricing modal', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1] });

    await test.step('Navigate to Admin > Accounting > Client Pricings (#clientproductpricings)', async () => {
      await gotoPricingsGrid(page, 'clientproductpricings');
    });

    await test.step('Click "+" to open the pricing configuration side edit menu', async () => {
      await openNewPricingForm(page);
    });
    await captureAcSnapshot(testInfo, page, 'before', { label: 'Client pricing modal opened' });

    const field = await readMenuField(page, ASSET_FIELD_NAME);
    expect(field.exists, `Asset field (name="${ASSET_FIELD_NAME}") must exist in the CLIENT pricing modal too — the AC says BOTH`).toBe(true);
    expect(field.visible, 'Asset field must be visible on the Client side').toBe(true);
    expect(field.disabled, 'Asset field must be editable, not disabled').toBe(false);

    const focus = await menuFieldLocator(page, ASSET_FIELD_NAME);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus,
      label: 'Asset criteria field present on the Client pricing modal',
    });

    await clickCancel(page);
  });

  test('Client pricing has no price enforcement, while Subcontractor pricing does', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1a] });

    // Client side — the enforcement toggle must be absent or hidden.
    await test.step('Open the Client pricing modal and inspect the enforcement toggle', async () => {
      await gotoPricingsGrid(page, 'clientproductpricings');
      await openNewPricingForm(page);
    });

    const clientEnforcement = await readMenuField(page, ENFORCEMENT_FIELD);
    // Focus the CURRENCY field, not the Asset field. On the Subcontractor modal
    // the enforcement toggle sits between Base Percent and Currency, so framing
    // Currency puts the exact region where the toggle would live in shot — the
    // screenshot then shows its absence rather than merely not showing it.
    const clientCurrencyFocus = await menuFieldLocator(page, 'currency');
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: clientCurrencyFocus,
      label: 'Client modal — Base Price and Base Percent run straight into Currency, with no price-enforcement toggle between them',
    });
    expect(
      !clientEnforcement.exists || clientEnforcement.hidden === true || clientEnforcement.visible === false,
      'Client pricing must not offer price enforcement (AC: "Clients pricing would not have price enforcements")',
    ).toBe(true);

    await clickCancel(page);

    // Subcontractor side — the same toggle IS offered. Without this arm the
    // absence above could be a broken selector rather than a real gate.
    await test.step('Open the Subcontractor pricing modal and confirm the enforcement toggle IS offered there', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
      await openNewPricingForm(page);
    });

    const subEnforcement = await readMenuField(page, ENFORCEMENT_FIELD);
    expect(subEnforcement.exists, 'Control arm: the enforcement toggle must exist on the Subcontractor side, else the client-side absence proves nothing about the gate').toBe(true);
    expect(subEnforcement.visible, 'Control arm: the enforcement toggle must be visible on the Subcontractor side').toBe(true);

    const subEnforcementFocus = await menuFieldLocator(page, ENFORCEMENT_FIELD);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus: subEnforcementFocus,
      label: 'Subcontractor modal — price-enforcement toggle IS offered (control arm)',
    });

    await clickCancel(page);
  });

  test('Only active assets populate the Asset picker on both pricing modals', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration2] });

    for (const ctype of ['subcontractorproductpricings', 'clientproductpricings'] as PricingCtype[]) {
      const side = ctype === 'subcontractorproductpricings' ? 'Subcontractor' : 'Client';

      await test.step(`Open the ${side} pricing modal and query its Asset picker for "[QA] TANGO-65"`, async () => {
        await gotoPricingsGrid(page, ctype);
        await openNewPricingForm(page);
      });

      const result = await queryAssetPicker(page, ASSET_FIELD_NAME);
      expect(result.ok, `${side}: Asset picker store must be readable — got ${JSON.stringify(result)}`).toBe(true);
      expect(result.status, `${side}: the Asset picker request must succeed`).toBe(200);

      const rows = result.rows ?? [];
      const ids  = rows.map((r) => r.id);

      // Guard the absence assertions against a paging artifact: if the total
      // exceeded one page, "not present" would prove nothing.
      expect(result.total, `${side}: expected a total row count in the payload`).not.toBeNull();
      expect(
        result.total!,
        `${side}: the picker's total (${result.total}) must fit in one page (${result.pageSize}) or the absence checks below are meaningless`,
      ).toBeLessThanOrEqual(result.pageSize ?? 100);

      // Positive control: the picker DOES return the active assets. Without
      // this, an empty response would satisfy the exclusion assertion for the
      // wrong reason.
      expect(ids, `${side}: the picker must return the active seeded asset "${ASSET_NORTH.name}" (#${ASSET_NORTH.id})`).toContain(ASSET_NORTH.id);
      expect(ids, `${side}: the picker must return the active seeded asset "${ASSET_SOUTH.name}" (#${ASSET_SOUTH.id})`).toContain(ASSET_SOUTH.id);
      // The AC itself. Asserted by ID, not name — the soft-deleted fixture
      // shares North's name, so a name-based check could not tell them apart.
      expect(ids, `${side}: the INACTIVE asset "${ASSET_INACTIVE.name}" (#${ASSET_INACTIVE.id}) must NOT populate the picker`).not.toContain(ASSET_INACTIVE.id);
      expect(ids, `${side}: the SOFT-DELETED asset #${ASSET_DELETED.id} must NOT populate the picker`).not.toContain(ASSET_DELETED.id);
      // Belt and braces: nothing inactive or deleted from anywhere in the list.
      expect(rows.filter((r) => !r.active).map((r) => r.id), `${side}: no inactive asset may appear in the picker`).toEqual([]);
      expect(rows.filter((r) => r.deleted).map((r) => r.id), `${side}: no deleted asset may appear in the picker`).toEqual([]);

      // By-id arm — this is what InfiniteComboField#loadTillValue does when
      // lookupHonorsStoreFilters is on (750310aeb7). An excluded asset must not
      // resolve even when asked for directly by its id.
      const byIdActive   = await queryAssetPicker(page, ASSET_FIELD_NAME, [{ property: 'object_assets.id', value: ASSET_NORTH.id }]);
      const byIdInactive = await queryAssetPicker(page, ASSET_FIELD_NAME, [{ property: 'object_assets.id', value: ASSET_INACTIVE.id }]);
      const byIdDeleted  = await queryAssetPicker(page, ASSET_FIELD_NAME, [{ property: 'object_assets.id', value: ASSET_DELETED.id }]);

      expect(byIdActive.rows?.length, `${side}: an ACTIVE asset must resolve on a by-id lookup (control)`).toBe(1);
      expect(byIdInactive.rows?.length, `${side}: the INACTIVE asset must NOT resolve even on a direct by-id lookup`).toBe(0);
      expect(byIdDeleted.rows?.length, `${side}: the SOFT-DELETED asset must NOT resolve even on a direct by-id lookup`).toBe(0);

      const focus = await menuFieldLocator(page, ASSET_FIELD_NAME);
      await captureAcSnapshot(testInfo, page, ctype === 'subcontractorproductpricings' ? 'before' : 'after', {
        focus,
        label: `${side} Asset picker returned ${rows.length} asset(s), all active and undeleted`,
      });

      await testInfo.attach(`asset-picker-${side.toLowerCase()}`, {
        body: JSON.stringify({
          url: result.url,
          filters: result.filters,
          status: result.status,
          rootProperty: result.rootProperty,
          total: result.total,
          pageSize: result.pageSize,
          seededAssetsInList: rows.filter((r) => r.name.includes('TANGO-65')),
          excludedByDesign: {
            inactive: { asset: ASSET_INACTIVE, byIdRows: byIdInactive.rows?.length },
            softDeleted: { id: ASSET_DELETED.id, byIdRows: byIdDeleted.rows?.length },
          },
          anyInactiveReturned: rows.filter((r) => !r.active).length,
          anyDeletedReturned: rows.filter((r) => r.deleted).length,
        }, null, 2),
        contentType: 'application/json',
      });

      await clickCancel(page);
    }
  });

  test('An inactive asset does not resolve a display value on a by-id lookup', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration2] });

    const inactiveRule = fixtureByName('Sub Inactive Asset');

    await test.step('Navigate to Subcontractor Pricings', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
    });

    await test.step(`Open the pricing "${inactiveRule.name}", whose asset_group_id points at the INACTIVE asset`, async () => {
      await openPricingForEdit(page, inactiveRule.name);
    });

    const field = await readMenuField(page, ASSET_FIELD_NAME);
    const focus = await menuFieldLocator(page, ASSET_FIELD_NAME);
    await captureAcSnapshot(testInfo, page, 'after', {
      focus,
      label: 'Asset combo shows no display value for an inactive asset the picker excludes',
    });

    expect(field.exists, 'Asset field must exist on the edit form').toBe(true);
    // The whole point of lookupHonorsStoreFilters (750310aeb7): a value the
    // picker's list would exclude must not resolve a display value either,
    // otherwise the form shows a name the user can never re-select.
    expect(
      (field.displayText ?? '').includes(ASSET_INACTIVE.name),
      `The combo must NOT display the inactive asset's name "${ASSET_INACTIVE.name}" — it resolved "${field.displayText}"`,
    ).toBe(false);

    await testInfo.attach('inactive-asset-lookup', {
      body: JSON.stringify({ pricing: inactiveRule.name, inactiveAsset: ASSET_INACTIVE, field }, null, 2),
      contentType: 'application/json',
    });

    await clickCancel(page);
  });

  test('The grid Asset column renders the bound asset name, and * when unscoped', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1, TANGO_65_AC.Configuration3] });

    await test.step('Navigate to Subcontractor Pricings and read the Asset column', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
    });

    const col = await readAssetColumn(page);
    expect(col.exists, 'The pricings grid must expose an Asset column (dataIndex asset_group_id)').toBe(true);

    const northRule       = fixtureByName('Sub Asset North');
    const productOnlyRule = fixtureByName('Sub Product Only');
    // Match on the pricing's id from the manifest rather than its name — ids are
    // exact, and the grid truncates long names in the rendered cell.
    const northCell       = col.cells.find((c) => c.id === northRule.id);
    const unscopedCell    = col.cells.find((c) => c.id === productOnlyRule.id);

    await testInfo.attach('asset-column', {
      body: JSON.stringify({
        columnText: col.text,
        hidden: col.hidden,
        storeCount: col.storeCount,
        storeTotal: col.storeTotal,
        lookingFor: { north: { id: northRule.id, name: northRule.name }, unscoped: { id: productOnlyRule.id, name: productOnlyRule.name } },
        seededCells: col.cells.filter((c) => (c.name || '').includes('TANGO-65')),
      }, null, 2),
      contentType: 'application/json',
    });

    const focus = page.locator('.x-gridrow').filter({ hasText: northRule.name }).first();
    await captureAcSnapshot(testInfo, page, 'after', {
      focus,
      label: `Asset column shows "${ASSET_NORTH.name}" for the asset-scoped rule`,
    });

    const diagnosis = `store count=${col.storeCount} total=${col.storeTotal} strategy=${(col as any).strategy}; seeded rows seen=${JSON.stringify(col.cells.filter((c) => (c.name || '').includes('TANGO-65')))}; first 5 rows=${JSON.stringify(col.cells.slice(0, 5))}`;
    expect(northCell, `The asset-scoped rule "${northRule.name}" (#${northRule.id}) must appear in the grid store. ${diagnosis}`).toBeTruthy();
    expect(northCell!.asset, 'An asset-scoped rule must render its asset name').toBe(ASSET_NORTH.name);
    expect(unscopedCell, `The unscoped rule "${productOnlyRule.name}" must appear in the grid store`).toBeTruthy();
    expect(unscopedCell!.asset, 'A rule with no asset criterion must render "*" (any)').toBe('*');
  });

  test('The Asset filter returns 200 on both admin pricings grids (no ambiguous-column 500)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1, TANGO_65_AC.Configuration3] });

    const results: Array<{ surface: string; reached: boolean; applied: boolean; statuses: number[]; detail?: string }> = [];

    // Deep surfaces — the two admin pricing screens.
    for (const ctype of ['subcontractorproductpricings', 'clientproductpricings'] as PricingCtype[]) {
      const side = ctype === 'subcontractorproductpricings' ? 'Subcontractor' : 'Client';
      await test.step(`Filter the ${ctype} grid by Asset = ${ASSET_NORTH.id} ("${ASSET_NORTH.name}")`, async () => {
        await gotoPricingsGrid(page, ctype);
        const { statuses, applied } = await applyAssetFilterAndCaptureStatus(page, ASSET_NORTH.id);
        results.push({ surface: ctype, reached: true, applied, statuses });
        // Capture per surface, framed on that grid — the previous single
        // trailing capture framed whatever page was last on screen, which was
        // the vendor record page left behind by the unreached smoke below.
        await captureAcSnapshot(testInfo, page, ctype === 'subcontractorproductpricings' ? 'before' : 'after', {
          focus: page.locator('.x-gridrow').first(),
          label: `${side} pricings grid filtered by Asset — index returned ${statuses.join(', ') || 'no observed status'}`,
        });
      });
    }

    // Shallow smoke — the record-level Pricings tabs, which mount the same grid.
    const clientRoleId = 4;
    const vendorRoleId = 183;
    for (const [label, ctype, id] of [
      ['client record Pricings tab', 'client', clientRoleId],
      ['vendor record Pricings tab', 'vendor', vendorRoleId],
    ] as Array<[string, 'client' | 'vendor', number]>) {
      // Attempt OUTSIDE the step so the step name can state the outcome. A step
      // named "Smoke: filter X" renders as a green tick even when the surface was
      // never reached, which reads as coverage that did not happen.
      const { reached, detail } = await gotoRecordPricingsTab(page, ctype, id);
      if (!reached) {
        results.push({ surface: label, reached: false, applied: false, statuses: [], detail });
        await test.step(`NOT COVERED — could not open the ${label} (${detail})`, async () => {});
      } else {
        const { statuses, applied } = await applyAssetFilterAndCaptureStatus(page, ASSET_NORTH.id);
        results.push({ surface: label, reached: true, applied, statuses, detail });
        await test.step(`Smoke: ${label} filtered by Asset — index returned ${statuses.join(', ')}`, async () => {});
      }
    }

    await testInfo.attach('asset-filter-statuses', {
      body: JSON.stringify({ filterProperty: ASSET_FILTER_PROP, assetId: ASSET_NORTH.id, results }, null, 2),
      contentType: 'application/json',
    });

    // Any 5xx on a pricings index while the Asset filter is applied is the
    // PG::AmbiguousColumn regression.
    for (const r of results) {
      if (!r.reached) continue;
      expect(r.statuses.some((s) => s >= 500), `${r.surface}: filtering by Asset must not return a 5xx (got ${JSON.stringify(r.statuses)})`).toBe(false);
    }
    // At least the two deep surfaces must actually have exercised the filter,
    // otherwise this test silently proves nothing.
    const deep = results.filter((r) => r.surface.endsWith('productpricings'));
    expect(deep.length, 'Both admin pricing grids must be covered').toBe(2);
    for (const r of deep) {
      expect(r.applied, `${r.surface}: the Asset filter must have been applied`).toBe(true);
      expect(r.statuses.length, `${r.surface}: at least one pricings index request must have been observed`).toBeGreaterThan(0);
      expect(r.statuses.includes(200), `${r.surface}: the filtered index must return 200 (got ${JSON.stringify(r.statuses)})`).toBe(true);
    }

    const unreached = results.filter((r) => !r.reached).map((r) => r.surface);
    if (unreached.length) {
      testInfo.annotations.push({
        type: 'coverage-gap',
        description: `Asset-filter smoke could not reach: ${unreached.join(', ')} — not asserted, treat as untested rather than passing.`,
      });
    }
  });

  test('Asset is offered in the pricing import template and export', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration3] });

    await test.step('Navigate to Subcontractor Pricings', async () => {
      await gotoPricingsGrid(page, 'subcontractorproductpricings');
    });

    const observed: Array<{ action: string; ok: boolean; detail: string }> = [];

    for (const action of ['downloadImportTemplate', 'exportPricings'] as const) {
      await test.step(`Trigger the hamburger action "${action}"`, async () => {
        const responses: Array<{ url: string; status: number }> = [];
        const listener = (resp: any) => {
          if (/import|export|template|pricing/i.test(resp.url())) {
            responses.push({ url: resp.url(), status: resp.status() });
          }
        };
        page.on('response', listener);
        const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);

        const fired = await page.evaluate((handler) => {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('accountingpricinggrid')[0];
          const controller = grid?.getController?.();
          if (!controller || typeof controller[handler] !== 'function') return false;
          try { controller[handler](); return true; } catch { return false; }
        }, action);

        const download = await downloadPromise;
        await page.waitForTimeout(4000);
        page.off('response', listener);

        const noServerError = !responses.some((r) => r.status >= 500);
        observed.push({
          action,
          ok: fired && noServerError,
          detail: `handler invoked: ${fired}; download event: ${download ? download.suggestedFilename() : 'none'}; responses: ${JSON.stringify(responses)}`,
        });
      });
    }

    await testInfo.attach('import-export-observations', {
      body: JSON.stringify({
        observed,
        evidenceLimit: 'Spreadsheet cell contents are NOT read by this test. The Asset import/export key contents are covered by test/services/importers/products/product_pricing_asset_key_test.rb in Fexy-Zamo.',
      }, null, 2),
      contentType: 'application/json',
    });

    await captureAcSnapshot(testInfo, page, 'after', { label: 'Import template + export triggered from the pricings grid without a server error' });

    for (const o of observed) {
      expect(o.ok, `${o.action} must run without a server error — ${o.detail}`).toBe(true);
    }
  });

  // ---------------------------------------------------------------- TRACK A
  }); // end Configuration group

  // Matching, in the GUI. Runs on invoice 24 (open) — see the file header.

  test.describe('Matching in the GUI', () => {
    test.describe.configure({ mode: 'serial' });

  /**
   * GUI matching. Split into two tests ON PURPOSE, because the behavior is
   * ORDER-DEPENDENT and lumping them together would hide which half works:
   *
   *   - asset BEFORE product  → the rate resolves to the asset-scoped value.
   *     This works only because the PRODUCT change carries the already-set asset
   *     into get_unit_price.
   *   - product BEFORE asset  → selecting the asset fires NO get_unit_price
   *     request at all and the stale non-asset rate stays in the field.
   *
   * Both orders were confirmed by exploration (see the report's Findings), with
   * the network traffic captured either way and no JS console/page errors.
   */

  test('Asset selected BEFORE the product resolves the asset-scoped rate', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });
    test.setTimeout(300_000);

    const seen: PriceRequest[] = [];
    const off = capturePriceRequests(page, seen);

    await test.step(`Open subcontractor invoice #${GUI.invoice_id} and start a new line item`, async () => {
      await gotoInvoice(page, GUI.invoice_id);
      await openNewLineItemForm(page);
    });

    const fieldPresent = await lineItemAssetFieldExists(page);
    if (!fieldPresent) {
      off();
      testInfo.annotations.push({
        type: 'coverage-gap',
        description: 'The line-item form exposes no [reference=assetGroupIdField]; the GUI matching arm could not run. The model-layer checks still cover the matching AC.',
      });
      test.skip(true, 'No asset field on this line-item form — see the coverage-gap annotation.');
    }

    await captureAcSnapshot(testInfo, page, 'before', { label: 'New line item form, nothing selected yet' });

    await test.step(`Select the asset "${ASSET_EAST.name}" (#${GUI.asset_id}) FIRST`, async () => {
      const ok = await setLineItemAsset(page, GUI.asset_id);
      expect(ok, 'The asset field must be settable on the line-item form').toBe(true);
    });

    await test.step(`Then select the probe product #${GUI.product_id}`, async () => {
      await selectProduct(page, GUI.product_id, LABOR_CLASSIFICATION_ID);
    });

    const state = await readLineItemUnitPrice(page);
    off();

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `Asset-first order — rate resolved to $${state.value} from the asset-scoped rule`,
    });

    await testInfo.attach('asset-first-requests', {
      body: JSON.stringify({ expectedAssetRate: GUI.asset_rate, fallbackRate: GUI.fallback_rate, finalState: state, requests: seen }, null, 2),
      contentType: 'application/json',
    });

    expect(Number(state.assetValue), 'The asset must actually be set on the form').toBe(GUI.asset_id);
    // The AC: a rule scoped to a specific asset is honored when that asset is
    // referenced on the line item.
    expect(Number(state.value), `Asset-first must resolve the asset-scoped rate $${GUI.asset_rate}, not the product-only $${GUI.fallback_rate}`).toBeCloseTo(GUI.asset_rate, 2);
    // Evidence that the asset genuinely reached the server.
    expect(
      seen.some((r) => r.asset === String(GUI.asset_id)),
      `A get_unit_price request must have carried asset_group_id=${GUI.asset_id}. Saw: ${JSON.stringify(seen)}`,
    ).toBe(true);
  });

  test('A cleared asset is not resurrected in the unit-price lookup', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Edge1] });
    test.setTimeout(300_000);

    const seen: PriceRequest[] = [];
    const off = capturePriceRequests(page, seen);

    await test.step(`Open invoice #${GUI.invoice_id}, select the asset then the product (the order that works)`, async () => {
      await gotoInvoice(page, GUI.invoice_id);
      await openNewLineItemForm(page);
    });

    const fieldPresent = await lineItemAssetFieldExists(page);
    if (!fieldPresent) {
      off();
      test.skip(true, 'No asset field on this line-item form.');
    }

    await setLineItemAsset(page, GUI.asset_id);
    await selectProduct(page, GUI.product_id, LABOR_CLASSIFICATION_ID);
    const withAsset = await readLineItemUnitPrice(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: `Asset bound — rate $${withAsset.value}, and the lookup carried the asset id`,
    });

    await test.step('Clear the asset field, then re-select the product to force a fresh lookup', async () => {
      await setLineItemAsset(page, null);
      await selectProduct(page, GUI.product_id, LABOR_CLASSIFICATION_ID);
    });

    const cleared = await readLineItemUnitPrice(page);
    off();

    // The d026250c04 fix is about the REQUEST PARAMS: when the field exists its
    // value is authoritative, so a cleared field must not fall back to the
    // record's saved asset. Asserting the request rather than the rendered rate
    // keeps this independent of the response handler's "only fill when empty"
    // gating.
    const lastRequest = seen[seen.length - 1];
    await testInfo.attach('cleared-asset-requests', {
      body: JSON.stringify({ withAsset, cleared, requests: seen, lastRequest }, null, 2),
      contentType: 'application/json',
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: 'Asset cleared — the following lookup carried no asset id',
    });

    expect(cleared.assetValue ?? null, 'The asset field must actually be cleared').toBeNull();
    expect(lastRequest, `At least one unit-price lookup must have fired after clearing. Saw: ${JSON.stringify(seen)}`).toBeTruthy();
    expect(
      lastRequest.asset === '' || lastRequest.asset === null,
      `After clearing the asset, the lookup must NOT carry the stale asset id. Last request asset_group_id=${JSON.stringify(lastRequest.asset)}`,
    ).toBe(true);
  });
  // NOTE ON ORDER: the product-then-asset test below is a KNOWN FAILURE (a real
  // AC deviation, documented in the report). It is deliberately last in this
  // serial group so it cannot suppress the two passing arms above it.

  test('Asset selected AFTER the product re-resolves the rate', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });
    test.setTimeout(300_000);

    const seen: PriceRequest[] = [];
    const off = capturePriceRequests(page, seen);

    await test.step(`Open subcontractor invoice #${GUI.invoice_id} and start a new line item`, async () => {
      await gotoInvoice(page, GUI.invoice_id);
      await openNewLineItemForm(page);
    });

    const fieldPresent = await lineItemAssetFieldExists(page);
    if (!fieldPresent) {
      off();
      testInfo.annotations.push({
        type: 'coverage-gap',
        description: 'The line-item form exposes no [reference=assetGroupIdField]; this arm could not run.',
      });
      test.skip(true, 'No asset field on this line-item form.');
    }

    await test.step(`Select the probe product #${GUI.product_id} FIRST — expect the non-asset rate $${GUI.fallback_rate}`, async () => {
      await selectProduct(page, GUI.product_id, LABOR_CLASSIFICATION_ID);
    });

    const afterProduct = await readLineItemUnitPrice(page);
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: unitPriceLocator(page),
      label: `Product selected, no asset yet — rate $${afterProduct.value} (non-asset-scoped rule)`,
    });
    expect(Number(afterProduct.value), `Baseline: with no asset the product-only rule ($${GUI.fallback_rate}) must win`).toBeCloseTo(GUI.fallback_rate, 2);

    const requestsBefore = seen.length;

    await test.step(`Now select the asset "${ASSET_EAST.name}" (#${GUI.asset_id}) — the lookup must re-fire`, async () => {
      const ok = await setLineItemAsset(page, GUI.asset_id);
      expect(ok, 'The asset field must be settable on the line-item form').toBe(true);
    });

    const afterAsset = await readLineItemUnitPrice(page);
    off();

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: unitPriceLocator(page),
      label: `Asset selected after the product — rate is $${afterAsset.value} (contracted asset rate is $${GUI.asset_rate})`,
    });

    const newRequests = seen.slice(requestsBefore);
    await testInfo.attach('asset-after-product-requests', {
      body: JSON.stringify({
        expectedAssetRate: GUI.asset_rate,
        fallbackRate: GUI.fallback_rate,
        afterProduct,
        afterAsset,
        requestsBeforeAssetChange: requestsBefore,
        requestsTriggeredByAssetChange: newRequests,
        allRequests: seen,
        serverIsCorrect: 'Probed directly: GET /api/v1/invoices/get_unit_price with asset_group_id returns the asset rate, and creating a line item with unit_price omitted persists the asset rate. The server resolves correctly; the form does not ask it to.',
      }, null, 2),
      contentType: 'application/json',
    });

    // Sanity: the asset really is set on the form, so a missing re-resolve cannot
    // be blamed on the field not taking the value.
    expect(Number(afterAsset.assetValue), 'The asset must actually be set on the form').toBe(GUI.asset_id);

    // The AC: "A pricing rule scoped to a specific asset is honored when that
    // asset is referenced on a line item." Here the asset IS referenced and the
    // rule is NOT honored — no lookup is re-fired and the stale rate remains,
    // which is what the form then submits.
    expect(
      newRequests.length,
      `Selecting the asset must re-fire the unit-price lookup. No get_unit_price request was observed after the asset changed (asset field value=${afterAsset.assetValue}). Asset-first ordering DOES work, so the wiring exists but the asset field's change handler never reaches it.`,
    ).toBeGreaterThan(0);

    expect(
      Number(afterAsset.value),
      `Selecting the asset after the product must re-resolve to $${GUI.asset_rate}; the field still shows $${afterAsset.value}. Impact: the form submits the stale rate and, because set_unit_price only fills a BLANK unit_price, the line item persists at $${GUI.fallback_rate} instead of the contracted $${GUI.asset_rate}.`,
    ).toBeCloseTo(GUI.asset_rate, 2);
  });

  }); // end GUI matching group

  // ---------------------------------------------------------------- TRACK B
  // Matching + edge cases, proven numerically at the model layer. No browser, so
  // these run regardless of any GUI failure above.

  test.describe('Model layer', () => {
    test.describe.configure({ mode: 'serial' });

    /**
     * EVERY assertion here lives inside a `test.step()` ON PURPOSE. The report
     * generator drops any test with zero steps (`reporters/qa-report.ts` filters
     * on `e.steps.length > 0`), so a step-less model test is silently omitted
     * from the deliverable whether it passes OR FAILS. Before this, eight tests
     * and four AC clauses were missing from the report entirely. Steps also
     * carry the observed values, so the rendered report shows the numbers rather
     * than just a green tick.
     */

    test('Model layer — the manifest under assertion is from this run', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });

      // Freshness gate. The spec reads a JSON file the seed wrote; without this,
      // a seed that was never re-run (or aborted, or ran against another DB)
      // leaves every model test asserting stale numbers, green.
      await test.step(`Manifest ticket is ${TICKET} and carries a generated_at timestamp`, async () => {
        expect(manifest.ticket).toBe(TICKET);
        expect(manifest.generated_at, 'seed manifest must record generated_at').toBeTruthy();
      });

      await test.step('Manifest is newer than 6 hours — re-run `npm run seed:asset-pricing-criterion` if this fails', async () => {
        const ageMs = Date.now() - new Date(manifest.generated_at).getTime();
        expect(ageMs, `manifest is ${Math.round(ageMs / 3_600_000)}h old (generated_at=${manifest.generated_at})`).toBeLessThan(6 * 3_600_000);
      });

      await test.step(`Manifest describes ${manifest.model_checks.length} model checks and ${manifest.fixtures.length} fixtures`, async () => {
        expect(manifest.model_checks.length).toBeGreaterThanOrEqual(11);
        expect(manifest.fixtures.length).toBeGreaterThan(0);
      });
    });

    test('Model layer — an asset-scoped rule is honored over a competing product-only rule', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });

      const c = checkFor('asset_rule_honored_north');
      await testInfo.attach('model-check', { body: JSON.stringify(c, null, 2), contentType: 'application/json' });

      await test.step('Instrumented create completed without error', async () => {
        expect(c.error ?? null, `Instrumentation must not have errored: ${c.error}`).toBeNull();
      });
      await test.step(`Line item on the asset resolved $${c.unit_price} (expected $${c.expected_unit_price}, competing product-only rule is $120)`, async () => {
        expect(c.unit_price, c.detail).toBeCloseTo(c.expected_unit_price!, 2);
      });
      // NOTE: this scenario does NOT establish precedence — both rules share the
      // same product_id and the asset rule carries one MORE criterion, so it wins
      // on total_score (criterion count) before column order is consulted. The
      // precedence claim is carried by the equal-specificity test below.
    });

    test('Model layer — two assets of the same type at the same facility resolve to different rates', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });

      const c = checkFor('same_type_same_facility_disambiguated');
      await testInfo.attach('model-check', { body: JSON.stringify(c, null, 2), contentType: 'application/json' });

      // This is the Cushman & Wakefield escalation reproduced: same asset TYPE,
      // same FACILITY, different contracted rate.
      await test.step(`Line item on the South asset resolved $${c.unit_price} (North prices at $310) — the two are disambiguated`, async () => {
        expect(c.unit_price, c.detail).toBeCloseTo(c.expected_unit_price!, 2);
      });
    });

    test('Model layer — at equal specificity, Asset outranks Product in the best-match ranking', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching2, TANGO_65_AC.Matching3] });

      const contest    = checkFor('precedence_equal_specificity');
      const structural = checkFor('defined_precedence');
      await testInfo.attach('precedence-contest', { body: JSON.stringify({ contest, structural, precedence: manifest.scope.precedence }, null, 2), contentType: 'application/json' });

      // THE behavioral proof. PermutationRankable sorts by `total_score DESC`
      // (count of non-NULL criteria) FIRST and only then by
      // `weighted_column_score DESC`, which is the sole expression of
      // PR_BEST_MATCH_COLUMNS order. So precedence is only observable when the
      // two rules TIE on criterion count.
      await test.step(`Asset-only rule ($555) vs product-only rule ($111), tied at 3 criteria each — resolved $${contest.unit_price}`, async () => {
        expect(contest.unit_price, contest.detail).toBeCloseTo(contest.expected_unit_price!, 2);
      });

      await test.step('asset_group_id sits at index 0 of PR_BEST_MATCH_COLUMNS on both pricing classes (structural)', async () => {
        for (const [kind, p] of Object.entries(manifest.scope.precedence)) {
          expect(p.asset_index, `${kind}: asset_group_id must have a defined position`).toBe(0);
          expect(p.asset_outranks_product, `${kind}: index ${p.asset_index} vs product ${p.product_index}`).toBe(true);
        }
        expect(structural.passed, structural.detail).toBe(true);
      });

      // FLAG FOR SIGN-OFF: the ticket left "where does Asset sit in the
      // precedence order" as an open engineering question. The shipped answer is
      // "first, ahead of Product". That satisfies the AC as written, but if CS
      // expected Product to win an equally-specific conflict, it does not match
      // that expectation.
    });

    test('Model layer — asset-scoped price enforcement fills the rate and rejects a mismatch', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching4] });

      const fill   = checkFor('asset_scoped_enforcement');
      const tamper = checkFor('asset_scoped_enforcement_rejects_tamper');
      await testInfo.attach('model-checks', { body: JSON.stringify({ fill, tamper }, null, 2), contentType: 'application/json' });

      await test.step(`Flat Rate + base price on an asset-scoped enforced rule filled the omitted unit_price to $${fill.unit_price}`, async () => {
        expect(fill.unit_price, fill.detail).toBeCloseTo(fill.expected_unit_price!, 2);
      });

      // Assert the underlying recorded facts, not just the seed's own verdict:
      // the enforcement gate must have been live, and the rejection must name
      // both the submitted and approved amounts.
      await test.step('Enforcement guard was live on this invoice (enforcement_reevaluatable? = true)', async () => {
        expect(tamper.enforcement_reevaluatable, tamper.detail).toBe(true);
      });
      await test.step('A mismatched unit_price was REJECTED server-side, citing the approved rate', async () => {
        expect(tamper.passed, tamper.detail).toBe(true);
        expect(tamper.detail, 'the rejection must name the submitted and approved amounts').toMatch(/REJECTED/);
      });
    });

    test('Model layer — a line item with no asset still matches non-asset-scoped rules', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Edge1] });

      const sub    = checkFor('no_asset_still_matches');
      const client = checkFor('client_no_asset_still_matches_clientquotelineitem');
      await testInfo.attach('model-checks', { body: JSON.stringify({ sub, client }, null, 2), contentType: 'application/json' });

      await test.step(`Subcontractor: asset_group_id=nil resolved $${sub.unit_price} (the product-only rule) while three asset-scoped rules competed`, async () => {
        expect(sub.unit_price, sub.detail).toBeCloseTo(sub.expected_unit_price!, 2);
      });
      await test.step(`Client: asset_group_id=nil matched pricing #${client.matched_pricing_id} (the product-only rule)`, async () => {
        expect(client.matched_pricing_id, client.detail).toBe(client.expected_pricing_id);
      });
    });

    test('Model layer — matching resolves at the line-item asset, not the work-order asset list', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Edge2] });

      const discriminator = checkFor('line_item_level_not_wo_level');
      const control       = checkFor('line_item_level_control');
      await testInfo.attach('model-checks', { body: JSON.stringify({ discriminator, control, workorder_asset_ids: manifest.scope.workorder_asset_ids }, null, 2), contentType: 'application/json' });

      // Guard the discriminator itself. If demo data ever makes the work order
      // list BOTH assets, this test degrades into a duplicate of its own control
      // arm and would keep passing while proving nothing.
      await test.step(`Precondition — WO lists ${JSON.stringify(manifest.scope.workorder_asset_ids)} at the work-order level, fewer than its line items reference`, async () => {
        expect(
          manifest.scope.edge2_discriminating,
          'The work order must list FEWER assets than its line items reference, otherwise Edge #2 is a tautology.',
        ).toBe(true);
      });

      await test.step(`Line item on the asset the WO does NOT list resolved $${discriminator.unit_price} (its own asset rule), not $211 (the WO-listed asset rule)`, async () => {
        expect(discriminator.unit_price, discriminator.detail).toBeCloseTo(discriminator.expected_unit_price!, 2);
      });
      await test.step(`Control — line item on the WO-listed asset resolved $${control.unit_price}`, async () => {
        expect(control.unit_price, control.detail).toBeCloseTo(control.expected_unit_price!, 2);
      });
    });

    test('Model layer — the client pricing lookup honors the line item asset', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration1, TANGO_65_AC.Matching1] });

      const c = checkFor('client_asset_rule_matched_clientquotelineitem');
      await testInfo.attach('model-check', { body: JSON.stringify(c, null, 2), contentType: 'application/json' });

      // The client path records the matched rule as pricing_id and derives
      // unit_price from the MARKUP (cost + markup), never from the matched rule's
      // base_price — see ClientQuoteLineItem#get_markup_and_pricing. So the
      // assertion is WHICH PRICING MATCHED. Asserting a client unit_price would
      // assert behavior that does not exist.
      await test.step(`Client line item on the asset matched pricing #${c.matched_pricing_id} (the asset-scoped rule), not #${c.expected_pricing_id === c.matched_pricing_id ? 'the product-only rule' : c.expected_pricing_id}`, async () => {
        expect(c.matched_pricing_id, c.detail).toBe(c.expected_pricing_id);
      });
    });

    test('Observed — an inactive asset’s pricing rule still matches (open product question, not an AC assertion)', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Configuration2] });

      const obs = (manifest.observations ?? {}).inactive_asset_still_matches;
      await testInfo.attach('observation', { body: JSON.stringify(obs, null, 2), contentType: 'application/json' });

      // Deliberately NOT asserted as correct or incorrect. The AC governs which
      // assets populate the PICKER; it says nothing about a rule already bound to
      // an asset that is later deactivated. Recorded so the behavior is visible
      // and can be ruled on rather than discovered by a customer.
      await test.step('Observation was recorded by the seed', async () => {
        expect(obs, 'seed must record the inactive-asset match observation').toBeTruthy();
      });
      if (!obs) throw new Error('inactive_asset_still_matches observation missing from the manifest');
      await test.step(`A line item on the INACTIVE asset resolved $${obs?.resolved_unit_price} — its asset rule ($${obs?.inactive_asset_rule_rate}) still won over the $${obs?.non_asset_fallback_rate} fallback`, async () => {
        expect(obs.resolved_unit_price, 'the observation must carry a resolved price').not.toBeNull();
      });
      await test.step('Mechanism — the match predicate uses the bare ObjectAsset id, with no active/deleted check', async () => {
        expect(obs.mechanism).toContain('no active/deleted predicate');
      });
    });

    test('Model layer — document conversion re-prices the copy using the source line item’s asset', async ({}, testInfo) => {
      annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_65_AC.Matching1] });

      const c = checkFor('conversion_forwards_asset_into_pricing');
      const cross = (manifest.observations ?? {}).conversion_prices_by_an_asset_it_then_drops as
        | { copied_unit_price: number | null; copied_asset_group_id: number | null; [k: string]: unknown }
        | undefined;
      await testInfo.attach('conversion', { body: JSON.stringify({ check: c, crossFacilityObservation: cross }, null, 2), contentType: 'application/json' });

      // TANGO-65 changed Invoices::Invoice#get_line_item_copy_attributes to forward
      // the source line item's asset into BOTH copy pricing contexts. This is where
      // a rate is committed onto a billable document, and `grep -rn
      // get_line_item_copy_attributes test/` returns nothing — no merged test and no
      // browser test covers it.
      await test.step('Instrumented conversion completed without error', async () => {
        expect(c.error ?? null, `Conversion instrumentation errored: ${c.error}`).toBeNull();
      });

      await test.step(`Copied line item resolved $${c.unit_price} from the asset-scoped rule (product-only rule was $77)`, async () => {
        expect(c.unit_price, c.detail).toBeCloseTo(c.expected_unit_price!, 2);
      });

      await test.step(`Copy retained the source asset (asset_group_id=${(c as Record<string, unknown>).copied_asset_group_id})`, async () => {
        expect((c as Record<string, unknown>).copied_asset_group_id, 'same-facility copy must carry the asset across').not.toBeNull();
      });

      // Observation, not an assertion: on a CROSS-FACILITY copy the asset attribute
      // is dropped by design (invoice.rb:798-801) while the pricing context still
      // forwards it, so the target line carries an asset-derived rate with no asset.
      await test.step(`Observed — cross-facility copy priced $${cross?.copied_unit_price} but carried asset_group_id=${JSON.stringify(cross?.copied_asset_group_id)}`, async () => {
        expect(cross, 'seed must record the cross-facility conversion observation').toBeTruthy();
      });
    });

    test('Model layer — no instrumented matching scenario failed', async ({}, testInfo) => {
      annotateAc(testInfo, {
        ticket: TICKET,
        ac: [TANGO_65_AC.Matching1, TANGO_65_AC.Matching2, TANGO_65_AC.Matching3, TANGO_65_AC.Matching4, TANGO_65_AC.Edge1, TANGO_65_AC.Edge2],
      });

      const failed = manifest.model_checks.filter((c) => !c.passed);
      await testInfo.attach('all-model-checks', {
        body: JSON.stringify(manifest.model_checks, null, 2),
        contentType: 'application/json',
      });

      await test.step(`All ${manifest.model_checks.length} instrumented scenarios passed`, async () => {
        expect(
          failed.map((f) => `${f.scenario}: ${f.detail}`),
          'No instrumented matching scenario may fail',
        ).toEqual([]);
      });
    });
  }); // end Model layer group
});
