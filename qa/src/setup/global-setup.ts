import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Re-load .env here because globalSetup runs in its own module context.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Imported after dotenv above only by convention — SURFACES resolves base
// URLs lazily, so hoisting is not a hazard here.
import { SURFACES, selectedSurfaces } from '../targets';

interface RoleCredentials {
  name: string;
  email: string | undefined;
  password: string | undefined;
}

const ROLES: RoleCredentials[] = [
  { name: 'admin',            email: process.env.ADMIN_EMAIL,            password: process.env.ADMIN_PASSWORD },
  { name: 'vendor',           email: process.env.VENDOR_EMAIL,           password: process.env.VENDOR_PASSWORD },
  { name: 'facility-manager', email: process.env.FACILITY_MANAGER_EMAIL, password: process.env.FACILITY_MANAGER_PASSWORD },
];

/**
 * Probe whether the target Rails server is in TANGO "fast mode" — i.e. is
 * serving the production-built Sencha bundle instead of dev-mode unpacked
 * sources. Returns true if the root URL redirects to /main/index (fast),
 * false if it goes to /main/development (slow).
 */
async function isFastMode(baseURL: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${baseURL}/`, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    if (location.includes('/main/index')) return true;
    if (location.includes('/main/development')) return false;
    return null; // unknown
  } catch {
    return null;
  }
}

/**
 * Preflight for the PWA surface. Confirms the two servers are up and that
 * the Vite dev proxy is actually forwarding to Rails, then hard-fails on the
 * one condition that would otherwise produce a confidently green, completely
 * meaningless run.
 *
 * `npm run dev:mock` starts the app with MSW, which answers /main/active_session
 * unconditionally as demo@fexa.io and serves fabricated data for every
 * endpoint. A suite run against it passes while proving nothing about the
 * backend — so this aborts rather than warns. Mock mode is never a QA target.
 */
async function preflightPwa(pwaBaseURL: string, railsBaseURL: string): Promise<void> {
  const status = async (url: string): Promise<number | null> => {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      return res.status;
    } catch {
      return null;
    }
  };

  const vite = await status(`${pwaBaseURL}/`);
  if (vite === null) {
    throw new Error(
      `[global-setup] PWA dev server is not responding at ${pwaBaseURL}.\n` +
      `  Start it with:  cd $FEXA_PWA_PATH && npm run dev`,
    );
  }

  const rails = await status(`${railsBaseURL}/main/active_session`);
  if (rails === null) {
    throw new Error(
      `[global-setup] Rails is not responding at ${railsBaseURL}.\n` +
      `  The PWA proxies /api, /users and /main to it — start it with:  bin/dev`,
    );
  }

  // The proxy is what makes the PWA same-origin with Rails, which is what
  // makes the Devise cookie and CSRF work without special handling. If this
  // 404s, vite.config.ts's server.proxy is not in effect.
  const proxied = await status(`${pwaBaseURL}/main/active_session`);
  if (proxied === null || proxied === 404) {
    throw new Error(
      `[global-setup] ${pwaBaseURL}/main/active_session returned ${proxied ?? 'no response'}, ` +
      `but ${railsBaseURL} returned ${rails}.\n` +
      `  The Vite dev proxy is not forwarding to Rails — check server.proxy in vite.config.ts.`,
    );
  }

  // MOCK GUARD. A 200 here means MSW is installed and intercepting.
  // Anything else (404 locally, 403 from S3 when deployed) means it is not.
  const msw = await status(`${pwaBaseURL}/mockServiceWorker.js`);
  if (msw === 200) {
    throw new Error(
      `[global-setup] ABORT: ${pwaBaseURL} is serving mockServiceWorker.js — ` +
      `this looks like \`npm run dev:mock\`.\n` +
      `  MSW answers every endpoint with fabricated data, so the suite would pass ` +
      `without testing the backend.\n` +
      `  Restart the PWA with \`npm run dev\` (no mocks) and re-run.`,
    );
  }

  console.log(`[global-setup] ✅ PWA at ${pwaBaseURL} — Vite up, proxy live, mocks off`);
}

