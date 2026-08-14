---
name: pwa-pr-review
description: Reviews a teammate's pull request on the fexa-pwa repo against its Jira acceptance criteria and the repo's documented conventions, using a committee of agents. Verifies each AC point by reading the actual implementation, reviews the diff through six fixed lenses (parity, data, types, convention, mobile-a11y, tests), adversarially challenges every finding and every "met" verdict, then writes a local report for the human to adjudicate. Optionally posts the result to GitHub as a single review with inline line comments. Use when the user asks to review a PR, check a colleague's PR, verify a PR meets its ticket, or post review comments — e.g. "review PR 14", "does Kevin's PR meet the AC", "/pwa-pr-review 14 --post".
---

# pwa-pr-review

Reviews a fexa-pwa PR against its acceptance criteria and the repo's conventions.
Produces recommendations; **the human makes the call.** Never approves, never
requests changes, never posts without explicit confirmation.

Design rationale lives in `SPEC.md` next to this file. Lens prompts live in
`reference/lenses.md`. Scripts are in `scripts/`.

## Modes

| User said | Do |
|---|---|
| `review PR 14`, `/pwa-pr-review 14` | Full review. Report locally. **Do not post.** |
| `/pwa-pr-review 14 TANGO-90` | Same, explicit ticket override. |
| `/pwa-pr-review` (no number) | Resolve PR from current branch: `gh pr view --json number`. |
| `/pwa-pr-review 14 --post` | Full review, print report, confirm, then post. |
| `post it`, `/pwa-pr-review --post-last 14` | Post the existing (possibly edited) findings. Skip phases 0–4. |

---

## Phase 0 — Scout (main loop, no agents)

```bash
WORK=$(bash <skill-dir>/scripts/pr-context.sh <n>)   # prints the work dir
```

That writes `meta.json`, `diff.patch`, `commits.txt`, `files.txt`, and
`anchors.json` (the legal inline-comment lines) into
`~/.cache/fexa-workflow/reviews/<owner_repo>/pr-<n>/`.

Then, yourself:

1. **Read `diff.patch` in full.** You are the one synthesizing later; do not
   delegate your own understanding of the change.
2. **Resolve the ticket** — `--ticket` arg → `TANGO-\d+` in branch name → PR
   title → PR body. Fetch with `jira-tickets/scripts/jira-fetch.sh <KEY>`.
   Extract acceptance criteria **verbatim** and split into numbered atomic
   points. Never paraphrase an AC point before handing it to an agent.
   - No ticket found → run **AC-free mode** (lenses only) and say so in the
     report header. Do not invent acceptance criteria.
   - Ticket has no structured AC → derive candidate points from the description
     and mark each `DERIVED` in the report.
3. **Bucket changed files by tier**: `api/`, `components/ui/`, `components/data/`,
   `components/layout/`, `features/`, `lib/`, docs, tests.
4. **Check the do-not-touch zones.** If the diff modifies auth interceptors in
   `src/api/*`, `usePressoChat.ts`, `TranscribeStreaming.ts`,
   `MicrophoneCapture.ts`, or `useVoiceChat.ts` → blocker-candidate, phrased as a
   question (see Tone).
5. **Parity docs.** For each screen the diff touches, is there a
   `docs/parity/<screen>.md`? Missing one for a ported screen is a finding.
6. **Run the machine checks and record the output** — `npm run lint`,
   `npm run build`, `npm run test:run` on the PR head. Everything they catch is
   subtracted from the findings later (Suppression rule 1). Node 20:
   `. "$HOME/.nvm/nvm.sh" && nvm use 20`.

Read `CLAUDE.md`, `docs/COMPONENTS.md`, and `docs/parity/README.md` before
spawning anything — every agent gets pointed at them, and you need them to judge
the returns.

---

## Phase 1 — AC verification (one agent per AC point)

Spawn these in **one message**, in parallel with Phase 2. Each agent gets: the
verbatim AC text, the work-dir path, the repo path, and this contract:

> Determine whether this one acceptance-criteria point is satisfied by the code
> in this diff. Read the actual implementation — **never infer behavior from a
> file or symbol name.** A component called `WorkorderFilters` is not evidence
> that filtering works. Trace the path a user would take: find the component, the
> handler, the state change, and the request. Cite `file:line` for every claim.

Return schema:

```json
{
  "ac_id": "3",
  "ac_text": "<verbatim>",
  "verdict": "met | partial | not-met | cant-tell",
  "evidence": [{"file": "src/...", "line": 42, "what": "..."}],
  "reasoning": "<2-4 sentences, mechanism not vibes>",
  "gaps": ["<what is missing, if partial or not-met>"],
  "confidence": "high | medium | low"
}
```

**`cant-tell` is a first-class verdict** — correct whenever the AC depends on
backend behavior, a runtime permission response, or anything not observable in
the diff. An agent guessing past `cant-tell` is worse than the honest answer.
Do not let an agent's confidence substitute for evidence.

