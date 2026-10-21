# fexa-pwa prerequisites for PWA QA

Changes needed **in the fexa-pwa repo** (not here) before PWA specs can use stable
selectors. Verified against `fexa-pwa@38b28b9` (origin/main, 2026-07-23).

Nothing in the QA engine depends on these landing — specs can be written today using
the workarounds in the right-hand column. But every workaround is either brittle or
ambiguous, so this is the difference between specs that survive a styling change and
specs that don't.

Suggested as one small PR. All of it is additive; none of it changes rendering.

---

## 1. Duplicate navigation landmarks — **highest value**

`src/components/layout/Rail/Rail.tsx:16` and
`src/components/layout/BottomNav/BottomNav.tsx:32` are both:

```tsx
<nav aria-label="Primary">
```

`src/components/layout/AppShell.tsx:23,35` renders **both unconditionally** and hides
one with CSS (`hidden lg:flex` / `lg:hidden`). CSS-hidden elements remain in the
accessibility tree for querying, so:

```ts
page.getByRole('navigation', { name: 'Primary' })   // strict-mode violation, always
```

Same one level down: `Rail.tsx:26` and `BottomNav.tsx:40` both emit
`aria-label={label}` from the same `NAV_ITEMS`, so
`getByRole('link', { name: 'Work Orders' })` matches twice at every viewport.

**Fix:** give them distinct accessible names — e.g. keep `"Primary"` on `BottomNav`
and use `"Primary (desktop)"` on `Rail` — or add `data-testid="rail-nav"` /
`data-testid="bottom-nav"` and scope nav-item queries within them.

**Workaround until then:** `.filter()` on an ancestor, or `.first()` / `.last()` with a
comment explaining which viewport it assumes. Both are fragile.

---

## 2. Work-order cards have no identity

`src/features/workorders/WorkorderCard.tsx:47` is a `<Link>` carrying only class
names. Its accessible name is every piece of inner text concatenated — id, age,
description, vendors, NTE — so "the card for #1234" can only be expressed as:

```ts
page.getByRole('link').filter({ hasText: '#1234' })   // also matches any card whose
                                                       // description contains "#1234"
```

**Fix:**
```tsx
<Link
  to={`/workorders/${wo.id}`}
  data-testid="workorder-card"
  data-workorder-id={wo.id}
  …
>
```

This is the single most useful addition for TANGO-72/73/74/75, since every WO Detail
spec starts by navigating from the list.

---

## 3. Mobile list has no row structure

`src/components/data/DataView/DataView.tsx:118-123` renders:

```tsx
<div className={`space-y-2.5 ${className ?? ''}`}>
  {rows.map((row) => (
    <div key={row.id}>{renderCard(row.original)}</div>
  ))}
</div>
```

No role, no testid. The desktop branch renders a real `<table>` and gets
`getByRole('row')` for free, so "assert the list has N rows" works on desktop and is
unwritable on mobile — and the `pwa-*` projects are mobile.

**Fix:** `data-testid="dataview-list"` on the wrapper, `data-testid="dataview-row"` on
each item.

---

## 4. Tab accessible names mutate as data loads

`src/features/workorders/detail/DetailTabs.tsx:42-51` puts the count `<span>` **inside**
the tab `<button>`, so the accessible name is `"Notes 3"`, not `"Notes"` — and it
changes from `"Notes"` to `"Notes 3"` when the notes query resolves.

```ts
page.getByRole('tab', { name: 'Notes' })   // fails, non-deterministically
```

Directly affects TANGO-73 (Notes) and TANGO-74 (Assets).

**Fix:** put the stable name on the button and let the count stay visual —
`aria-label={t.label}` on the `<button>` — or add `data-testid={`tab-${t.key}`}`.

**Workaround until then:** match `/^Notes/`. This works and is what
`reference/targets/pwa.md` currently tells specs to do.

---

## 5. Tab panels are unaddressable

Tabs are `role="tab"` but carry no `id` / `aria-controls`, and the panel container in
`src/features/workorders/detail/WorkorderDetailPage.tsx:100-106` has no
`role="tabpanel"`. There is no way to assert "the Notes panel is showing" other than
by its contents.

**Fix:** `role="tabpanel"` + `data-testid={`tabpanel-${key}`}` on the container.

---

## 6. Every spinner has the same accessible name

`src/components/ui/Spinner/Spinner.tsx:14-15` hardcodes:

```tsx
role="status"
aria-label="Loading"
```

Used at page level (`WorkorderDetailPage.tsx:59`), list level (`DataView.tsx:46`), tab
level (`ActivityTab.tsx:55`), next-page (`WorkorderListPage.tsx:120`), and in
`ProtectedRoute` / `RequirePermission`. Any `getByRole('status')` is ambiguous the
moment two coexist — which is exactly what happens during the detail page's staged
load.

**Fix:** accept and forward an optional `label` prop, defaulting to `"Loading"`.

---

## 7. Infinite-scroll sentinel is unaddressable

`src/features/workorders/WorkorderListPage.tsx:116`:

```tsx
<div ref={sentinelRef} aria-hidden />
```

Nothing to `scrollIntoViewIfNeeded()`, so forcing page 2 means scrolling the container
by a guessed pixel amount.

**Fix:** `data-testid="wo-list-sentinel"`.

---

## 8. Login error is not announced

`src/features/auth/LoginPage.tsx:126-130` renders a plain `<div>`, unlike
`Input.tsx:61` which correctly carries `role="alert"`. Auth-failure assertions have
only raw text to match on.

**Fix:** add `role="alert"`.

**Bonus, unrelated to QA:** that same element uses `bg-red-50 text-red-700` — raw
Tailwind palette rather than design tokens (`bg-danger`/`text-danger`). Worth fixing
while the file is open.

---

## 9. `WorkorderCardSkeleton` is dead code

`src/features/workorders/WorkorderCardSkeleton.tsx` is defined and imported nowhere
(verified by grep across `src/`). A spec asserting "skeleton cards appear while the
work-order list loads" would be testing behavior that does not exist — the list
renders a `Spinner`, not skeletons.

**Fix:** delete it, or wire it into `DataView`'s loading branch. Either is fine; the
QA-relevant point is that the current state is a trap for whoever writes that spec.

---

## Not needed (parked)

Making `vite.config.ts:61-74`'s proxy target an env var (`PWA_API_TARGET`) would let
`npm run dev` point at any backend. Useful if a deployed-environment QA mode ever
comes back — irrelevant for local QA, where the hardcoded `localhost:3000` is exactly
right. Do not do this now.
