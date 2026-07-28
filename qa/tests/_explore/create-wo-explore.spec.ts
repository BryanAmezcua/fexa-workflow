import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MANIFEST = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../reports/seed-manifest-tango-78.json'), 'utf-8'),
);

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    if (!Ext?.ComponentQuery) return false;
    try { return Ext.ComponentQuery.query('container,panel,toolbar').length >= 8; } catch { return false; }
  }, null, { timeout: 90_000, polling: 1000 });
  await page.waitForTimeout(1500);
}

test('explore create workorder assignment sheet', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'admin', 'explore as admin only');
  test.setTimeout(180_000);

  await page.goto('/main/index', { waitUntil: 'commit' });
  await waitForApp(page);

  await page.evaluate(() => { (window as any).Ext.History.add('createworkorder'); });
  await page.waitForFunction(() => {
    const Ext = (window as any).Ext;
    return Ext.ComponentQuery.query('createworkorder').some((p: any) => p.isVisible?.());
  }, null, { timeout: 60_000, polling: 1000 });
  await page.waitForTimeout(2000);

  // Select the seeded facility on the WO form (getSheet needs a selection).
  const facResult = await page.evaluate(async (facilityId) => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ff = create.down('[name=facility_id]');
    const rec: any = await new Promise((resolve) => {
      Ext.create('Fexy.model.facility.Facility', { id: facilityId }).load({
        callback: (r: any, op: any, success: boolean) => resolve(success ? r : null),
      });
    });
    if (!rec) return { error: `facility ${facilityId} load failed` };
    ff.setSelected?.(rec);
    ff.setValue?.(facilityId);
    return { error: null, picked: rec.getId() };
  }, MANIFEST.create_flow.facility_id);
  console.log('FACILITY:', JSON.stringify(facResult));
  await page.waitForTimeout(1000);

  // Open the sheet and dump every field with value + store model.
  const dump = await page.evaluate(() => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const ctrl = create.down('workorderassignments').getController();
    ctrl.createAssignment();
    const form = ctrl.sheet.down('formpanel');
    return form.query('field').map((f: any) => ({
      name: f.getName?.() ?? f.name,
      xtype: f.xtype,
      required: f.getRequired?.() ?? f.required ?? false,
      hidden: f.getHidden?.(),
      value: (() => { try { const v = f.getValue?.(); return v instanceof Date ? v.toISOString() : (typeof v === 'object' && v !== null ? '<obj>' : v); } catch { return '<err>'; } })(),
      storeModel: (() => { try { return f.getStore?.()?.getModel?.()?.entityName ?? null; } catch { return null; } })(),
    }));
  });
  console.log('ALL FIELDS:', JSON.stringify(dump));

  // Attempt the regression-A scenario end to end.
  const scenario = await page.evaluate(async (cf) => {
    const Ext = (window as any).Ext;
    const create = Ext.ComponentQuery.query('createworkorder').find((p: any) => p.isVisible?.());
    const asnPanel = create.down('workorderassignments');
    const ctrl = asnPanel.getController();
    const sheet = ctrl.sheet;
    const form = sheet.down('formpanel');
    const log: any = {};

    const set = (name: string, v: any) => {
      const f = form.down(`[name="${name}"]`);
      if (!f) throw new Error(`no field ${name}`);
      f.setValue(v);
      return f;
    };

    // Provider: infinitecombo needs a selected record for forceSelection.
    const roleField = form.down('[name="role_id"]');
    const roleModelName = roleField.getStore?.()?.getModel?.()?.entityName || 'Fexy.model.role.Role';
    const roleRec: any = await new Promise((resolve) => {
      Ext.create(roleModelName.startsWith('Fexy') ? roleModelName : `Fexy.model.${roleModelName}`, { id: cf.vendor_role_id }).load({
        callback: (r: any, op: any, s: boolean) => resolve(s ? r : null),
      });
    });
    log.roleModelName = roleModelName;
    log.roleLoaded = !!roleRec;
    if (roleRec) { roleField.setSelected?.(roleRec); }
    roleField.setValue(cf.vendor_role_id);

    try { set('category_id', cf.category_id); } catch (e: any) { log.categoryErr = e.message; }
    try { set('subcontractor_not_to_exceed.amount', 500); } catch (e: any) { log.nteErr = e.message; }

    await new Promise((r) => setTimeout(r, 1000));

    // Fill any still-empty required visible fields with their store's first option.
    const empties = form.query('field').filter((f: any) =>
      (f.getRequired?.() ?? false) && !f.getHidden?.() &&
      (f.getValue?.() === null || f.getValue?.() === undefined || f.getValue?.() === ''));
    log.requiredEmptyBefore = empties.map((f: any) => f.getName?.());
    for (const f of empties) {
      const st = f.getStore?.();
      if (st) {
        if (!st.getCount() && st.load) { await new Promise<void>((r) => st.load({ callback: () => r() })); }
        const first = st.getAt?.(0);
        if (first) { f.setSelected?.(first); f.setValue(first.getId ? first.getId() : first); }
      }
    }
    log.validate = form.validate();
    log.requiredEmptyAfter = form.query('field').filter((f: any) =>
      (f.getRequired?.() ?? false) && !f.getHidden?.() &&
      (f.getValue?.() === null || f.getValue?.() === undefined || f.getValue?.() === '')).map((f: any) => f.getName?.());

    if (!log.validate) return log;

    // Save (create flow: no HTTP, sheet destroyed)
    const btn = sheet.down('[reference=assignmentSheetSaveBtn]');
    btn.fireEvent('tap', btn);
    await new Promise((r) => setTimeout(r, 1500));

    const grid = asnPanel.down('grid');
    const store = grid.getStore();
    log.gridCount = store.getCount();
    const rec = store.getAt(store.getCount() - 1);
    log.flatAfterFirstSave = rec.data['subcontractor_not_to_exceed.amount'];
    log.nestedAfterFirstSave = rec.data.subcontractor_not_to_exceed;
    log.cellText = (() => {
      try {
        const col = grid.getColumns().find((c: any) => c.getDataIndex?.() === 'subcontractor_not_to_exceed.amount');
        const cell = grid.getItem(rec)?.getCellByColumn?.(col);
        return cell?.el?.dom?.innerText ?? '<no cell>';
      } catch (e: any) { return `<cellErr ${e.message}>`; }
    })();

    // Reopen the sheet on the same record (edit path, phantom -> no refetch)
    ctrl.editAssignment(null, { record: rec });
    await new Promise((r) => setTimeout(r, 1500));
    const form2 = ctrl.sheet.down('formpanel');
    log.nteFieldOnReopen = form2.down('[name="subcontractor_not_to_exceed.amount"]')?.getValue?.();

    // Re-save untouched
    const btn2 = ctrl.sheet.down('[reference=assignmentSheetSaveBtn]');
    btn2.fireEvent('tap', btn2);
    await new Promise((r) => setTimeout(r, 1500));
    log.flatAfterResave = rec.data['subcontractor_not_to_exceed.amount'];
    log.nestedAfterResave = rec.data.subcontractor_not_to_exceed;
    return log;
  }, MANIFEST.create_flow);
  console.log('SCENARIO:', JSON.stringify(scenario, null, 1));
});
