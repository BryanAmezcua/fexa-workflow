import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root before importing the surface registry —
// SURFACES resolves CMMS_BASE_URL / PWA_BASE_URL at module load. Override
// per-invocation inline:
//   QA_SURFACE=pwa npx playwright test
//   PWA_BASE_URL=http://localhost:4173 npx playwright test --project=pwa-admin
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { SURFACES, PERSONA_IDS, selectedSurfaces } from './src/targets';

const includeExplore = process.env.TANGO_INCLUDE_EXPLORE === '1';

/**
 * Projects are the cross product of selected surfaces x personas.
 *
 * CMMS project names are BARE ('admin', 'vendor', 'facility-manager'); PWA
 * names are prefixed ('pwa-admin'). That asymmetry is deliberate — 60+
 * existing specs branch on `testInfo.project.name === 'admin'`, and renaming
 * would turn them into silent skips rather than failures. See the note in
 * src/targets/index.ts. `--project=admin` and the test:admin / test:vendor /
 * test:fm npm scripts keep working unchanged.
 *
 * storageState is NOT namespaced by surface: both surfaces authenticate
 * against the same Rails with the same Devise session, and the cookie is
 * host-only on `localhost` with port ignored per RFC 6265 — so the session
 * captured at :3000 is sent to :5173. One login pass, one file per persona.
 */
const projects = selectedSurfaces().flatMap((sid) => {
  const s = SURFACES[sid];
  return PERSONA_IDS.map((persona) => ({
    name: s.projectName(persona),
    testDir: s.testDir,
    // Exclude scratch exploration scripts from the standard suite; opt in by
    // setting TANGO_INCLUDE_EXPLORE=1 or running tests/_explore/ explicitly.
    testIgnore: [...s.testIgnore, ...(includeExplore ? [] : ['**/_explore/**'])],
    timeout: s.timeout,
    use: {
      ...s.device,
      baseURL: s.baseURL(),
      storageState: `auth/${persona}.json`,
      // Read by spec helpers and the qa-report reporter. Playwright passes
      // unrecognized `use` keys through untouched.
      surface: sid,
      persona,
    },
  }));
});

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporters:
  //  - html: Playwright's interactive browseable report (for engineers)
  //  - list: live terminal output while tests run
  //  - qa-report: our standardized self-contained HTML for ticket attachment
  //    (groups by ticket, shows AC clause, before/after screenshots, repro)
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['./src/reporters/qa-report.ts'],
  ],

  // Logs in each configured role once before the suite runs, dumps session
  // state to auth/<role>.json. Projects above pick up that state.
  globalSetup: require.resolve('./src/setup/global-setup'),

  use: {
    // Pin the browser timezone so date-only fields don't shift days based on
    // a headless-Chromium default (we saw UTC+8 in practice). UTC means
    // local-midnight === UTC-midnight, which Ext date fields and our seed
    // baselines both treat as the same day.
    //
    // The PWA needs this for its own reason: it formats dates in the browser
    // zone via toLocaleDateString/toLocaleTimeString, so asserted strings
    // like "Jun 4, 1:08 PM" shift with the runner's timezone.
    timezoneId: 'UTC',
    // The PWA also calls Number#toLocaleString() with no locale argument for
    // NTE amounts, so pin the locale too ("NTE $1,240" vs "NTE $1.240").
    locale: 'en-US',
    // Artifact capture — these are the knobs you'll attach to tickets.
    trace: 'retain-on-failure',        // full step-by-step replay on failure
    screenshot: 'only-on-failure',     // PNG at point of failure
    video: 'retain-on-failure',        // webm of the run
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects,
});
