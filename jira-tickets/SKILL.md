---
name: jira-tickets
description: Lists the user's Jira tickets across open sprints and renders full ticket details. With no ticket key, prints a compact table of everything assigned to the user in open sprints. With a key like TANGO-9, fetches and renders that ticket's description, comments, and metadata as readable markdown. Use when the user asks what's on their plate, what's in their sprint, what to work on next, or for the details/brief of a specific ticket key.
---

# jira-tickets

Two modes, chosen by the user's input. Scripts live in `scripts/` next to this file
and read identity + token from `~/.config/fexa-workflow/` (never from this folder).

| User said | Mode | Action |
|---|---|---|
| No ticket key ("what's in my sprint", "list my tickets") | **List** | Run `scripts/jira-list.sh`. Print the table verbatim. |
| A ticket key ("brief TANGO-9", "show me FIFI-12") | **Brief** | Run `scripts/jira-fetch.sh <KEY>`. Render per the rules below. |

If the session runs on Windows-side Claude (repo lives in WSL), prefix script calls
with `wsl -- bash`. From a WSL session, run them directly.

## List mode

Run: `bash scripts/jira-list.sh`

The JQL is fixed: `assignee = currentUser() AND sprint in openSprints()`. Print the
resulting table verbatim — no reformatting, no commentary, no follow-up actions. If
the user wants different filtering, point them at the Jira UI.

## Brief mode

1. **Load project context (if configured).** If `MEMORY_BANK` is set in
   `~/.config/fexa-workflow/config.env` and the directory exists, read its `*.md`
   files before rendering to interpret ticket terms in domain language. Use it
   silently — don't quote it back. If it's absent, proceed without it.
2. **Fetch:** `bash scripts/jira-fetch.sh <KEY>` — returns raw JSON from
   `/rest/api/3/issue/{key}`.
3. **Render** in this order:
   - **Header:** `# <key>: <summary>` then Status, Type, Priority, Labels,
     Reporter, Assignee, Parent, Created/Updated (YYYY-MM-DD). Omit null/empty lines.
   - **Description** under `## Description`. The body is Atlassian Document Format
     (ADF) — convert using [reference/adf-rendering.md](reference/adf-rendering.md).
     Write `_(no description)_` if empty.
   - **Comments** under `## Comments`: the 5 most recent, oldest-of-those first.
     Format: `### <author> — <YYYY-MM-DD HH:MM>` then the ADF-rendered body.
     `_(no comments)_` if none.
   - **Subtasks:** only if the user asks — render as a Key/Status/Summary table.
4. **Stop.** Don't start coding, branching, or QA. Wait for the next instruction.

## Attachments (only when asked)

- List: `bash scripts/jira-attachments.sh <KEY>` (TSV: id, filename, url)
- Download: `bash scripts/jira-download-attachment.sh <KEY> <ATTACHMENT-ID> [name]`
  — saves under the repo's `qa/_attachments/` (gitignored).

## Posting comments (only on explicit user request)

`bash scripts/jira-comment.sh <KEY> <adf-body.json|->` — body is a full ADF payload
(`{"body": {"type": "doc", ...}}`). Never post without the user explicitly asking.

## Errors

Surface script errors verbatim, then add the fix:

| Error | Tell the user |
|---|---|
| config missing at ~/.config/fexa-workflow/config.env | Run `bin/setup.sh` from the fexa-workflow repo, then edit the config. |
| token file missing/empty | Generate at https://id.atlassian.com/manage-profile/security/api-tokens and save as one line in `~/.config/fexa-workflow/jira-token`. |
| HTTP 401 | Token invalid/expired — regenerate and overwrite `~/.config/fexa-workflow/jira-token`. |
| `jq: command not found` | `sudo apt install -y jq` in WSL. |
| 404 on a ticket | Key doesn't exist or no access — double-check it. |

## Hard rules

- **Never print the Jira token** in any output, even if visible in errors.
- **Verbatim acceptance-criteria text** — when a ticket has AC, preserve the exact
  wording in the rendering. No paraphrasing.
- **No auto-actions** after rendering — no code, no branches, no Jira posts.