/**
 * Runs once before the suite. For each role that has credentials in .env,
 * performs a real Devise sign-in against TEST_BASE_URL and saves the
 * resulting session cookies to auth/<role>.json. Tests then start logged in
 * via the per-project `storageState` setting in playwright.config.ts.
 *
 * If a role's credentials are missing, that role is skipped — any test
 * targeting that project will fail with a missing-storage-state error,
 * which is the signal to fill in .env.
 *
 * Also probes for TANGO fast mode (production-built Sencha bundle). If the
 * target is in dev mode, prints a warning pointing to `npm run fexa:fast-mode`
 * but does NOT abort — login still works either way, and the user may have
 * intentionally chosen to test against dev-mode Rails. The probe is skipped
 * entirely on PWA-only runs: fast mode is about the Ext bundle, and probing
 * the Vite origin (which serves a 200 SPA shell, not a redirect) would warn
 * "could not determine Rails mode" on every run.
 *
 * Login always happens against the CMMS base URL — that is where Devise's
 * HTML form is served. The resulting session cookie is host-only on
 * `localhost` and cookies ignore port, so the same auth/<persona>.json is
 * valid for the PWA on :5173.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
  const surfaces = selectedSurfaces();
  const baseURL = SURFACES.cmms.baseURL();
  const authDir = path.resolve(__dirname, '../../auth');

  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  if (surfaces.includes('cmms')) {
    const fastMode = await isFastMode(baseURL);
    if (fastMode === true) {
      console.log('[global-setup] ✅ Rails is in fast mode (production Sencha build)');
    } else if (fastMode === false) {
      console.warn('[global-setup] ⚠️  Rails is in DEV mode — Sencha will be slow to boot.');
      console.warn('[global-setup]    Run `npm run fexa:fast-mode` and restart Rails for fast tests.');
    } else {
      console.warn('[global-setup] ⚠️  Could not determine Rails mode (no redirect at /)');
    }
  }

  if (surfaces.includes('pwa')) {
    await preflightPwa(SURFACES.pwa.baseURL(), baseURL);
  }

  console.log(`[global-setup] Logging in against ${baseURL}`);

  for (const role of ROLES) {
    if (!role.email || !role.password) {
      console.warn(`[global-setup] Skipping ${role.name}: credentials not set in .env`);
      continue;
    }

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${baseURL}/users/sign_in`, { waitUntil: 'domcontentloaded' });

      // Devise default field names. If Fexy-Zamo's login page uses custom
      // selectors, adjust here.
      await page.fill('input[name="user[email]"]', role.email);
      await page.fill('input[name="user[password]"]', role.password);

      // Sencha/Ext JS apps keep loading assets indefinitely, so the default
      // `waitUntil: 'load'` never resolves. Use 'commit' — fires the moment
      // the server responds to the post-login redirect, which is all we need
      // to know auth succeeded.
      await Promise.all([
        page.waitForURL(
          (url) => !url.pathname.includes('/users/sign_in'),
          { timeout: 30_000, waitUntil: 'commit' },
        ),
        page.click('input[type="submit"], button[type="submit"]'),
      ]);

      const statePath = path.join(authDir, `${role.name}.json`);
      await context.storageState({ path: statePath });
      console.log(`[global-setup] Saved auth for ${role.name} -> ${statePath}`);
    } catch (err) {
      // Don't abort the whole suite on one bad cred — log and continue.
      // Tests targeting this role's project will fail with a missing
      // storage-state error, which is the signal to fix the .env entry.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[global-setup] Login failed for ${role.name}: ${msg}`);
      try {
        const shotPath = path.join(authDir, `${role.name}-failure.png`);
        await page.screenshot({ path: shotPath, fullPage: true });
        const flash = await page.locator('.flash, .alert, [role="alert"]').allTextContents().catch(() => []);
        console.error(`[global-setup]   page URL: ${page.url()}`);
        console.error(`[global-setup]   flash/alert: ${JSON.stringify(flash)}`);
        console.error(`[global-setup]   screenshot: ${shotPath}`);
      } catch { /* best-effort diagnostics */ }
    } finally {
      await browser.close();
    }
  }
}

export default globalSetup;