---

## Phase 2 — Lens review (one agent per lens)

Six agents, prompts in `reference/lenses.md`: `parity`, `data`, `types`,
`convention`, `mobile-a11y`, `tests`. Each answers one narrow question, not
"review this PR". Each returns an array of findings in the schema below, or an
empty array — **an empty array is a good outcome and must never be padded.**

---

## Phase 3 — Adversarial verification

Two fan-outs, both spawned together once Phases 1–2 return:

1. **Refute every finding.** One challenger each: *"Is this actually wrong, or is
   it a stylistic preference, already handled elsewhere, or caught by lint/tsc?
   Default to refuted when uncertain."* A finding survives only if the challenger
   cannot refute it. Survivors are `CONFIRMED`; contested ones become `PLAUSIBLE`
   and are labeled as such in the comment.
2. **Attack every `met` verdict.** *"Find the input, state, or code path where
   this AC point fails despite the implementation shown."* A `met` that survives
   is reportable. One that doesn't is downgraded to `partial` with the
   counterexample attached.

`not-met` and `cant-tell` skip this phase — the burden is on claims of success
and on findings, not on admissions of doubt.

---

## Phase 4 — Synthesis (main loop)

Dedupe by `(path, line, category)`. Apply the suppression rules. Sort blocker →
should-fix → nit. Cap nits at 5 and state how many were dropped.

Write two files into the work dir:

- **`findings.json`** — array of findings (schema below). Machine source of truth.
- **`body.md`** — the review body: header, AC verdict table, then the prose
  summary. The posting script appends the non-anchored findings section itself,
  so do not write that section by hand.

Then print the report in the conversation so the user can adjudicate.

### Finding schema (`findings.json`)

```json
{
  "id": "f7",
  "severity": "blocker | should-fix | nit",
  "category": "parity | data | types | convention | mobile-a11y | tests | scope | hygiene",
  "path": "src/features/workorders/filters/FilterSheet.tsx",
  "line": 84,
  "start_line": null,
  "anchor": "inline | body",
  "title": "<= 60 chars",
  "body": "<the comment as posted>",
  "failure_scenario": "<concrete: given X, Y happens>",
  "verdict": "CONFIRMED | PLAUSIBLE"
}
```

`failure_scenario` is **mandatory and gates inclusion** — if no agent can state
concrete inputs producing a concrete wrong outcome, the finding is dropped. The
posting script refuses findings without it. This is the single biggest quality
lever in the skill.

### `body.md` layout

```markdown
## Review — TANGO-90 · PR #14

<2-3 sentence summary: what the PR does, what state it's in.>

### Acceptance criteria
| # | AC | Verdict | Evidence |
|---|----|---------|----------|
| 1 | … | ✅ met | `FilterSheet.tsx:84` |
| 2 | … | ⚠️ partial | missing: multi-select persistence |
| 3 | … | ❓ can't tell | depends on server permission response |

_Verdicts are a reviewer's reading of the code, not a test run._
```

---

## Suppression rules (non-negotiable)

1. **Nothing lint, `tsc`, or CI already catches.** Subtract the Phase-0 output.
   Zero review value; erodes trust in every other comment.
2. **"Violates a documented convention" is a finding. "Differs from how I'd write
   it" is not.** Cite the doc and line, or drop it.
3. **No finding without `file:line` or an explicit body-anchor reason.**
4. **No restating the PR description.**
5. **Max 5 nits**, with the dropped count reported.
6. **Do-not-touch zones**: always a blocker-candidate, always phrased as a
   question — that code is hard-won and undocumented, and the author may know
   something you don't.

## Tone

- State the mechanism and the consequence, then stop.
- Blockers may be direct. Anything touching integration code is a question.
- No praise padding, no "great work overall!", no apologies.
- This is a colleague who will read every line. Brevity is respect.

---

## Phase 5 — Posting

**Only on explicit `--post` / "post it", and only after confirmation.**

```bash
python3 <skill-dir>/scripts/post-review.py "$WORK"             # dry run
python3 <skill-dir>/scripts/post-review.py "$WORK" --confirm   # posts
```

The dry run validates every anchor against `anchors.json`, demotes any comment
whose line is not in the diff into the review body, writes `payload.json`, and
prints the exact counts. Show those counts to the user and get a yes before
running `--confirm`.

One API call, one review, `event: "COMMENT"`, pinned to `headRefOid` so comments
land on the code you actually read even if the author pushes mid-review.

**Never `APPROVE`. Never `REQUEST_CHANGES`.** The verdict is the human's.

### Adjudication loop

1. Skill prints the report.
2. User strikes, downgrades, or edits — conversationally ("drop f3, downgrade f7
   to a nit") or by editing `findings.json` directly. Apply their edits to
   `findings.json`.
3. Re-run the dry run, show the counts, confirm, post.

The skill never posts an AC verdict the user hasn't seen.
