import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import { annotateAc, captureAcSnapshot, TANGO_111_AC } from '../../src/support/qa-report';

/**
 * Block negative line item values behind a site setting — TANGO-111.
 *
 * SCOPE NOTE. The AC in the ticket description covers the ORIGINAL request
 * (expose line item + product-classification totals as configurable data points
 * in billing requirements and workflow definitions). michelle.klaer deferred
 * that on 2026-07-14 over performance and system-validation risk; it was cloned
 * to TANGO-82 and re-scoped. The shipped behavior — and therefore what this
 * suite asserts — is Christina Schechter's alternative from the comments: a
 * site setting `allow_negative_line_item_values`, defaulting to TRUE (allow),
 * which when set to FALSE blocks saving a line item whose total
 * (quantity * unit_price) is not greater than zero.
 *
 * Implementation under test:
 *   - Invoices::LineItem#ensure_value_is_not_negative — the authoritative check.
 *     Lives on the shared STI parent, so one rule covers vendor quote, vendor
 *     invoice, client quote and client invoice. Fires only on create or when
 *     quantity/unit_price change, which is what grandfathers existing rows.
 *   - InvoiceController.js#lineItemTotalIsAllowed — client-side fast path.
 *   - InvoiceController.js#extractOperationErrorString — surfaces the server's
 *     specific message instead of the old generic "Could not save line item!".
 *   - Invoices::Invoice#copy_line_items_from_source — records skipped rows.
 *
 * Pre-requisite: `npm run seed:negative-line-item-values`. The seed resets the
 * setting to TRUE and creates a genuinely-negative line item on invoice 26
 * through the ordinary validated path (no bypass flag) — so the fixture itself
 * is evidence that negatives are permitted while the setting is on.
 *
 * Ext helpers below (waitForFexaApp / gotoInvoice / openNewLineItemForm /
 * selectProduct / cancelLineItemForm) are lifted from
 * tests/pricing/enforced-rate.spec.ts, which owns the proven cold-start and
 * InfiniteCombo retry protocol. Deliberately duplicated rather than refactored
 * — per the cmms target reference, that Ext interaction knowledge is not to be
 * restyled or deduped as part of unrelated work.
 */

const TICKET = 'TANGO-111';

const SETTING_NAME = 'allow_negative_line_item_values';

// Fixtures from seeds/negative-line-item-values.rb (all Draft / New, admin-editable)
const SOURCE_INVOICE_ID = 26;   // carries the seeded negative + positive lines
const TARGET_INVOICE_ID = 28;   // duplication target, seeded empty
const CLIENT_QUOTE_ID   = 156;  // client-side create/block scenario
const PRODUCT_ID        = 18;
const CLASSIFICATION_ID = 1;

const NEGATIVE_FIXTURE_DESCRIPTION = '[QA] TANGO-111 negative credit line';
const POSITIVE_FIXTURE_DESCRIPTION = '[QA] TANGO-111 positive companion line';

/** Exact copy from config/locales/en.yml invoice.line_items.errors.negative_value_not_allowed */
const BLOCK_MESSAGE =
  'Negative line item values are not allowed. Please update the quantity or rate so that the line item total is greater than zero.';

/** The generic toast this ticket replaces — must NOT be what the user sees. */
const GENERIC_MESSAGE = 'Could not save line item!';

// --- Ext helpers (see file header) ------------------------------------------

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

async function gotoInvoice(page: Page, ctype: 'invoice' | 'clientquote', id: number): Promise<void> {
  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await page.evaluate(({ ctype, id }) => {
      (window as any).Ext.History.add(`${ctype}/${id}`);
    }, { ctype, id });
    try {
      await page.waitForFunction(() => {
        return (window as any).Ext.ComponentQuery.query('lineitemgrid').length > 0;
      }, null, { timeout: attempt === 0 ? 45_000 : 30_000 });
      await page.waitForTimeout(2500);
      return;
    } catch {
      await page.waitForTimeout(1500);
    }
  }
  throw new Error(`gotoInvoice: lineitemgrid never appeared after ${MAX_ATTEMPTS} attempts (${ctype}/${id})`);
}

