# pwa-pr-review — Skill Spec

Reviews a teammate's fexa-pwa PR against (a) the Jira acceptance criteria and
(b) the repo's own conventions. Produces a local report you adjudicate, then
optionally posts it to GitHub as a single review with inline line comments.

Status: **spec — not built yet.**

---

## 1. Invocation

| User says | Behavior |
|---|---|
| `/pwa-pr-review 42` | Review PR #42. Report locally. Do not post. |
| `/pwa-pr-review 42 TANGO-90` | Same, with an explicit ticket override. |
| `/pwa-pr-review` | Resolve the PR from the current branch (`gh pr view --json number`). |
| `/pwa-pr-review 42 --post` | Review, print report, **ask for confirmation**, then post. |
| `/pwa-pr-review --post-last` | Post the previously-generated report after edits. |

Never posts without an explicit `--post` **and** a confirmation prompt showing
the exact comment count and the target PR.

---

## 2. Inputs to gather (main loop, before any agent spawns)

```bash
gh pr view <n> --json number,title,body,headRefName,headRefOid,baseRefName,author,files,url
gh pr diff <n>                 # unified diff
git log --oneline base..head   # commit narrative
```

**Ticket resolution order:** `--ticket` arg → `TANGO-\d+` in branch name → in PR
title → in PR body. If none found, run AC-free mode (conventions only) and say so
loudly in the report header.

**AC fetch:** reuse `jira-tickets/scripts/jira-fetch.sh <KEY>`. Extract acceptance
criteria **verbatim** — never paraphrase an AC point before handing it to an agent.
Split into numbered atomic points. If the ticket has no structured AC, derive
candidate points from the description and mark them `DERIVED` in the report.

**Repo context to pass to every agent:** `CLAUDE.md`, `docs/COMPONENTS.md`,
`docs/parity/README.md`, and the parity doc for any screen the diff touches.

---

## 3. Pipeline

```
Phase 0  Scout        (main loop, no agents)
Phase 1  AC verify    (1 agent per AC point)          ─┐ parallel
Phase 2  Lens review  (1 agent per lens, ~6)          ─┘
Phase 3  Adversarial  (1 agent per finding + per "met" verdict)
Phase 4  Synthesize   (main loop)
Phase 5  Post         (only on --post + confirm)
```

### Phase 0 — Scout

Main loop, cheap. Establishes shared facts so agents don't each re-derive them:

- Changed files bucketed by tier (`api/`, `components/ui/`, `components/data/`,
  `components/layout/`, `features/`, `lib/`, docs, tests)
- **Postable-line map** — parse the diff hunks into the set of
  `(path, line)` on the RIGHT side. Built now, consumed in Phase 5. Any finding
  whose anchor is not in this set is body-only. (See §6.)
- Do-not-touch zone hits: does the diff modify `src/api/*` auth interceptors,
  `usePressoChat.ts`, `TranscribeStreaming.ts`, `MicrophoneCapture.ts`,
  `useVoiceChat.ts`? If yes → automatic **blocker-candidate** for Phase 3 to judge.
- Parity doc present for each touched screen? Missing = finding.

### Phase 1 — AC verification (the committee)

One agent per AC point. Each gets: the verbatim AC text, the full diff, repo
access, and this contract:

> Your job is to determine whether this AC point is satisfied by the code in this
> diff. Read the actual implementation — do not infer behavior from file or symbol
> names. Trace the code path a user would take. If the AC describes a UI behavior,
> find the component, the handler, and the state change that produces it.

Returns:

```json
{
  "ac_id": "3",
  "ac_text": "<verbatim>",
  "verdict": "met | partial | not-met | cant-tell",
  "evidence": [{"file": "src/...", "line": 42, "what": "..."}],
  "reasoning": "<2-4 sentences, mechanism not vibes>",
  "gaps": ["<what's missing, if partial/not-met>"],
  "confidence": "high | medium | low"
}
```

**`cant-tell` is a first-class verdict.** Use it when the AC depends on backend
behavior, a runtime permission response, or anything not observable in the diff.
An agent guessing past `cant-tell` is worse than the honest answer.

### Phase 2 — Lens review

One agent per lens. Fixed list — each is a narrow question, not "review this PR":

| Lens | Looks for |
|---|---|
| `parity` | Dropped permission gate / business rule vs. `docs/parity/<screen>.md`. Gates are universal — mobile may only change *presentation*. |
| `data` | Query key correctness, missing invalidation after mutation, `fetch` instead of the ky client, missing loading/error/empty states, effect doing a query's job |
| `types` | `any`, non-null `!`, `as` casts, unvalidated `.json<T>()` at the API boundary |
| `convention` | Tier placement, folder+named-file+`index.ts`, cva vs. inline styles, hardcoded hex vs. `@theme` tokens, hand-rolled where Radix/RHF+Zod is the convention |
| `mobile-a11y` | Hover-only affordances, tap targets, labels/focus order, keyboard traps |
| `tests` | Colocated, asserts behavior not implementation, MSW handlers updated with API shape changes, new branch left uncovered |

Plus two standing checks folded into `convention`: scope creep (diff content
unrelated to the ticket) and hygiene (console logs, commented-out code, stray
files, hardcoded English copy where i18n is a known TODO).

Every lens returns findings in the schema in §4, or an empty array. An empty
array is a good outcome and must not be padded.

### Phase 3 — Adversarial verification

Two jobs, both fan-out:

1. **Challenge every finding.** Prompt is to *refute*: "Is this actually wrong, or
   is it a stylistic preference / already handled elsewhere / caught by CI?"
   Default to refuted when uncertain. A finding survives only if the challenger
   cannot refute it.
