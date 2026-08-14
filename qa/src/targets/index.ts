/**
 * Surface registry — the one place that knows how the two apps under test
 * differ.
 *
 * A "surface" is an application, not an environment. Both surfaces run
 * locally against the SAME Rails server and the SAME database:
 *
 *   cmms — Fexy-Zamo (Rails + Ext JS desktop) on :3000
 *   pwa  — fexa-pwa  (React + Vite mobile)   on :5173, whose dev server
 *          proxies /api, /users and /main straight through to :3000
 *
 * Consequences of that shared backend, which is why this file is small:
 *   - Seeds are surface-independent. `npm run seed:*` provisions fixtures for
 *     both surfaces; there is nothing to gate.
 *   - Auth is surface-independent. The Devise session cookie is host-only on
 *     `localhost` and cookies ignore port, so auth/<persona>.json captured at
 *     :3000 is sent to :5173 unchanged. One login pass serves both.
 *   - Personas are surface-independent. An admin is the same user with the
 *     same permissions in either app.
 *
 * What genuinely differs is only: base URL, viewport/device, where the specs
 * live, how long a page takes to become interactive, whether Sencha fast mode
 * applies, and how you address elements.
 */
import { devices } from '@playwright/test';

export type Surface = 'cmms' | 'pwa';

export const PERSONA_IDS = ['admin', 'vendor', 'facility-manager'] as const;
export type Persona = (typeof PERSONA_IDS)[number];

export interface SurfaceDescriptor {
  id: Surface;
  label: string;
  /** Per-project Playwright `use` device block. */
  device: Record<string, unknown>;
  /** Root the projects for this surface collect specs from. */
  testDir: string;
  /** Extra ignores layered on top of the _explore rule. */
  testIgnore: string[];
  /** Per-test budget. Individual specs may still call test.setTimeout(). */
  timeout: number;
  /**
   * Resolved lazily, NOT as a module-load constant. ESM imports are hoisted
   * above `dotenv.config()` in the consuming config, so a constant here
   * would be computed before .env exists. Call this when building projects.
   */
  baseURL(): string;
  /**
   * Whether `bin/fexa-fast-mode.sh` is meaningful here. Only the Ext JS
   * bundle has a slow dev build — the PWA has no equivalent, and probing for
   * it against :5173 produces a spurious warning on every run.
   */
  fastMode: boolean;
  /**
   * Playwright project name for a persona on this surface.
   *
   * CMMS names are BARE ('admin', not 'cmms-admin'). This is load-bearing:
   * 60+ existing specs do `test.skip(testInfo.project.name !== 'admin', …)`,
   * and PERSONAS in ../support/qa-report.ts is keyed the same way. Renaming
   * them would not fail — it would make every one of those tests skip
   * silently, producing a green run that asserts nothing. Do not "tidy" this.
   */
  projectName(persona: Persona): string;
}

/**
 * 390x844 is the repo's mobile QA viewport, matching the artifacts already
 * committed under fexa-pwa/docs/qa-artifacts/ so new screenshots stay
 * comparable.
 *
 * Chromium with explicit emulation rather than devices['iPhone 13'], whose
 * defaultBrowserType is webkit — we do not want a second browser download.
 *
 * isMobile is not cosmetic: it enables Chromium's meta-viewport emulation,
 * which is what makes env(safe-area-inset-*) resolve to non-zero values. The
 * PWA uses those insets in AppHeader, BottomNav and Sheet, so without it the
 * header and bottom nav sit at the wrong offsets and click coordinates drift.
 *
 * deviceScaleFactor 2 keeps report PNGs legible; the qa-report reporter
 * base64-inlines every screenshot, so 3 would inflate the attachment for no
 * evidentiary gain.
 */
const MOBILE_390: Record<string, unknown> = {
  ...devices['Desktop Chrome'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  /**
   * The built service worker's NavigationRoute has no denylist, so once
   * registered it answers EVERY navigation from the precached SPA shell —
   * including /users/sign_in, which would silently stop being the Devise
   * form. Nothing under test depends on the SW (the offline banner is
   * navigator.onLine-driven and there is no install-prompt handling), so
   * block it. A dedicated project can opt back in when SW behavior itself
   * is the thing being tested.
   */
  serviceWorkers: 'block',
};

/**
 * TEST_BASE_URL is still honoured for the CMMS so existing invocations and
 * muscle memory keep working; CMMS_BASE_URL is the preferred spelling now
 * that there are two surfaces.
 */
const cmmsBaseURL = () =>
  process.env.CMMS_BASE_URL || process.env.TEST_BASE_URL || 'http://localhost:3000';

const pwaBaseURL = () => process.env.PWA_BASE_URL || 'http://localhost:5173';

export const SURFACES: Record<Surface, SurfaceDescriptor> = {
  cmms: {
    id: 'cmms',
    label: 'Fexy-Zamo CMMS (Rails + Ext JS, desktop)',
    device: devices['Desktop Chrome'],
    testDir: './tests',
    testIgnore: ['**/pwa/**'],
    // Ext boots slowly even in fast mode; several specs already set this
    // explicitly via test.setTimeout(180_000).
    timeout: 240_000,
    baseURL: cmmsBaseURL,
    fastMode: true,
    projectName: (persona) => persona,
  },
  pwa: {
    id: 'pwa',
    label: 'FexaAI PWA (React + Vite, mobile 390x844)',
    device: MOBILE_390,
    testDir: './tests/pwa',
    testIgnore: [],
    // A Rollup bundle, not a Sencha build. If a PWA spec needs more than
    // 60s something is wrong with the wait strategy, not the app.
    timeout: 60_000,
    baseURL: pwaBaseURL,
    fastMode: false,
    projectName: (persona) => `pwa-${persona}`,
  },
};

/**
 * QA_SURFACE=cmms|pwa|both. Default 'both' — specs are physically partitioned
 * by testDir, so running both is safe and costs nothing when tests/pwa/ is
 * empty.
 */
export function selectedSurfaces(): Surface[] {
  const raw = (process.env.QA_SURFACE || 'both').toLowerCase();
  if (raw === 'both') return ['cmms', 'pwa'];
  if (raw === 'cmms' || raw === 'pwa') return [raw];
  throw new Error(`QA_SURFACE must be cmms | pwa | both — got "${raw}"`);
}

/** Which surface a project name belongs to. */
export function surfaceOf(projectName: string): Surface {
  return projectName.startsWith('pwa-') ? 'pwa' : 'cmms';
}

/**
 * The persona behind a project name, on either surface. Use this in new
 * specs instead of comparing testInfo.project.name directly, so a spec reads
 * the same whichever surface it runs on.
 */
export function personaOf(projectName: string): Persona {
  return projectName.replace(/^pwa-/, '') as Persona;
}