async function openNewLineItemForm(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const form = grid?.down?.('formpanel');
      if (form?.isVisible?.()) {
        form.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
      }
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
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        const saveBtn = Ext.ComponentQuery.query('button[reference=saveLineItemBtn]')
          .some((b: any) => b.isVisible?.());
        const productField = form?.query?.('[name=product_id]')[0];
        return saveBtn && productField && productField.isVisible?.();
      }, null, { timeout: 25_000 });
      await page.waitForTimeout(2500);
      return;
    } catch {
      // retry
    }
  }
  throw new Error('openNewLineItemForm: failed to open form after 3 attempts');
}

async function selectProduct(page: Page, productId: number | null, classificationId: number | null): Promise<void> {
  if (classificationId != null) {
    await page.evaluate((cid) => {
      const Ext = (window as any).Ext;
      const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
      const form = grid?.down?.('formpanel');
      form?.query?.('[name="product.product_classification_id"]')[0]?.setValue(cid);
    }, classificationId);
    await page.waitForTimeout(800);
  }
  if (productId != null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate((pid) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const form = grid?.down?.('formpanel');
        form?.query?.('[name=product_id]')[0]?.setValue(pid);
      }, productId);
      try {
        await page.waitForFunction(() => {
          const Ext = (window as any).Ext;
          const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
          const form = grid?.down?.('formpanel');
          return form?.query?.('[name=product_id]')[0]?.getValue?.() != null;
        }, null, { timeout: 5_000 });
        break;
      } catch {
        await page.waitForTimeout(1500);
      }
    }
  }
  await page.waitForTimeout(2500);
}

async function cancelLineItemForm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const form = grid?.down?.('formpanel');
    form?.query?.('button[action=cancel]')[0]?.element?.dom?.click?.();
  });
  await page.waitForTimeout(500);
}

// --- TANGO-111 specific helpers ---------------------------------------------

const FZ = process.env.FEXY_ZAMO_PATH || path.resolve(process.env.HOME || '', 'work/Fexy-Zamo');

/**
 * Flip the site setting, then hard-reload so the client `_SSetting` singleton —
 * which loads once at app boot from /main/get_ssettings — picks the new value
 * up. Skipping that reload is the easiest way to get a false pass here.
 *
 * Why shell out rather than call PUT /api/v1/site_settings/:id: that endpoint is
 * super_admin-only and the QA `admin` persona is not a super_admin. Granting it
 * super_admin to suit this suite would silently change what every other suite
 * exercises, so the mutation goes through support/tango111-setting.rb instead
 * (same execSync + rails runner idiom as tests/invoice/gl-code-removal.spec.ts).
 * That script still writes via SiteSetting.set_with_validation — the same class
 * method the admin Settings screen uses — and aborts if the value fails to land
 * as a real boolean.
 */
function writeSettingViaRunner(allowed: boolean): any {
  const script = path.resolve(__dirname, '../../support/tango111-setting.rb');
  const cmd = `cd "${FZ}" && DISABLE_SPRING=1 RUBYOPT='-W0' T111_VALUE=${allowed} bundle exec rails runner "${script}"`;
  const out = execSync(cmd, { cwd: process.cwd(), shell: '/bin/bash', encoding: 'utf8', timeout: 200_000 });
  const line = out.split('\n').find((l) => l.startsWith('T111_JSON='));
  if (!line) throw new Error(`tango111-setting.rb produced no T111_JSON line. Output:\n${out}`);
  return JSON.parse(line.replace('T111_JSON=', ''));
}

async function setNegativeValuesAllowed(page: Page, allowed: boolean): Promise<void> {
  const written = writeSettingViaRunner(allowed);
  expect(written.typed_value, `${SETTING_NAME} should persist as a real boolean ${allowed}`).toBe(allowed);
  expect(written.value_type, 'value_type must stay boolean or the model guard never matches').toBe('boolean');

  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForFexaApp(page);

  const clientValue = await page.evaluate((name) => {
    return (window as any)._SSetting?.get(name);
  }, SETTING_NAME);
  expect(clientValue, `_SSetting.get('${SETTING_NAME}') should be ${allowed} in the browser after reload`).toBe(allowed);
}

