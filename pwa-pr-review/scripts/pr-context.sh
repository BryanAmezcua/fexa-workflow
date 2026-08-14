#!/bin/bash
# pr-context.sh — Gather everything a PR review needs into one work directory.
#
# Writes to  ~/.cache/fexa-workflow/reviews/<repo>/pr-<n>/
#   meta.json     PR metadata (number, title, body, head SHA, author, files)
#   diff.patch    unified diff, base..head
#   commits.txt   commit narrative
#   anchors.json  legal inline-comment anchors (see diff-anchors.py)
#   files.txt     changed paths, one per line
#
# Prints the work directory path on stdout (last line) so callers can cd to it.
#
# Usage: pr-context.sh <pr-number> [--repo owner/name]
#        Run from inside the target repo, or pass --repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PR=""
REPO_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_ARG=(--repo "$2"); shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) PR="$1"; shift ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Usage: $0 <pr-number> [--repo owner/name]" >&2
  exit 1
fi

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated — run: gh auth login" >&2; exit 1; }

REPO_SLUG="$(gh repo view "${REPO_ARG[@]}" --json nameWithOwner -q .nameWithOwner)"
SAFE_SLUG="${REPO_SLUG//\//_}"
WORK="${HOME}/.cache/fexa-workflow/reviews/${SAFE_SLUG}/pr-${PR}"
mkdir -p "$WORK"

gh pr view "$PR" "${REPO_ARG[@]}" \
  --json number,title,body,url,state,isDraft,author,headRefName,headRefOid,baseRefName,changedFiles,additions,deletions,files \
  > "$WORK/meta.json"

gh pr diff "$PR" "${REPO_ARG[@]}" > "$WORK/diff.patch"

BASE="$(jq -r .baseRefName "$WORK/meta.json")"
HEAD="$(jq -r .headRefName "$WORK/meta.json")"
gh pr view "$PR" "${REPO_ARG[@]}" --json commits \
  -q '.commits[] | "\(.oid[0:7]) \(.messageHeadline)"' > "$WORK/commits.txt" || true

jq -r '.files[].path' "$WORK/meta.json" > "$WORK/files.txt"

python3 "$SCRIPT_DIR/diff-anchors.py" < "$WORK/diff.patch" > "$WORK/anchors.json"

# ── summary to stderr so stdout stays a clean path ────────────────────────────
{
  echo "repo:     $REPO_SLUG"
  echo "pr:       #$PR  $(jq -r .title "$WORK/meta.json")"
  echo "author:   $(jq -r .author.login "$WORK/meta.json")"
  echo "branch:   $HEAD -> $BASE"
  echo "head sha: $(jq -r .headRefOid "$WORK/meta.json")"
  echo "files:    $(jq -r .changedFiles "$WORK/meta.json")  (+$(jq -r .additions "$WORK/meta.json") -$(jq -r .deletions "$WORK/meta.json"))"
  echo "anchors:  $(jq '[.[].RIGHT | length] | add // 0' "$WORK/anchors.json") postable RIGHT-side lines"
} >&2

echo "$WORK"
