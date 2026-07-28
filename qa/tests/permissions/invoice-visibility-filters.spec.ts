import { test, expect, Page, APIRequestContext, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_86_AC } from '../../src/support/qa-report';

/**
 * Invoice/proposal visibility filters on direct-link show — TANGO-86.
 *
 * The merged fix (PR #7110 + follow-up 34b03ef84a) makes the four
 * invoice/quote show actions honor SQL-string permission filters
 * (Permissions::Resource#sql_string) that previously only bit on grids:
 * show now loads via accessible_by(current_ability).eager_load([...])
 * .find(params[:id]) + an explicit authorize! :show.
 *
 * Shipped contract (verified against the running app + merged minitest):
 *   - sql-hidden record          -> HTTP 200 { error, error_code: "missing_record", success: false }
 *   - no read permission at all  -> HTTP 401 (class-level authorize_resource)
 *   - DENYING instance_methods   -> HTTP 401 (the authorize! restored by 34b03ef84a)
 *   - permitted user             -> HTTP 200 { invoices: { ...full eager_load payload } }
 *
 * The admin Playwright persona is a super_admin whose ability overrides
 * enforcement, so every denial is observed as seeded restricted users via
 * Doorkeeper bearer tokens (TANGO-49 pattern). The Playwright project session
 * only provides the browser page used to render request/response evidence
 * cards for the report.
 *
 * Pre-requisite: `npm run seed:invoice-visibility-filters` — creates the
 * hidden/visible fixture pairs across all four classes, the restricted users
 * + tokens, runs the accessible_by model checks, and writes
 * reports/seed-manifest-tango-86.json.
 */

const TICKET = 'TANGO-86';

type ClassKey = 'subcontractor_invoice' | 'subcontractor_quote' | 'client_invoice' | 'client_quote';

interface ClassScope {
  model: string;
  endpoint: string;
  hidden_id: number;
  hidden_ref: string;
  visible_id: number;
  visible_ref: string;
  payload_probe_id: number;
}

type PersonaKey = 'filtered' | 'noread' | 'instancerule' | 'joinsql' | 'vanilla' | 'instancepass' | 'combined' | 'admin';

interface Manifest {
  ticket: string;
  scope: {
    password: string;
    filter_sql: string;
    users: Record<PersonaKey, { email: string; user_id: number }>;
    classes: Record<ClassKey, ClassScope>;
  };
  api_auth: {
    base_path: string;
    token_type: string;
    tokens: Record<PersonaKey, string>;
    token_owners: Record<PersonaKey, number>;
  };
  model_checks: Array<{ ac: string; name: string; passed: boolean; detail: string }>;
}

const MANIFEST_PATH = path.resolve(process.cwd(), 'reports', 'seed-manifest-tango-86.json');
const NONEXISTENT_ID = 999_999_999;

function loadManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

const CLASS_KEYS: ClassKey[] = ['subcontractor_invoice', 'subcontractor_quote', 'client_invoice', 'client_quote'];

// --- Evidence rendering (renderExchange pattern from the TANGO-49 spec) ----

interface ExchangeView {
  title: string;
  persona: string;
  method: string;
  url: string;
  requestBody: unknown;
  status?: number;
  responseBody?: unknown;
  note?: string;
}

async function renderExchange(
  testInfo: TestInfo,
  page: Page,
  moment: 'before' | 'after',
  view: ExchangeView,
): Promise<void> {
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
    <div id="req-card" class="card">
      <h3>Request</h3>
      <div class="reqline">${esc(view.method)} ${esc(view.url)}</div>
      <pre>${json(view.requestBody)}</pre>
    </div>
    ${view.status != null ? `<div id="res-card" class="card">
      <h3>Response</h3>
      <div><span id="status" class="status ${statusClass}">HTTP ${view.status}</span></div>
      <pre>${json(view.responseBody)}</pre>
    </div>` : ''}
    ${view.note ? `<div class="note">${esc(view.note)}</div>` : ''}
  </body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const focus = moment === 'after' && view.status != null
    ? page.locator('#res-card')
    : page.locator('#req-card');
  await captureAcSnapshot(testInfo, page, moment, { focus });
}

// --- API helpers -----------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

interface ApiResult {
  status: number;
  body: unknown;
}

async function apiGet(request: APIRequestContext, url: string, token: string): Promise<ApiResult> {
  const res = await request.get(url, { headers: authHeaders(token) });
  const status = res.status();
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status, body };
}

async function apiDelete(request: APIRequestContext, url: string, token: string): Promise<ApiResult> {
  const res = await request.delete(url, { headers: authHeaders(token) });
  const status = res.status();
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status, body };
}

function showUrl(scope: ClassScope, id: number): string {
  return `${scope.endpoint}/${id}.json`;
}

// The index FILTERS whitelists carry no `id`/`reference_number` property, so
// grid probes fetch the whole (dev-sized) feed and assert on the id set.
function indexUrl(scope: ClassScope): string {
  return `${scope.endpoint}.json?limit=1000`;
}