/** Type quantity + rate (and a description) into the open line item form. */
async function fillLineItemAmounts(page: Page, quantity: number, unitPrice: number, description: string): Promise<void> {
  await page.evaluate(({ quantity, unitPrice, description }) => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const form = grid?.down?.('formpanel');
    form?.query?.('[name=quantity]')[0]?.setValue(quantity);
    form?.query?.('[name=unit_price]')[0]?.setValue(unitPrice);
    const desc = form?.query?.('[name=description]')[0];
    if (desc) desc.setValue(description);
  }, { quantity, unitPrice, description });
  await page.waitForTimeout(800);
}

/** Click Save on the open line item form. */
async function clickSaveLineItem(page: Page): Promise<void> {
  const rect = await page.evaluate(() => {
    const btn = (window as any).Ext.ComponentQuery
      .query('button[reference=saveLineItemBtn]')
      .find((b: any) => b.isVisible?.());
    const el = btn?.element?.dom;
    el?.scrollIntoView?.({ block: 'center' });
    const r = el?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!rect) throw new Error('saveLineItemBtn not found or not visible');
  await page.waitForTimeout(300);
  await page.mouse.click(rect.x, rect.y);
  await page.waitForTimeout(2500);
}

/** All visible toast/msgbox copy currently on screen. */
async function visibleToastText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.x-toast,.x-msgbox'))
      .filter((n) => (n as HTMLElement).offsetParent !== null)
      .map((n) => (n as HTMLElement).innerText.trim())
      .join(' | ');
  });
}

function toastLocator(page: Page) {
  return page.locator('.x-toast').first();
}

/** Line items currently in the grid store, read from the store (grid is virtualized). */
async function gridLineItems(page: Page): Promise<Array<{ description: string; quantity: number; unit_price: number }>> {
  return await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    const store = grid?.getStore?.();
    const out: any[] = [];
    store?.each?.((rec: any) => {
      out.push({
        description: rec.get('description'),
        quantity: Number(rec.get('quantity')),
        unit_price: Number(rec.get('unit_price')),
      });
    });
    return out;
  });
}

/**
 * Locator for the line item grid, resolved from the Ext component's own DOM id.
 * Ext modern generates its class names, so a hard-coded CSS class is guesswork —
 * the cmms target reference is explicit that selectors come from the component
 * tree, not the DOM.
 */
async function lineItemGridLocator(page: Page) {
  const id = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
    return grid?.element?.dom?.id || null;
  });
  if (!id) throw new Error('lineItemGridLocator: lineitemgrid component not found');
  return page.locator(`#${id}`);
}

// --- Tests ------------------------------------------------------------------

