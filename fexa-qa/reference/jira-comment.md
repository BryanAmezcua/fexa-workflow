# Jira comment format

Read this only when the user asks you to draft or post a comment. Never auto-post.

Fixed-width **AC-coverage matrix** — one line per acceptance criterion, wrapped in
a code fence so alignment holds in Jira. The HTML report carries all detail — keep
the comment to the matrix.

```
TANGO QA REPORT
================================================================
Ticket:      <TICKET> — <JIRA_HOST>/browse/<TICKET>
App:         PWA (fexa-pwa, React) — mobile 390x844
             |  CMMS (Fexy-Zamo, Ext JS) — desktop
Personas:    <persona label(s), " | "-separated>
Environment: local — <base URL, e.g. http://localhost:5173>
Fixtures:    seeded (seed-manifest-<lower-ticket>.json)
Run:         <YYYY-MM-DD> (duration: <mm:ss or ~Ns>)

Result: <N> passed | <M> failed | <S> skipped  ·  AC <first>–<last> covered

Acceptance criteria:
  [PASS]  <AC ref>  <one-line AC summary, plain language>
  ...

Report: <TICKET>.html (attached) — per-test evidence: request/response cards + before/after screenshots
================================================================
```

- `App` and `Environment` are separate lines. A reader scanning an attached report
  needs to know which application before which host, and `http://localhost:5173`
  means nothing on its own.
- `<AC ref>` = the ticket's own AC identifiers (`AC1`, `Site Setting #2`) —
  verbatim, one matrix row per AC clause.
- All-passing is the assumed case. Any unverified AC → `[FAIL]`/`[PARTIAL]` row +
  a short `Details:` block below the matrix (observed vs expected + evidence pointer).
- If a ticket was QA'd on both apps, use one comment with an `(cmms)` / `(pwa)` tag
  per matrix row — one AC, proven twice, side by side.
- Findings that don't fail an AC stay OUT of the comment — report + summary only.
