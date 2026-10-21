#!/bin/bash
# jira-attach.sh — Attach a file to a Jira issue.
# Config: ~/.config/fexa-workflow/config.env (same auth as jira-comment.sh)
#
# On success prints the attachment id + filename + the issue's browse URL.
#
# Usage:
#   jira-attach.sh <TICKET-KEY> <file> [<file>...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/jira-common.sh"
if [[ -z "${1:-}" || -z "${2:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY> <file> [<file>...]" >&2
  exit 1
fi
KEY="$1"; shift
RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT
rc=0
for FILE in "$@"; do
  if [[ ! -f "$FILE" ]]; then
    echo "ERROR: file not found: $FILE" >&2; rc=1; continue
  fi
  HTTP=$(curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST \
    -H 'X-Atlassian-Token: no-check' \
    -F "file=@$FILE" \
    "$JIRA_HOST/rest/api/3/issue/$KEY/attachments" \
    -o "$RESP_FILE" -w '%{http_code}')
  if [[ "$HTTP" == "200" ]]; then
    AID=$(jq -r '.[0].id' < "$RESP_FILE" 2>/dev/null || echo '?')
    NAME=$(jq -r '.[0].filename' < "$RESP_FILE" 2>/dev/null || basename "$FILE")
    SIZE=$(jq -r '.[0].size' < "$RESP_FILE" 2>/dev/null || echo '?')
    echo "Attached $NAME ($SIZE bytes) to $KEY as attachment $AID (HTTP $HTTP)"
  else
    echo "ERROR: attachment POST of $FILE to $KEY failed (HTTP $HTTP)" >&2
    cat "$RESP_FILE" >&2; rc=1
  fi
done
[[ $rc -eq 0 ]] && echo "  $JIRA_HOST/browse/$KEY"
exit $rc