test.describe('Block negative line item values behind a site setting (TANGO-111)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'admin', 'Admin-only run: admin is the persona that configures the setting and edits invoices');
  });

  test('Setting ON (shipped default) — a negative line item saves, preserving existing behavior', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Setting3] });

    await test.step(`Set ${SETTING_NAME} = true (the shipped default)`, async () => {
      await setNegativeValuesAllowed(page, true);
    });
    await test.step(`Navigate to SubcontractorInvoice #${SOURCE_INVOICE_ID}`, async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
    });

    await captureAcSnapshot(testInfo, page, 'before', {
      focus: await lineItemGridLocator(page),
      label: `Setting ON — invoice #${SOURCE_INVOICE_ID} line items before adding a negative line`,
    });

    await test.step('Click "+" to open a new line item form', async () => { await openNewLineItemForm(page); });
    await test.step(`Set Product Class = ${CLASSIFICATION_ID}, Product = ${PRODUCT_ID}`, async () => {
      await selectProduct(page, PRODUCT_ID, CLASSIFICATION_ID);
    });
    await test.step('Enter Quantity = 1, Rate = -50 (line total -50)', async () => {
      await fillLineItemAmounts(page, 1, -50, '[QA] TANGO-111 allowed negative');
    });
    await test.step('Click Save', async () => { await clickSaveLineItem(page); });

    await test.step('Verify the negative line persisted and NO blocking toast appeared', async () => {
      const toasts = await visibleToastText(page);
      expect(toasts, 'the block message must not appear while the setting allows negatives').not.toContain(BLOCK_MESSAGE);

      const items = await gridLineItems(page);
      const saved = items.find((i) => i.description === '[QA] TANGO-111 allowed negative');
      expect(saved, 'the negative line item should be in the grid store').toBeTruthy();
      expect(saved!.quantity * saved!.unit_price).toBeLessThan(0);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: await lineItemGridLocator(page),
      label: 'Setting ON — negative line (qty 1 x rate -50) saved successfully; existing customer behavior unchanged',
    });
  });

  test('Setting OFF — saving a negative line item is blocked with the specific message, not the generic one', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Setting1, TANGO_111_AC.Toast1] });

    await test.step(`Set ${SETTING_NAME} = false (customer opts out of negatives)`, async () => {
      await setNegativeValuesAllowed(page, false);
    });
    await test.step(`Navigate to SubcontractorInvoice #${SOURCE_INVOICE_ID}`, async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
    });
    await test.step('Click "+" to open a new line item form', async () => { await openNewLineItemForm(page); });
    await test.step(`Set Product Class = ${CLASSIFICATION_ID}, Product = ${PRODUCT_ID}`, async () => {
      await selectProduct(page, PRODUCT_ID, CLASSIFICATION_ID);
    });

    await captureAcSnapshot(testInfo, page, 'before', {
      focus: page.locator('input[name=unit_price]').first(),
      label: 'Setting OFF — new line item form open, Rate field editable, no message shown yet',
    });

    await test.step('Enter Quantity = 1, Rate = -50 (line total -50) and click Save', async () => {
      await fillLineItemAmounts(page, 1, -50, '[QA] TANGO-111 blocked negative');
      await clickSaveLineItem(page);
    });

    await test.step(`Verify the toast reads the specific copy, NOT "${GENERIC_MESSAGE}"`, async () => {
      await expect(toastLocator(page)).toBeVisible({ timeout: 10_000 });
      const toasts = await visibleToastText(page);
      expect(toasts, 'the specific negative-value message must be shown').toContain(BLOCK_MESSAGE);
      expect(toasts, 'the old generic message must no longer be what the user sees').not.toContain(GENERIC_MESSAGE);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: toastLocator(page),
      label: 'Setting OFF — save blocked; toast shows the specific negative-value message, not the generic one',
    });

    await test.step('Cancel the form', async () => { await cancelLineItemForm(page); });

    // The Ext store still holds the phantom row the form created client-side, so
    // asserting against the store here would prove nothing about persistence.
    // Reload the invoice so the store refetches from the server, and ask the
    // server directly.
    await test.step('Reload the invoice and verify the blocked line was never persisted', async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
      const items = await gridLineItems(page);
      expect(
        items.find((i) => i.description === '[QA] TANGO-111 blocked negative'),
        'the blocked line must not exist server-side after a reload',
      ).toBeFalsy();
    });

    // The client-side guard short-circuits before any request is sent, so the
    // steps above exercise only the fast path. Post the same negative line
    // straight at the API to prove Invoices::LineItem enforces it independently
    // — that is the layer that actually protects the Oracle export, and the only
    // one that covers non-GUI callers.
    await test.step('POST the same negative line directly to the API, bypassing the client-side guard', async () => {
      const result = await page.evaluate(async ({ invoiceId, productId }) => {
        const Ext = (window as any).Ext;
        return await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: '/api/v1/subcontractor_invoice_line_items.json',
            method: 'POST',
            jsonData: {
              line_items: {
                invoice_id: invoiceId,
                product_id: productId,
                quantity: 1,
                unit_price: -50,
                taxable: false,
                tax_rate: 0,
                description: '[QA] TANGO-111 api bypass attempt',
              },
            },
            success: (r: any) => resolve({ status: r.status, body: Ext.decode(r.responseText) }),
            failure: (r: any) => resolve({ status: r.status, body: (() => { try { return Ext.decode(r.responseText); } catch { return r.responseText; } })() }),
          });
        });
      }, { invoiceId: SOURCE_INVOICE_ID, productId: PRODUCT_ID });

      expect(result?.body?.success, 'the API must reject a negative line even when the UI guard is bypassed').toBe(false);
      expect(JSON.stringify(result?.body?.errors ?? {}), 'the API error must be the negative-value rule').toContain(BLOCK_MESSAGE);
    });
  });

  test('Setting OFF — a negative quantity and a zero total are blocked too', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Toast1] });

    await test.step(`Navigate to SubcontractorInvoice #${SOURCE_INVOICE_ID} (setting still false)`, async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
    });

    for (const [qty, rate, label] of [[-2, 50, 'negative quantity'], [2, 0, 'zero rate']] as Array<[number, number, string]>) {
      await test.step(`Open form and enter Quantity = ${qty}, Rate = ${rate} (${label}, line total ${qty * rate})`, async () => {
        await openNewLineItemForm(page);
        await selectProduct(page, PRODUCT_ID, CLASSIFICATION_ID);
        await fillLineItemAmounts(page, qty, rate, `[QA] TANGO-111 ${label}`);
        await clickSaveLineItem(page);
      });
      await test.step(`Verify ${label} is blocked with the same message`, async () => {
        const toasts = await visibleToastText(page);
        expect(toasts, `${label} (total ${qty * rate}) must be blocked`).toContain(BLOCK_MESSAGE);
      });
      await captureAcSnapshot(testInfo, page, 'after', {
        focus: toastLocator(page),
        label: `Setting OFF — ${label} — qty ${qty} x rate ${rate} = ${qty * rate}, blocked`,
      });
      await cancelLineItemForm(page);
    }
  });

  test('Setting OFF — the rule applies to client quotes as well as vendor invoices', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Setting2] });

    // Evidence note: the negative attempt here goes through the client quote's
    // REST endpoint rather than its line item form. The clause under test is
    // about SCOPE — that the rule covers quote records and not just vendor
    // invoices — and scope is decided by Invoices::LineItem, the shared STI
    // parent every one of these types inherits from. The API is the layer that
    // rule lives on, so asserting there proves the clause directly. The client
    // quote is loaded on screen so the snapshot shows the record the rule was
    // applied to. (The vendor-invoice tests above already prove the form-level
    // toast; the client quote form adds required fields of its own that are
    // incidental to this clause.)
    await test.step(`Navigate to ClientQuote #${CLIENT_QUOTE_ID} (setting still false)`, async () => {
      await gotoInvoice(page, 'clientquote', CLIENT_QUOTE_ID);
    });

    await captureAcSnapshot(testInfo, page, 'before', {
      focus: await lineItemGridLocator(page),
      label: `ClientQuote #${CLIENT_QUOTE_ID} loaded — a quote record, not a vendor invoice`,
    });

    let apiResult: any = null;
    await test.step('POST a line item with Quantity = 1, Rate = -75 to the client quote endpoint', async () => {
      apiResult = await page.evaluate(async ({ quoteId, productId }) => {
        const Ext = (window as any).Ext;
        const facilityId = await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: `/api/v1/client_quotes/${quoteId}.json`,
            method: 'GET',
            success: (r: any) => {
              const body = Ext.decode(r.responseText);
              const inv = body?.invoices || body?.client_quotes;
              resolve(Array.isArray(inv) ? inv[0]?.facility_id : inv?.facility_id);
            },
            failure: () => resolve(null),
          });
        });

        return await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: '/api/v1/client_quote_line_items.json',
            method: 'POST',
            jsonData: {
              line_items: {
                invoice_id: quoteId,
                product_id: productId,
                quantity: 1,
                unit_price: -75,
                taxable: false,
                tax_rate: 0,
                facility_id: facilityId,
                description: '[QA] TANGO-111 client quote negative',
              },
            },
            success: (r: any) => resolve({ status: r.status, body: Ext.decode(r.responseText) }),
            failure: (r: any) => resolve({ status: r.status, body: (() => { try { return Ext.decode(r.responseText); } catch { return r.responseText; } })() }),
          });
        });
      }, { quoteId: CLIENT_QUOTE_ID, productId: PRODUCT_ID });
    });

    await test.step('Verify the client quote rejects it with the same negative-value message', async () => {
      expect(apiResult?.body?.success, 'a client QUOTE must be covered by the rule, not just vendor invoices').toBe(false);
      expect(
        JSON.stringify(apiResult?.body?.errors ?? {}),
        'the rejection must come from the negative-value rule',
      ).toContain(BLOCK_MESSAGE);
    });

    await test.step('Reload and verify nothing was persisted on the quote', async () => {
      await gotoInvoice(page, 'clientquote', CLIENT_QUOTE_ID);
      const items = await gridLineItems(page);
      expect(
        items.find((i) => i.description === '[QA] TANGO-111 client quote negative'),
        'the rejected client quote line must not exist',
      ).toBeFalsy();
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: await lineItemGridLocator(page),
      label: `ClientQuote #${CLIENT_QUOTE_ID} — negative line rejected; the rule spans quotes and invoices`,
    });
  });

  test('Setting OFF — an existing negative line item is grandfathered and still editable', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Grandfather1] });

    await test.step(`Navigate to SubcontractorInvoice #${SOURCE_INVOICE_ID} (setting still false)`, async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
    });

    // Match on the fixture PREFIX, not an exact string: this test renames the row,
    // so keying off the seeded name would make it pass once and fail on every
    // re-run against the same seed.
    let currentDescription = '';
    await test.step('Verify the seeded negative line item is still present after the customer opted out', async () => {
      const items = await gridLineItems(page);
      const existing = items.find((i) => i.description?.startsWith(NEGATIVE_FIXTURE_DESCRIPTION));
      expect(existing, 'the pre-existing negative line must not be removed or hidden by the setting').toBeTruthy();
      expect(existing!.quantity * existing!.unit_price).toBeLessThan(0);
      currentDescription = existing!.description;
    });

    await captureAcSnapshot(testInfo, page, 'before', {
      focus: await lineItemGridLocator(page),
      label: 'Setting OFF — the pre-existing negative line (qty 1 x rate -25) survives the opt-in unchanged',
    });

    // Toggle between the two known names so the edit is a real change on every
    // run without introducing a nondeterministic value into the assertions.
    const EDITED_SUFFIX = ' (edited)';
    const updatedDescription = currentDescription.endsWith(EDITED_SUFFIX)
      ? NEGATIVE_FIXTURE_DESCRIPTION
      : `${NEGATIVE_FIXTURE_DESCRIPTION}${EDITED_SUFFIX}`;
    await test.step(`Edit the existing negative line's description to "${updatedDescription}" via the API the grid uses`, async () => {
      const result = await page.evaluate(async ({ description, newDescription }) => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const store = grid?.getStore?.();
        let target: any = null;
        store?.each?.((rec: any) => { if (rec.get('description') === description) target = rec; });
        if (!target) return { ok: false, reason: 'fixture row not found in store' };

        return await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: `/api/v1/subcontractor_invoice_line_items/${target.get('id')}`,
            method: 'PUT',
            jsonData: { line_items: { description: newDescription } },
            success: (r: any) => resolve({ ok: true, body: Ext.decode(r.responseText) }),
            failure: (r: any) => resolve({ ok: false, reason: r.responseText }),
          });
        });
      }, { description: currentDescription, newDescription: updatedDescription });

      expect(result?.ok, `editing the grandfathered row failed: ${result?.reason}`).toBe(true);
      expect(result?.body?.success, 'the save must succeed — the rule only fires when quantity or rate change').toBe(true);
    });

    await test.step('Reload and verify the edit persisted while the line is still negative', async () => {
      await gotoInvoice(page, 'invoice', SOURCE_INVOICE_ID);
      const items = await gridLineItems(page);
      const edited = items.find((i) => i.description === updatedDescription);
      expect(edited, 'the grandfathered negative row should have saved its new description').toBeTruthy();
      expect(edited!.quantity * edited!.unit_price).toBeLessThan(0);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: await lineItemGridLocator(page),
      label: 'Setting OFF — the pre-existing negative line saved an unrelated edit; opting in did not freeze it',
    });
  });

  test('Setting OFF — duplication copies everything except the negative line and reports what it skipped', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Duplication1, TANGO_111_AC.Setting2] });

    await test.step(`Navigate to the copy TARGET, SubcontractorInvoice #${TARGET_INVOICE_ID}`, async () => {
      await gotoInvoice(page, 'invoice', TARGET_INVOICE_ID);
    });

    // Empty the target rather than assuming the seed left it empty: a previous
    // run of THIS test copies a line into it, so asserting "starts empty" would
    // pass once and fail on every re-run until someone re-seeded.
    await test.step('Clear any line items left on the target by a previous run', async () => {
      const removed = await page.evaluate(async () => {
        const Ext = (window as any).Ext;
        const grid = Ext.ComponentQuery.query('lineitemgrid')[0];
        const store = grid?.getStore?.();
        const ids: number[] = [];
        store?.each?.((rec: any) => ids.push(rec.get('id')));

        for (const id of ids) {
          await new Promise<void>((resolve) => {
            Ext.Ajax.request({
              url: `/api/v1/subcontractor_invoice_line_items/${id}.json`,
              method: 'DELETE',
              callback: () => resolve(),
            });
          });
        }
        return ids.length;
      });
      if (removed > 0) await gotoInvoice(page, 'invoice', TARGET_INVOICE_ID);
    });

    await test.step('Verify the target now has no line items', async () => {
      expect(await gridLineItems(page), 'copy target should be empty before duplicating').toHaveLength(0);
    });
    await captureAcSnapshot(testInfo, page, 'before', {
      focus: await lineItemGridLocator(page),
      label: `Copy target invoice #${TARGET_INVOICE_ID} before duplication — no line items`,
    });

    let skipped: any[] = [];
    await test.step(`Duplicate line items from invoice #${SOURCE_INVOICE_ID} into #${TARGET_INVOICE_ID}`, async () => {
      const result = await page.evaluate(async ({ sourceId, targetId }) => {
        const Ext = (window as any).Ext;
        return await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: `/api/v1/invoices/${sourceId}/duplicate_invoice_line_items.json`,
            method: 'POST',
            jsonData: { target_invoice_id: targetId },
            success: (r: any) => resolve({ ok: true, body: Ext.decode(r.responseText) }),
            failure: (r: any) => resolve({ ok: false, reason: r.responseText }),
          });
        });
      }, { sourceId: SOURCE_INVOICE_ID, targetId: TARGET_INVOICE_ID });

      expect(result?.ok, `duplication request failed: ${result?.reason}`).toBe(true);
      expect(result?.body?.success, 'the duplication itself must succeed — a negative line is skipped, not fatal').toBe(true);
      skipped = result?.body?.skipped_line_items ?? [];
    });

    await test.step('Verify the response names the skipped negative line and the reason', async () => {
      expect(skipped.length, 'exactly the negative line should be reported as skipped').toBeGreaterThanOrEqual(1);
      const negative = skipped.find((s: any) => Number(s.quantity) * Number(s.unit_price) < 0);
      expect(negative, 'the skipped entry should be the negative line').toBeTruthy();
      expect(String(negative.errors ?? ''), 'the skip reason must be the negative-value rule').toContain(BLOCK_MESSAGE);
    });

    await test.step('Reload the target and verify the positive line copied while the negative did not', async () => {
      await gotoInvoice(page, 'invoice', TARGET_INVOICE_ID);
      const items = await gridLineItems(page);
      expect(items.length, 'the copy must be partial, not empty and not complete').toBeGreaterThan(0);
      expect(
        items.every((i) => i.quantity * i.unit_price > 0),
        'every copied line must have a total greater than zero',
      ).toBe(true);
      expect(
        items.some((i) => i.description === POSITIVE_FIXTURE_DESCRIPTION),
        'the positive companion line must have copied',
      ).toBe(true);
      expect(
        items.some((i) => i.description === NEGATIVE_FIXTURE_DESCRIPTION),
        'the negative line must NOT have copied',
      ).toBe(false);
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: await lineItemGridLocator(page),
      label: `Copy target #${TARGET_INVOICE_ID} after duplication — positive line copied, negative line skipped and reported back to the caller`,
    });
  });

  test('Setting OFF — the user is told which line items the copy skipped', async ({ page }, testInfo) => {
    annotateAc(testInfo, { ticket: TICKET, ac: [TANGO_111_AC.Duplication1] });

    // Evidence note: this drives CopyInvoiceDialogController#notifySkippedLineItems
    // directly, feeding it the REAL response body from a live duplication rather
    // than a hand-written fixture. That proves the message the user sees — the
    // wording, the interpolated line item detail, and that the dictionary key
    // resolves rather than rendering raw. It does NOT prove the Copy Invoice
    // dialog calls the helper; that wiring is a one-line call site verified by
    // reading, and is called out as a coverage gap in the report.
    await test.step(`Navigate to SubcontractorInvoice #${TARGET_INVOICE_ID} and clear it`, async () => {
      await gotoInvoice(page, 'invoice', TARGET_INVOICE_ID);
      await page.evaluate(async () => {
        const Ext = (window as any).Ext;
        const store = Ext.ComponentQuery.query('lineitemgrid')[0]?.getStore?.();
        const ids: number[] = [];
        store?.each?.((rec: any) => ids.push(rec.get('id')));
        for (const id of ids) {
          await new Promise<void>((resolve) => {
            Ext.Ajax.request({
              url: `/api/v1/subcontractor_invoice_line_items/${id}.json`,
              method: 'DELETE',
              callback: () => resolve(),
            });
          });
        }
      });
      await gotoInvoice(page, 'invoice', TARGET_INVOICE_ID);
    });

    let skipped: any[] = [];
    await test.step(`Duplicate from invoice #${SOURCE_INVOICE_ID} and capture the real skipped_line_items payload`, async () => {
      const result = await page.evaluate(async ({ sourceId, targetId }) => {
        const Ext = (window as any).Ext;
        return await new Promise<any>((resolve) => {
          Ext.Ajax.request({
            url: `/api/v1/invoices/${sourceId}/duplicate_invoice_line_items.json`,
            method: 'POST',
            jsonData: { target_invoice_id: targetId },
            success: (r: any) => resolve(Ext.decode(r.responseText)),
            failure: () => resolve(null),
          });
        });
      }, { sourceId: SOURCE_INVOICE_ID, targetId: TARGET_INVOICE_ID });

      skipped = result?.skipped_line_items ?? [];
      expect(skipped.length, 'the duplication should have skipped the negative line').toBeGreaterThanOrEqual(1);
    });

    await test.step('Render the notification the Copy Invoice dialog shows, using that exact payload', async () => {
      await page.evaluate((payload) => {
        const Ext = (window as any).Ext;
        const controller = Ext.create('Fexy.view.general.invoice.CopyInvoiceDialogController');
        controller.notifySkippedLineItems(payload);
      }, { skipped_line_items: skipped });
      await page.waitForTimeout(1000);
    });

    await test.step('Verify the toast names the skipped line and gives Christina\'s reason', async () => {
      await expect(toastLocator(page)).toBeVisible({ timeout: 10_000 });
      const toasts = await visibleToastText(page);

      expect(toasts, 'the dictionary key must resolve, not render raw').not.toContain('invoice.copy_invoice_dialog');
      expect(
        toasts,
        'the reason must be the one Christina asked for',
      ).toContain('no longer allows negative line items on proposals and invoices');
      expect(toasts, 'the skipped line must be named').toContain(NEGATIVE_FIXTURE_DESCRIPTION);
      expect(toasts, 'the skipped count must be interpolated, not left as %{count}').not.toContain('%{');
    });

    await captureAcSnapshot(testInfo, page, 'after', {
      focus: toastLocator(page),
      label: 'Copy skipped-line notice — names the skipped line and why it was not copied',
    });
  });

  test.afterAll(async ({ browser }) => {
    // Leave the environment on the shipped default so a later suite (or a human
    // opening the app) never inherits a site that blocks negatives.
    const page = await browser.newPage();
    try {
      await setNegativeValuesAllowed(page, true);
    } finally {
      await page.close();
    }
  });
});