/** Index responses render under the `invoices` root; tolerate array-or-missing. */
function indexRows(body: unknown): Array<{ id: number }> {
  const rows = (body as { invoices?: unknown })?.invoices;
  return Array.isArray(rows) ? rows as Array<{ id: number }> : [];
}

type Body = { error?: unknown; error_code?: string; success?: boolean; invoices?: { id?: number } & Record<string, unknown> };

// --- Suite -----------------------------------------------------------------

const manifest = loadManifest();

test.describe('Invoice/proposal visibility filters on direct-link show (TANGO-86)', () => {
  // Serial + one retry: absorbs the first-test cold-start on a fresh worker
  // (global-setup login + first API call warming together). TANGO-49 pattern.
  test.describe.configure({ mode: 'serial', retries: 1 });
  test.setTimeout(120_000);

  const filteredPersona = `Filtered reader · ${manifest?.scope.users.filtered.email ?? 'qa.tango86.filtered@fexa.io'} (Bearer; read on all 4 classes, sql_string hides the 4 HIDDEN fixtures)`;
  const noreadPersona = `No invoice read · ${manifest?.scope.users.noread.email ?? 'qa.tango86.noread@fexa.io'} (Bearer; zero grants on invoice/quote classes)`;
  const instancerulePersona = `Instance-rule denied · ${manifest?.scope.users.instancerule.email ?? 'qa.tango86.instancerule@fexa.io'} (Bearer; read grants with DENYING instance_methods total < 0)`;
  const joinsqlPersona = `Join-referencing sql · ${manifest?.scope.users.joinsql.email ?? 'qa.tango86.joinsql@fexa.io'} (Bearer; sql_string references stores.*)`;
  const vanillaPersona = `Vanilla reader · ${manifest?.scope.users.vanilla.email ?? 'qa.tango86.vanilla@fexa.io'} (Bearer; plain read grants, no sql_string, no instance rule)`;
  const instancepassPersona = `Instance-rule qualifying · ${manifest?.scope.users.instancepass.email ?? 'qa.tango86.instancepass@fexa.io'} (Bearer; read grants with QUALIFYING instance_methods total >= 0)`;
  const combinedPersona = `SQL + instance combined · ${manifest?.scope.users.combined.email ?? 'qa.tango86.combined@fexa.io'} (Bearer; one SubcontractorInvoice grant carrying BOTH the sql_string filter AND a denying instance rule)`;
  const adminPersona = `Super Admin · ${manifest?.scope.users.admin.email ?? 'bigbrother@fexa.io'} (Bearer; manage all — enforcement overridden by design)`;

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'API tests carry explicit bearer tokens; run once under the admin project');
    test.skip(!manifest, `Seed manifest missing at ${MANIFEST_PATH}. Run: npm run seed:invoice-visibility-filters`);
  });

  test('sql-hidden record: direct link returns missing_record on all four show endpoints', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.DirectLink1, TANGO_86_AC.DirectLink2, TANGO_86_AC.Response1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Direct links to the 4 sql-hidden records (one per affected controller)',
      persona: filteredPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].hidden_id)).join('  |  '),
      requestBody: { filter_sql: m.scope.filter_sql, note: 'Ticket says "3 controllers, confirm third" — the merged fix covers FOUR; all four are asserted here.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.hidden_id);
      // Existence control: prove the record EXISTS (loads for super_admin) so
      // the filtered user's missing_record is enforcement, not an absent/deleted
      // fixture. Kills the stale-manifest false-positive even on a targeted run.
      await test.step(`GET ${url} as super_admin → hidden ${scope.model} id=${scope.hidden_id} EXISTS (loads 200)`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.admin);
        expect(status, `${key}: admin existence control status`).toBe(200);
        expect((body as Body).invoices?.id, `${key}: record actually exists`).toBe(scope.hidden_id);
      });
      await test.step(`GET ${url} as filtered user → hidden ${scope.model} id=${scope.hidden_id} (${scope.hidden_ref}) must be missing_record`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.filtered);
        const b = body as Body;
        outcomes[key] = { status, error_code: b.error_code, success: b.success, error: String(b.error ?? '').slice(0, 200), invoices_leaked: b.invoices !== undefined };
        expect(status, `${key}: AC pins HTTP 200 (error_catcher renders missing_record without a status)`).toBe(200);
        expect(b.error_code, `${key}: error_code`).toBe('missing_record');
        expect(b.success, `${key}: success`).toBe(false);
        expect(b.error, `${key}: error key present`).toBeTruthy();
        expect(b.invoices, `${key}: no invoices payload may leak`).toBeUndefined();
      });
    }

    // SECURITY FINDING (documented, non-gating): the missing_record `error`
    // string embeds the raw sql_string — i.e. the full hidden-id list — handing
    // a restricted user the exact records being hidden from them. Recorded here
    // so it surfaces on the report for the developers, not asserted (it is a
    // product decision to fix, not part of TANGO-86's AC).
    let sqlDisclosed = false;
    await test.step('FINDING: does the missing_record error body disclose the sql_string (hidden-id list)?', async () => {
      const { body } = await apiGet(request, showUrl(m.scope.classes.subcontractor_invoice, m.scope.classes.subcontractor_invoice.hidden_id), m.api_auth.tokens.filtered);
      sqlDisclosed = String((body as Body).error ?? '').includes('NOT IN');
      // Intentionally not gated — recorded as evidence. If this ever becomes a
      // hardened behavior (error message scrubbed), flip to expect(false).
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'All four hidden records blocked: HTTP 200 { error, error_code: "missing_record", success: false }',
      persona: filteredPersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: { hidden_ids: CLASS_KEYS.map(k => m.scope.classes[k].hidden_id) },
      status: 200, responseBody: outcomes,
      note: sqlDisclosed
        ? 'SECURITY FINDING (out of AC scope): the missing_record error body discloses the raw sql_string, including the full list of hidden ids — a restricted user can enumerate exactly what is hidden from them. Recommend scrubbing RecordNotFound messages in error_catcher. Flagged for the ticket.'
        : undefined,
    });
  });

  test('visible sibling record: the same filtered user opens it by direct link on all four endpoints', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.DirectLink1, TANGO_86_AC.Regression1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Direct links to the 4 VISIBLE siblings — the filter must discriminate, not blanket-hide',
      persona: filteredPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].visible_id)).join('  |  '),
      requestBody: { filter_sql: m.scope.filter_sql },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.visible_id);
      await test.step(`GET ${url} as filtered user → visible ${scope.model} id=${scope.visible_id} (${scope.visible_ref}) must load`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.filtered);
        const b = body as Body;
        outcomes[key] = { status, invoices_id: b.invoices?.id, error_code: b.error_code };
        expect(status, `${key}: status`).toBe(200);
        expect(b.invoices?.id, `${key}: record id returned`).toBe(scope.visible_id);
        expect(b.error_code, `${key}: no error`).toBeUndefined();
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four visible siblings load for the SAME user whose filter hides the others',
      persona: filteredPersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: { visible_ids: CLASS_KEYS.map(k => m.scope.classes[k].visible_id) },
      status: 200, responseBody: outcomes,
    });
  });

  test('missing_record shape parity: hidden id ≡ nonexistent id ≡ work-order show (AC3 "identical to work order show behavior")', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Response1] });
    const m = manifest!;
    const scope = m.scope.classes.subcontractor_invoice;
    const hiddenUrl = showUrl(scope, scope.hidden_id);
    const ghostUrl = showUrl(scope, NONEXISTENT_ID);
    const woUrl = `/api/v1/workorders/${NONEXISTENT_ID}.json`;   // AC3 reference behavior

    await renderExchange(testInfo, page, 'before', {
      title: 'Hidden id vs nonexistent id vs work-order show — response shapes must match exactly',
      persona: filteredPersona, method: 'GET', url: `${hiddenUrl}  vs  ${ghostUrl}  vs  ${woUrl}`,
      requestBody: { hidden_id: scope.hidden_id, nonexistent_id: NONEXISTENT_ID, note: 'AC3 requires the invoice missing_record body to be "identical to current work order show behavior" — proven here by shape-diffing against an actual workorders#show missing_record.' },
    });

    let hidden!: ApiResult;
    let ghost!: ApiResult;
    let wo!: ApiResult;
    await test.step(`GET ${hiddenUrl} (sql-hidden), GET ${ghostUrl} (nonexistent), GET ${woUrl} (work-order show, admin) — collect all three missing_record bodies`, async () => {
      hidden = await apiGet(request, hiddenUrl, m.api_auth.tokens.filtered);
      ghost = await apiGet(request, ghostUrl, m.api_auth.tokens.filtered);
      wo = await apiGet(request, woUrl, m.api_auth.tokens.admin);   // admin: exercises the WO show path itself, missing id → missing_record
    });
    await test.step('Hidden ≡ nonexistent: same status, same error_code, same top-level keys (per-id shape parity)', async () => {
      expect(hidden.status, 'status parity').toBe(ghost.status);
      const hb = hidden.body as Body, gb = ghost.body as Body;
      expect(hb.error_code, 'error_code parity').toBe(gb.error_code);
      expect(Object.keys(hb as object).sort(), 'top-level key parity').toEqual(Object.keys(gb as object).sort());
    });
    await test.step('Invoice missing_record ≡ work-order missing_record: same status (200), same error_code, same key set (AC3 WO parity)', async () => {
      const hb = hidden.body as Body, wb = wo.body as Body;
      expect(wo.status, 'WO show missing_record is HTTP 200 too').toBe(hidden.status);
      expect(wb.error_code, 'WO error_code matches invoice').toBe(hb.error_code);
      expect(wb.success, 'WO success:false matches invoice').toBe(hb.success);
      expect(Object.keys(wb as object).sort(), 'WO top-level key set matches invoice').toEqual(Object.keys(hb as object).sort());
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Identical missing_record shape across invoice-hidden, invoice-nonexistent, and work-order show',
      persona: `${filteredPersona}  +  ${adminPersona}`, method: 'GET', url: `${hiddenUrl} · ${ghostUrl} · ${woUrl}`,
      requestBody: {},
      status: hidden.status, responseBody: { invoice_hidden: hidden.body, invoice_nonexistent: ghost.body, workorder_show: wo.body },
    });
  });

  test('no read permission at all: 401 on every endpoint, for existent and nonexistent ids', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Response2] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'User with zero invoice/quote grants — class-level authorize_resource must 401 before any load',
      persona: noreadPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].visible_id)).join('  |  '),
      requestBody: { note: 'Also probes a nonexistent id — 401 must win over missing_record (no id-existence oracle for unauthorized users).' },
    });

    const outcomes: Record<string, unknown> = {};
    // Authn control: prove the token is VALID (authenticates) so the invoice
    // 401s are authorization denials, not an invalid/expired bearer. The noread
    // user holds read on Products::Product — a 200 there proves the identity.
    await test.step('GET /api/v1/products.json as no-read user → 200 (token authenticates; 401s below are authZ, not authN)', async () => {
      const { status } = await apiGet(request, '/api/v1/products.json?limit=1', m.api_auth.tokens.noread);
      outcomes['authn_control_products'] = status;
      expect(status, 'noread token authenticates (holds read on Products::Product)').toBe(200);
    });
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.visible_id);
      await test.step(`GET ${url} as no-read user → 401 (class-level authorize_resource unchanged)`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.noread);
        outcomes[key] = { status, body };
        expect(status, `${key}: 401`).toBe(401);
      });
    }
    const ghostUrl = showUrl(m.scope.classes.subcontractor_invoice, NONEXISTENT_ID);
    await test.step(`GET ${ghostUrl} (nonexistent id) as no-read user → still 401, not missing_record`, async () => {
      const { status } = await apiGet(request, ghostUrl, m.api_auth.tokens.noread);
      outcomes['nonexistent_id'] = status;
      expect(status).toBe(401);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'All invoice probes 401 (authZ denial, token proven valid on /products); no payload, no existence signal',
      persona: noreadPersona, method: 'GET', url: 'four show endpoints + nonexistent id (+ /products authn control)',
      requestBody: {}, status: 401, responseBody: outcomes,
    });
  });

  test('denying instance_methods rule: still 401 on all four endpoints (the 34b03ef84a guard)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Response2, TANGO_86_AC.NonDisruptive1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Instance-rule user (total < 0 denies; totals recalc to >= 0) — the explicit authorize! must still 401',
      persona: instancerulePersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].visible_id)).join('  |  '),
      requestBody: { note: 'Guards the regression fixed in 34b03ef84a: accessible_by cannot express instance_methods rules (conditions [] -> unrestricted), so only the restored authorize! enforces them. Deliberate asymmetry: instance denial = 401, sql denial = missing_record.' },
    });

    const outcomes: Record<string, number> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.visible_id);
      await test.step(`GET ${url} as instance-rule-denied user → 401 (instance rule enforced by authorize!, not accessible_by)`, async () => {
        const { status } = await apiGet(request, url, m.api_auth.tokens.instancerule);
        outcomes[key] = status;
        expect(status, `${key}: 401`).toBe(401);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four endpoints 401 for the instance-rule-denied user',
      persona: instancerulePersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: {}, status: 401, responseBody: outcomes,
    });
  });

  test('super_admin is unaffected: hidden and visible fixtures all load, and appear on the grid feed', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.NonDisruptive1, TANGO_86_AC.Regression2] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Super-admin sweep: 8 shows (4 hidden + 4 visible) + hidden-id index probes',
      persona: adminPersona, method: 'GET',
      url: `${m.scope.classes.subcontractor_invoice.endpoint}/… (all four endpoints)`,
      requestBody: { note: 'manage-all rule -> accessible_by unscoped. Guards the largest population (admins) against over-restriction from the accessible_by switch.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      for (const [label, id] of [['hidden', scope.hidden_id], ['visible', scope.visible_id]] as const) {
        const url = showUrl(scope, id);
        await test.step(`GET ${url} as super_admin → ${label} ${scope.model} id=${id} loads normally`, async () => {
          const { status, body } = await apiGet(request, url, m.api_auth.tokens.admin);
          const b = body as Body;
          outcomes[`${key}.${label}`] = { status, invoices_id: b.invoices?.id };
          expect(status, `${key}/${label}: status`).toBe(200);
          expect(b.invoices?.id, `${key}/${label}: record returned`).toBe(id);
        });
      }
      const idxUrl = indexUrl(scope);
      await test.step(`GET ${idxUrl} as super_admin → the "hidden" fixture id=${scope.hidden_id} appears on the admin grid feed (it is only hidden for the filtered group)`, async () => {
        const { status, body } = await apiGet(request, idxUrl, m.api_auth.tokens.admin);
        expect(status, `${key}: index status`).toBe(200);
        expect(indexRows(body).some(r => r.id === scope.hidden_id), `${key}: hidden id on admin index`).toBe(true);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Super-admin sees all 8 fixtures by direct link and the hidden ids on the grid feed',
      persona: adminPersona, method: 'GET', url: 'all four endpoints (show + index)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('permitted user payload intact: the FILTERED user (scoped accessible_by path) still gets the full eager_load tree on all four controllers', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Regression1] });
    const m = manifest!;
    // Run as the FILTERED user, not admin: the whole point of AC5 is that a user
    // whose group carries a sql_string filter (and therefore traverses the new
    // accessible_by(...).eager_load(...) scoped path) still receives the full
    // payload for records they CAN see. Admin bypasses that path entirely.
    // Probe records are all outside the hidden set, so the filtered user sees them.
    // Rails OMITS a nil singular association key, so per-class required lists
    // name only associations reliably populated on the probe; the full key set
    // is reported for the reader.
    const requiredByClass: Record<ClassKey, string[]> = {
      subcontractor_invoice: ['id', 'type', 'exchanged_info', 'object_invoices', 'subcontractor_invoice_payments', 'billable_role', 'line_items', 'object_state', 'payable_role', 'stores', 'workorder'],
      subcontractor_quote:   ['id', 'type', 'object_invoices', 'line_items', 'object_state'],
      client_invoice:        ['id', 'object_invoices', 'line_items', 'object_state'],
      client_quote:          ['id', 'object_invoices', 'line_items', 'object_state'],
    };

    await renderExchange(testInfo, page, 'before', {
      title: 'Full-payload probes across all four controllers, fetched by the FILTERED user (scoped path)',
      persona: filteredPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].payload_probe_id)).join('  |  '),
      requestBody: { required_keys_by_class: requiredByClass, note: 'Filtered persona traverses the exact accessible_by(...).eager_load(...) path the fix introduced; admin would bypass it.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.payload_probe_id);
      const required = requiredByClass[key];
      await test.step(`GET ${url} as filtered user → ${scope.model} payload carries all ${required.length} required SHOW-template keys`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.filtered);
        expect(status, `${key}: status`).toBe(200);
        const rec = (body as Body).invoices as Record<string, unknown>;
        expect(rec, `${key}: invoices root present`).toBeTruthy();
        const actual = Object.keys(rec);
        const missing = required.filter(k => !actual.includes(k));
        expect(missing, `${key}: missing SHOW-template keys: ${missing.join(', ')}`).toEqual([]);
        outcomes[key] = { status, id: rec.id, key_count: actual.length, line_items_count: Array.isArray(rec.line_items) ? (rec.line_items as unknown[]).length : null };
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All four controllers return the full eager_load tree for the filtered user — tree untouched end to end',
      persona: filteredPersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: { required_keys_by_class: requiredByClass },
      status: 200, responseBody: outcomes,
    });
  });

  test('grid feed: filtered user index excludes the hidden record and includes the visible one (all four classes)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Regression2] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Index (grid feed) as the filtered user — full dev-sized feed, asserted on the id set',
      persona: filteredPersona, method: 'GET',
      url: CLASS_KEYS.map(k => indexUrl(m.scope.classes[k])).join('  |  '),
      requestBody: { filter_sql: m.scope.filter_sql, note: 'Grid behavior is the pre-existing enforcement path — must be unchanged: hidden stays hidden, visible stays visible.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const idxUrl = indexUrl(scope);
      await test.step(`GET ${idxUrl} as filtered user → grid feed excludes hidden id=${scope.hidden_id} and includes visible id=${scope.visible_id}`, async () => {
        const { status, body } = await apiGet(request, idxUrl, m.api_auth.tokens.filtered);
        const ids = indexRows(body).map(r => r.id);
        outcomes[key] = { status, row_count: ids.length, has_hidden: ids.includes(scope.hidden_id), has_visible: ids.includes(scope.visible_id) };
        expect(status, `${key}: index status`).toBe(200);
        expect(ids.includes(scope.hidden_id), `${key}: hidden id absent from grid`).toBe(false);
        expect(ids.includes(scope.visible_id), `${key}: visible id on grid`).toBe(true);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Grid parity holds on all four classes: hidden ids filtered out, visible ids returned',
      persona: filteredPersona, method: 'GET', url: 'four index endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('destroy behavior unchanged: no destroy action is exposed, and DELETE probes cannot remove records', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Regression3] });
    const m = manifest!;
    const scope = m.scope.classes.subcontractor_invoice;
    const url = showUrl(scope, scope.visible_id);

    await renderExchange(testInfo, page, 'before', {
      title: `DELETE probes against visible fixtures (all four endpoints)`,
      persona: `${noreadPersona}  +  ${filteredPersona}`, method: 'DELETE', url,
      requestBody: { note: "Shipped reality (unchanged by TANGO-86): none of the four controllers defines a destroy action — DELETE raises Unknown action ('destroy' could not be found) even though the load_and_authorize_resource only: list names :destroy (dead config). This test pins that no DELETE path can remove a record." },
    });

    const outcomes: Record<string, string> = {};
    const probeDelete = async (delUrl: string, token: string, label: string) => {
      try {
        const { status } = await apiDelete(request, delUrl, token);
        outcomes[label] = `HTTP ${status}`;
        expect(status, `${label}: DELETE must not succeed`).toBeGreaterThanOrEqual(400);
      } catch {
        // Dev-mode "Unknown action" HTML error page breaks the JSON/keep-alive
        // parse — same signal: no destroy endpoint exists.
        outcomes[label] = "unknown-action error (no destroy action defined)";
      }
    };
    for (const key of CLASS_KEYS) {
      const s = m.scope.classes[key];
      const delUrl = showUrl(s, s.visible_id);
      await test.step(`DELETE ${delUrl} as no-read user → rejected (no destroy action on ${s.model})`, async () => {
        await probeDelete(delUrl, m.api_auth.tokens.noread, `noread.${key}`);
      });
    }
    await test.step(`DELETE ${url} as filtered user (read-only grants) → rejected`, async () => {
      await probeDelete(url, m.api_auth.tokens.filtered, 'filtered.subcontractor_invoice');
    });
    for (const key of CLASS_KEYS) {
      const s = m.scope.classes[key];
      const getUrl = showUrl(s, s.visible_id);
      await test.step(`GET ${getUrl} as super_admin → ${s.model} id=${s.visible_id} still exists after the DELETE probes`, async () => {
        const { status, body } = await apiGet(request, getUrl, m.api_auth.tokens.admin);
        expect(status).toBe(200);
        expect((body as Body).invoices?.id, `${key}: record survived`).toBe(s.visible_id);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'No DELETE probe removed anything; all four records intact (destroy action does not exist — unchanged)',
      persona: noreadPersona, method: 'DELETE', url,
      requestBody: {}, status: 200, responseBody: outcomes,
      note: 'Finding for the ticket: :destroy in the load_and_authorize_resource only: lists is dead config — no destroy action exists on any of the four controllers (pre-existing, unchanged).',
    });
  });

  test('informational: join-referencing sql_string on show (post-fix behavior for filters naming joined tables)', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.NonDisruptive1] });
    const m = manifest!;
    const scope = m.scope.classes.subcontractor_invoice;
    const url = showUrl(scope, scope.visible_id);

    await renderExchange(testInfo, page, 'before', {
      title: 'Probe: sql_string referencing stores.* (a joined table) on the new accessible_by show path',
      persona: joinsqlPersona, method: 'GET', url,
      requestBody: { note: 'Pre-fix, show ignored sql_string entirely, so join-referencing filters "worked" by accident. Post-fix the filter participates in the show query. This records the shipped outcome; the model probe already showed the bare relation raises PG::UndefinedTable.' },
    });

    let result!: ApiResult;
    await test.step(`GET ${url} as join-sql user → record the shipped outcome (documented, not gated)`, async () => {
      result = await apiGet(request, url, m.api_auth.tokens.joinsql);
      const b = result.body as Body;
      // Sane outcomes: the record loads (join present on show) or a handled
      // error body. What must NOT happen: a wrong record, or an unhandled
      // non-JSON 500 page.
      if (b.invoices) {
        expect(b.invoices.id, 'if a record is returned it must be the requested one').toBe(scope.visible_id);
      } else {
        expect(typeof b, 'error body is structured JSON (error_catcher handled it)').toBe('object');
        expect(b.success, 'handled error body carries success:false').toBe(false);
      }
    });

    await renderExchange(testInfo, page, 'after', {
      title: `Shipped outcome for join-referencing sql_string on show: HTTP ${result.status}`,
      persona: joinsqlPersona, method: 'GET', url,
      requestBody: {}, status: result.status, responseBody: result.body,
      note: 'If this shows an error body: customers whose visibility filters reference joined tables lose direct-link access after this fix (they previously bypassed the filter entirely). Flagged for the ticket as OQ2 follow-on material.',
    });
  });

  test('non-disruptive positive control: a vanilla reader (no sql_string, no instance rule) opens every fixture on all four endpoints', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.NonDisruptive1, TANGO_86_AC.Regression1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'The unaffected customer: bare read grants, no visibility filter — must see every record',
      persona: vanillaPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].hidden_id)).join('  |  '),
      requestBody: { note: 'AC8 positive: customers who do NOT use SQL-string filters are unchanged. Even the "hidden" fixtures (only hidden for the filtered group) load for this user.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      for (const [label, id] of [['hidden', scope.hidden_id], ['visible', scope.visible_id]] as const) {
        const url = showUrl(scope, id);
        await test.step(`GET ${url} as vanilla reader → ${label} ${scope.model} id=${id} loads (no filter applies)`, async () => {
          const { status, body } = await apiGet(request, url, m.api_auth.tokens.vanilla);
          outcomes[`${key}.${label}`] = { status, invoices_id: (body as Body).invoices?.id };
          expect(status, `${key}/${label}: status`).toBe(200);
          expect((body as Body).invoices?.id, `${key}/${label}: record returned`).toBe(id);
        });
      }
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Vanilla reader sees all 8 fixtures — no behavior change for non-filter customers',
      persona: vanillaPersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('instance-rule positive control: a QUALIFYING instance rule (total >= 0) loads the record on all four endpoints', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.Regression1, TANGO_86_AC.NonDisruptive1] });
    const m = manifest!;

    await renderExchange(testInfo, page, 'before', {
      title: 'Qualifying instance rule — proves the instance-block path is LIVE and discriminating',
      persona: instancepassPersona, method: 'GET',
      url: CLASS_KEYS.map(k => showUrl(m.scope.classes[k], m.scope.classes[k].visible_id)).join('  |  '),
      requestBody: { note: 'Positive counterpart to the denying-instance-rule 401 test: same rule shape, passing operator (total >= 0) → record loads. Together they prove the denying test’s 401 comes from the authorize! instance block (34b03ef84a), not a dead grant.' },
    });

    const outcomes: Record<string, unknown> = {};
    for (const key of CLASS_KEYS) {
      const scope = m.scope.classes[key];
      const url = showUrl(scope, scope.visible_id);
      await test.step(`GET ${url} as qualifying-instance user → ${scope.model} id=${scope.visible_id} loads (instance block passes)`, async () => {
        const { status, body } = await apiGet(request, url, m.api_auth.tokens.instancepass);
        outcomes[key] = { status, invoices_id: (body as Body).invoices?.id };
        expect(status, `${key}: status`).toBe(200);
        expect((body as Body).invoices?.id, `${key}: record returned`).toBe(scope.visible_id);
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'Qualifying instance rule loads all four — the instance path is live (validates the denial test)',
      persona: instancepassPersona, method: 'GET', url: 'four show endpoints (see request card)',
      requestBody: {}, status: 200, responseBody: outcomes,
    });
  });

  test('combined sql + instance rule: enforcement ordering — sql-hidden → missing_record, sql-visible-but-instance-denied → 401', async ({ page, request }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.DirectLink1, TANGO_86_AC.Response2] });
    const m = manifest!;
    const scope = m.scope.classes.subcontractor_invoice;   // combined grant is on this class only
    const hiddenUrl = showUrl(scope, scope.hidden_id);
    const visibleUrl = showUrl(scope, scope.visible_id);

    await renderExchange(testInfo, page, 'before', {
      title: 'One grant, both rule types — which enforcement point wins on each record?',
      persona: combinedPersona, method: 'GET', url: `${hiddenUrl}  vs  ${visibleUrl}`,
      requestBody: { note: 'sql_string filters via accessible_by (before the record is found); the instance rule fires in authorize! (after find). Expected: sql-hidden → missing_record (never reaches the block); sql-visible → in scope but instance-denied → 401.' },
    });

    let hidden!: ApiResult;
    let visible!: ApiResult;
    await test.step(`GET ${hiddenUrl} (sql-hidden) as combined user → missing_record (accessible_by wins first, HTTP 200)`, async () => {
      hidden = await apiGet(request, hiddenUrl, m.api_auth.tokens.combined);
      expect(hidden.status, 'hidden: HTTP 200').toBe(200);
      expect((hidden.body as Body).error_code, 'hidden: missing_record').toBe('missing_record');
    });
    await test.step(`GET ${visibleUrl} (passes sql, fails instance) as combined user → 401 (authorize! instance block denies)`, async () => {
      visible = await apiGet(request, visibleUrl, m.api_auth.tokens.combined);
      expect(visible.status, 'visible-but-instance-denied: 401').toBe(401);
    });

    await renderExchange(testInfo, page, 'after', {
      title: 'Ordering confirmed: sql denial → missing_record; instance denial on an in-scope record → 401',
      persona: combinedPersona, method: 'GET', url: `${hiddenUrl} · ${visibleUrl}`,
      requestBody: {}, status: visible.status,
      responseBody: { sql_hidden: { status: hidden.status, body: hidden.body }, sql_visible_instance_denied: { status: visible.status, body: visible.body } },
    });
  });

  test('OQ2 documentation: parallel access paths NOT closed by this fix (sign-off covers the 4 show actions only)', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.DirectLink2] });
    // This test intentionally makes no HTTP assertion — it exists to land an
    // explicit "not covered by this sign-off" record in the report so a green
    // suite is not misread as "every path to a hidden invoice is closed."
    const leakDoors = [
      { endpoint: 'GET /api/v1/subcontractor_invoices/:id/ready_to_pay', file: 'subcontractor_invoices_controller.rb:282', issue: 'plain .find (no accessible_by) — leaks ready_to_pay + client_funding_source of a hidden invoice.' },
      { endpoint: 'PUT /api/v1/subcontractor_invoices/:id/clear_export_date', file: 'subcontractor_invoices_controller.rb:371', issue: 'find_by gated only by an adjunct permission; renders the full record — read AND mutate a hidden invoice.' },
      { endpoint: 'POST pay_invoice / cancel_invoice_payment', file: 'subcontractor_invoices_controller.rb:327/344', issue: 'plain find — mutations reachable on hidden records for users holding the DwollaTransfer grant.' },
      { endpoint: 'GET *_invoice_line_items / *_quote_line_items (index, show)', file: '*_line_items_controller.rb', issue: 'authorized against the LineItem class (no sql filter); index embeds the parent invoice — leaks hidden-invoice data via the child grid.' },
      { endpoint: 'GET subcontractor_invoice_payments', file: 'subcontractor_invoice_payments_controller.rb', issue: 'authorized against Payment; leaks amount/check_number/paid_date of a hidden invoice.' },
      { endpoint: 'GET api/ev1 invoice/quote show (vendor portal)', file: 'api/ev1/*_controller.rb', issue: 'uses accessible_by but MISSING the authorize! :show that v1 added — instance_methods-only hides are bypassed (same gap 34b03ef84a fixed for v1).' },
    ];

    await renderExchange(testInfo, page, 'before', {
      title: 'Scope boundary — the 4 show actions are fixed; these adjacent paths are NOT (OQ2 follow-on)',
      persona: 'documentation (no request issued)', method: 'N/A', url: '—',
      requestBody: { covered_by_tango86: ['subcontractor_invoices#show', 'subcontractor_quotes#show', 'client_invoices#show', 'client_quotes#show'] },
    });
    for (const d of leakDoors) {
      await test.step(`NOT COVERED — ${d.endpoint}  [${d.file}]: ${d.issue}`, async () => { /* documentation only */ });
    }
    await test.step('ALSO documented: :destroy in the load_and_authorize_resource only: lists is dead config (no destroy action exists on any of the 4 controllers).', async () => { /* documentation only */ });
    await test.step('ALSO documented: update still uses load_and_authorize_resource’s bare find (sql block returns true), so a user who can UPDATE can still PUT an sql-hidden record — the write path is not scoped by this fix (deliberate scope boundary).', async () => { /* documentation only */ });

    await renderExchange(testInfo, page, 'after', {
      title: 'Untested-by-design: these paths still reach hidden-invoice data — OQ2 follow-on, not part of this sign-off',
      persona: 'documentation (no request issued)', method: 'N/A', url: '—',
      requestBody: { parallel_leak_doors: leakDoors },
      status: 200, responseBody: { message: 'Recorded for the ticket. These are pre-existing and out of TANGO-86 scope; the suite proves only the 4 parent show endpoints.' },
    });
  });

  test('seed model checks: accessible_by layer agrees with everything asserted over HTTP', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_86_AC.DirectLink1, TANGO_86_AC.Response2, TANGO_86_AC.Regression2] });
    const m = manifest!;
    const checks = m.model_checks ?? [];
    const gated = checks.filter(c => c.ac !== 'info');
    const info = checks.filter(c => c.ac === 'info');

    await renderExchange(testInfo, page, 'before', {
      title: 'Seed-recorded ability-layer checks (accessible_by — the enforcement point for sql_string rules)',
      persona: 'rails runner (model layer)', method: 'SEED', url: 'seeds/invoice-visibility-filters.rb',
      requestBody: { gated: gated.map(c => c.name), informational: info.map(c => c.name) },
    });

    await test.step(`Verify the seed recorded the ability-layer checks (${gated.length} gated + ${info.length} informational)`, async () => {
      expect(gated.length, 'expected >= 5 gated checks (4 per-class + noread)').toBeGreaterThanOrEqual(5);
    });
    for (const c of gated) {
      await test.step(`${c.ac} — ${c.name}: ${c.detail}`, async () => {
        expect(c.passed, `model check failed: ${c.detail}`).toBe(true);
      });
    }
    for (const c of info) {
      await test.step(`INFO — ${c.name}: ${c.detail}`, async () => {
        // Informational: recorded for the report, never gates the suite.
      });
    }

    await renderExchange(testInfo, page, 'after', {
      title: 'All gated ability-layer checks passed',
      persona: 'rails runner (model layer)', method: 'SEED', url: 'seeds/invoice-visibility-filters.rb',
      requestBody: { gated: gated.map(c => ({ name: c.name, passed: c.passed })) },
      status: 200, responseBody: checks,
    });
  });
});