2. **Challenge every `met` verdict.** "Find the input, state, or path where this
   AC point fails despite the code shown." A `met` that survives is reportable;
   one that doesn't is downgraded to `partial` with the counterexample attached.

`not-met` and `cant-tell` verdicts skip this phase — the burden is on claims of
success, and on findings.

### Phase 4 — Synthesis

Main loop. Dedupe by `(file, line, category)`. Apply the suppression rules (§5).
Sort blocker → should-fix → nit. Cap nits at 5, note how many were dropped.
Write the report to `docs/reviews/pr-<n>.md` in the PWA repo (gitignored) so the
`--post-last` flow has something to read after you edit it.

---

## 4. Finding schema

```json
{
  "id": "f7",
  "severity": "blocker | should-fix | nit",
  "category": "parity | data | types | convention | mobile-a11y | tests | scope | hygiene",
  "path": "src/features/workorders/filters/FilterSheet.tsx",
  "line": 84,
  "start_line": null,
  "anchor": "inline | body",
  "title": "<≤60 chars>",
  "body": "<the comment as posted — see §7 for tone>",
  "failure_scenario": "<concrete: given X, Y happens>",
  "verdict": "CONFIRMED | PLAUSIBLE"
}
```

`failure_scenario` is mandatory and gates inclusion: if an agent can't state
concrete inputs producing a concrete wrong outcome, the finding is dropped. This
is the single most important quality lever in the skill.

---

## 5. Suppression rules (non-negotiable)

1. **Nothing ESLint, `tsc`, or CI already catches.** Zero review value, erodes
   trust in every other comment. Run `npm run lint` + `npm run build` first and
   subtract anything that overlaps.
2. **"Violates a documented convention" is a finding; "differs from how I'd write
   it" is not.** Cite the doc + line or drop it.
3. **No comment without `file:line` or a body-anchored reason** (§6).
4. **No restating what the PR description already says.**
5. **Max 5 nits.** Report the count dropped rather than posting them.
6. **Do-not-touch zones**: a transport/encoding edit is always a blocker-candidate,
   but the comment asks a question — that code is hard-won and undocumented,
   assume the author knows something you don't.

---

## 6. Anchoring rule

Findings anchor inline only when their line is in the Phase-0 postable-line map
(RIGHT side of a diff hunk). Everything else goes in the **review body**, under a
`### Not anchored to a line` section, each with the file path it concerns.

This matters more than it sounds: many of the best findings are about *absence* —
a missing invalidation, a missing test, a dropped permission gate. Those have no
changed line to attach to and would 422 the entire review if attempted.

**Validate before posting.** A single invalid `(path, line)` fails the whole
review API call. Filter against the map; demote failures to body rather than
retrying.

Multi-line blocks use `start_line` + `line` (both RIGHT side).

---

## 7. Comment tone

- Findings state the mechanism and the consequence, then stop.
- Blockers may be direct. Anything touching integration code is phrased as a
  question, not a correction.
- No praise padding, no "great work overall!", no apologies.
- The report is for a colleague who will read every line — brevity is respect.

---

## 8. Posting

Single API call, single review, `event: "COMMENT"`:

```bash
gh api repos/{owner}/{repo}/pulls/{n}/reviews --input payload.json
```

```json
{
  "commit_id": "<headRefOid from Phase 0>",
  "event": "COMMENT",
  "body": "<summary + AC table + non-anchored findings>",
  "comments": [
    {"path": "src/a.tsx", "line": 42, "side": "RIGHT", "body": "..."},
    {"path": "src/b.ts", "start_line": 10, "line": 14,
     "side": "RIGHT", "start_side": "RIGHT", "body": "..."}
  ]
}
```

`commit_id` pins the review to the reviewed SHA — if the author pushes mid-review,
the comments still land on the code you actually read.

Never `REQUEST_CHANGES` or `APPROVE`. The verdict is yours, not the skill's.

### Review body layout

```markdown
## Review — TANGO-90 · PR #42

### Acceptance criteria
| # | AC | Verdict | Evidence |
|---|----|---------|----------|
| 1 | … | ✅ met | `FilterSheet.tsx:84` |
| 2 | … | ⚠️ partial | missing: multi-select persistence |
| 3 | … | ❓ can't tell | depends on server permission response |

### Blockers (2)
### Should fix (4)
### Not anchored to a line (3)
### Nits — 2 shown, 4 omitted
```

---

## 9. The adjudication flow

1. Skill runs, writes `docs/reviews/pr-<n>.md`, prints it.
2. **You strike, edit, or downgrade anything you disagree with** — the AC verdicts
   especially. Committee output is a recommendation.
3. `--post-last` re-reads the edited file, re-validates anchors against the map,
   shows the final comment count, asks once, posts.

The skill never posts an AC verdict you haven't seen.

---

## 10. Resolved during build

- **Work dir**: `~/.cache/fexa-workflow/reviews/<owner_repo>/pr-<n>/` — outside
  both repos, survives across sessions, no `.gitignore` churn. Holds `meta.json`,
  `diff.patch`, `anchors.json`, `findings.json`, `body.md`, `payload.json`.
- **Source of truth is `findings.json`**, not the rendered markdown. Human edits
  land there (conversationally or by hand); `body.md` holds only the summary and
  AC table. The posting script composes the final body from both.
- **Dry run is the default.** `post-review.py` validates and writes
  `payload.json`; `--confirm` is a separate, explicit invocation.

## 11. Still open

- Re-review flow: on a second run against the same PR, skip findings already
  posted (match by `path` + `title`)? Needs a fetch of existing review comments.
- Agent count: 6 lenses + N AC points + adversarial fan-out. Worth capping the
  AC agents when a ticket has 15+ points.
- Whether `cant-tell` AC verdicts should auto-suggest a fexa-qa run to settle
  them at runtime.
```
