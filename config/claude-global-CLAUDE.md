# Global Rules

## Git workflow
- Before starting any work in a git repo, pull the latest for the current integration branch first (`git fetch` + rebase, e.g. `git pull --rebase`) — teammates push between sessions, so never assume the local branch matches the remote. Sync again before pushing.

## Commits
- Never include "Co-Authored-By" or any "committed with Claude" attribution in commit messages.
- Never commit or stage changes without explicit user approval. Only make code changes and let the user test first.

## Session habits
- At the end of a work session, when asked to wrap up, update the "Current status" block in the project's CLAUDE.md (or CLAUDE.local.md) so the next session re-orients from files, not pasted prompts.

## Repo map (this machine)
- `~/work/Fexy-Zamo` — Rails 5.2 + Ext JS CMMS (company repo; personal context in CLAUDE.local.md + memory-bank/)
- `~/work/fexa-pwa` — React 19/Vite PWA rewrite (node 20 via nvm)
- `~/work/fexa-workflow` — Claude skills + QA engine (jira-tickets, fexa-qa skills symlinked into ~/.claude/skills)
