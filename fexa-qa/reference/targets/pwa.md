# Target: pwa — fexa-pwa (React + Vite, mobile)

Loaded at SKILL.md step 2 when the resolved app is `pwa`. Covers steps 6-9 only.
It never redefines the pipeline, the hard rules, or the report format.

Base URL `http://localhost:5173` · projects `pwa-admin`, `pwa-vendor`,
`pwa-facility-manager` · 390x844, `isMobile`, `hasTouch` · per-test timeout 60s.

**None of the CMMS idioms apply.** No `Ext.ComponentQuery`, no `Ext.History.add`, no
InfiniteCombo polling, no fast mode, no cold-start retry.

## Prerequisites

Rails on `:3000` **and** `npm run dev` on `:5173` (the Vite proxy forwards
`/api`, `/users`, `/main` to Rails, which is what keeps everything same-origin).
`global-setup` aborts if the proxy is dead or if MSW is intercepting.

## §Exploration (step 6)

React Router deep links are real URLs — just `page.goto('/workorders/123')`. No
history hack. To discover structure, run a scratch spec that dumps the accessibility
tree rather than component internals:

```ts
console.log(await page.locator('#root').ariaSnapshot());
```

## §Selectors

Policy, in order: `getByRole(role, { name })` → `getByLabel()` for form fields →
`getByText()` for content → `data-testid` only where identity is otherwise ambiguous.
Never assert on class names.

Assets that already exist: `role="tablist"`/`role="tab"` + `aria-selected`
(DetailTabs), `role="alert"` (Input errors, Banner), `role="status"` +
`aria-label="Loading"` (Spinner), `aria-busy` (Button, dashboard Cards),
`aria-sort` (DataView desktop), and ~30 `aria-label`s on icon buttons.
`Input` derives `id` from its `label` prop and wires `<label htmlFor>`, so
`getByLabel('Email')` works.

**Known addressability gaps.** Until the fexa-pwa PR landing testids merges, these
are traps. Full list with exact fixes: `pwa-repo-prerequisites.md` (same directory).

| Gap | Effect |
|---|---|
| `Rail` and `BottomNav` are both `<nav aria-label="Primary">`, both always in the DOM (CSS-hidden only) | `getByRole('navigation', {name:'Primary'})` is a strict-mode violation at every viewport. Same for every nav item. |
| `WorkorderCard` is a `<Link>` with no identity attribute | Its accessible name is all inner text concatenated; filter by `hasText` and accept the ambiguity |
| Mobile list renders bare `<div>`s | No `getByRole('row')` on mobile, unlike the desktop table path |
| Tab labels include a count `<span>` inside the button | Accessible name becomes `"Notes 3"` and changes as queries land — match `/^Notes/`, never exact |

## §Viewport changes which components exist

`DataView` branches on `useBreakpoint().isDesktop` in **JS, not CSS**: below 1024px it
renders cards, at/above it renders a real `<table>`. A spec written for one tier hard
fails on the other. The `pwa-*` projects are mobile (390px) — write for cards.

The page `<h1>` lives inside a `lg:hidden` wrapper, so heading assertions are
mobile-only.

## §Timing (step 8)

Three requests gate any protected page: `/main/active_session` (ProtectedRoute),
`/main/get_ssettings` (the work-order fetch is `enabled: !settings.isLoading`, so it
does not start until settings land), and `/api/v1/permission_resources`
(RequirePermission).

- **Assert the settled state; never wait for a spinner.** `staleTime` is 30s globally
  and Infinity for settings, so on a warm cache the spinner may never render.
- **Guard auth first.** A 401 makes the client do `window.location.href = '/login'`,
  so a stale session presents as every assertion timing out, not as an auth error:
  ```ts
  await expect(page).not.toHaveURL(/\/login/)
  ```
- **Permission denial is a race trap.** `usePermissions` reports `false` for
  everything while loading and `RequirePermission` renders "No access" on error — so a
  slow `permission_resources` looks exactly like a legitimate denial. Await the
  response before asserting denial.
- **Detail tabs settle late.** The strip is computed from `can(...)` plus separate
  notes and assets queries, and re-renders as each lands.
- **Scrolling is inside nested containers**, not the window. Use
  `locator.scrollIntoViewIfNeeded()`; `page.mouse.wheel` does nothing useful.
- **Mutations refetch, they are not optimistic** (no `onMutate` anywhere). Assert on
  final content. `AddNoteSheet` closes *before* its `onSaved()` fires, so assert on the
  note text, never on the sheet being closed.
- **Offline** — `context.setOffline(true)` drives the connectivity banner, which is
  `navigator.onLine`-based. It will not cleanly kill an open Presso WebSocket; that
  has its own reconnect timer.

## §Screenshots (step 9)

Mobile changes what a screenshot proves. Three additional checks beyond the standard
"does the PNG show the AC-proving element":

1. **Below the fold.** At 390x844 the proving element is frequently off-screen, so a
   passing assertion routinely yields a screenshot that proves nothing. Scroll it into
   view before capturing.
2. **Occlusion.** The floating bottom nav and safe-area insets can cover the `focus`
   element.
3. **Absence is ambiguous.** An element may be missing because it is permission-gated
   *or* because it is collapsed behind a tab or accordion — identical in a screenshot,
   opposite in meaning. An absence assertion must additionally prove the container is
   expanded.

Pass `animations: 'disabled'` to `page.screenshot()`. `Spinner` (`animate-spin`) and
`Skeleton` (`animate-pulse`) never settle, and Radix sheets animate on close — capture
after `await expect(page.getByRole('dialog')).toHaveCount(0)`.

## §AC sources beyond Jira

`fexa-pwa/docs/parity/<screen>.md` enumerates every element's permission gate with
CONFIRMED/ASSUMED tags and `file:line` citations. It is usually a richer and more
precise AC source than the ticket, and it drives critique lens (d) in step 10.

## §Service worker

The `pwa-*` projects set `serviceWorkers: 'block'`. The built SW's navigation route
has no denylist, so once registered it answers every navigation from the precached
shell — including `/users/sign_in`, which would silently stop being the Devise form.
Nothing under test depends on it: the offline banner is `navigator.onLine`-driven and
there is no install-prompt handling. Note the SW does not register under `npm run dev`
at all; testing SW behavior itself requires `vite preview` and a dedicated project.
