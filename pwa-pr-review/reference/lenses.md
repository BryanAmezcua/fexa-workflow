# Lens prompts (Phase 2)

Six agents, one per lens. Each gets this preamble, then its lens block.

## Shared preamble

> You are reviewing one dimension of a pull request on `fexa-pwa` (React 19 +
> Vite + Tailwind v4 mobile PWA over a Rails backend).
>
> Read first: `CLAUDE.md`, `docs/COMPONENTS.md`, `docs/parity/README.md`.
> The diff is at `<work>/diff.patch`; the repo is checked out at the PR head.
>
> Answer **only your lens's question**. Ignore everything else — another agent
> owns it. Returning an empty array is a correct and common outcome; never pad.
>
> For every finding you must supply a `failure_scenario`: concrete inputs or
> state producing a concrete wrong outcome. **If you cannot write one, the
> finding does not exist — drop it.** "This could be confusing" and "consider
> extracting this" are not failure scenarios.
>
> Do not report anything ESLint or `tsc` would catch. Cite `file:line` for
> every claim. Never infer behavior from a file or symbol name — open the file.
>
> Return a JSON array of findings using the schema in `SKILL.md`.

---

## `parity`

Does this drop a permission gate or business rule the desktop screen enforces?

- Compare against `docs/parity/<screen>.md` for every screen the diff touches.
- **Gates are universal** — identical on every viewport. Only *presentation*
  differs mobile↔desktop. A gate absent on mobile is a bug, not a simplification.
- Permission answers come from `GET /api/v1/permission_resources`. Flag any
  attempt to reimplement CanCanCan client-side or to hardcode a role check.
- A ported screen with no parity doc at all is itself a finding.
- Conditional rendering and business rules count, not just permissions.

## `data`

Does the data layer do the right thing when things aren't the happy path?

- Query keys: unique, correctly parameterized, stable across renders.
- **Missing invalidation after a mutation** — the classic bug. Trace every
  mutation to the queries whose data it makes stale.
- Raw `fetch` or a new HTTP client instead of the ky client in `src/api/client.ts`
  (which sends `credentials: 'include'` and handles 401 → `/login`).
- Loading, error, and empty states — all three, not just the happy path.
- `useEffect` doing what TanStack Query should do.
- Mutations going through TanStack Query instead of ky directly (repo convention
  is queries via TanStack, mutations via ky).

## `types`

Where can this blow up at runtime despite compiling?

- `any`, non-null assertions (`!`), and `as` casts — each is a claim the compiler
  can't check. Is the claim true?
- **Unvalidated `.json<T>()` at the API boundary** — the type is a promise the
  server never made. Known repo-wide gap; report it only when *this diff* adds a
  new unvalidated boundary, not as a standing complaint.
- Optional chaining hiding a value that should never be missing.
- Discriminated unions with unhandled variants.

## `convention`

Does this match `docs/COMPONENTS.md`, or only resemble it?

- Tier placement: is feature logic sitting in `components/ui/`? Is a shared
  primitive buried in `features/`?
- Component shape: folder + named file + `index.ts`, named exports, TS interface
  in-file, colocated `*.test.tsx`.
- `cva()` for variants; no per-component `.css`, no `sx`, no inline style objects.
- **Design tokens only** — hardcoded hex (`rgb(0,91,113)`) or raw Tailwind palette
  (`bg-blue-600`) instead of `bg-header` / `bg-primary`.
- Hand-rolled where the convention is a library: dropdowns/dialogs → Radix,
  forms → React Hook Form + Zod, data lists → `@tanstack/react-table`.
- **Note the TRANSITIONAL POC caveat**: parts of `src/features/*` predate the
  convention. Copying their styling is still a finding — "the neighboring file
  does it" is not a defense. But do not report the pre-existing files themselves;
  only what this diff adds.

Also folded into this lens:

- **Scope creep** — diff content unrelated to the ticket. Unrelated refactors,
  drive-by renames, reformatting that inflates the diff.
- **Hygiene** — `console.log`, commented-out code, stray/committed artifacts,
  `.only` left in tests, hardcoded English copy in user-facing strings (i18n is a
  known TANGO-18 parity item).

## `mobile-a11y`

Does this work on a phone, and with a keyboard or screen reader?

- Hover-only affordances — no hover on touch. Tooltips carrying required info.
- Tap targets below ~44px; controls crowded at the thumb edge.
- Missing labels on inputs and icon-only buttons; `aria-*` that lies.
- Focus: order, visible ring, focus not trapped in a sheet/modal, focus not
  restored on close.
- Mobile-first: does the layout start from the mobile viewport, or is it a
  desktop layout with breakpoints bolted on?
- Fixed heights / `100vh` breaking against mobile browser chrome and safe areas.

## `tests`

Would these tests fail if the feature broke?

- Colocated `*.test.tsx` next to the component.
- **Asserts behavior, not implementation** — testing that a mock was called is
  not testing that the feature works.
- New branches and error paths left uncovered.
- MSW handlers in `src/mocks/handlers.ts` updated when the API shape changed —
  a stale mock makes the whole suite lie.
- Tests that pass regardless of the change (no meaningful assertion, awaiting
  nothing, querying something always present).
- A bug fix with no regression test.
