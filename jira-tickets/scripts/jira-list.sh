#!/bin/bash
# jira-list.sh — List tickets assigned to the user across all open sprints.
# Outputs a column-aligned table: KEY  TYPE  STATUS  PRIORITY  SUMMARY
# Requires: curl, jq, column. Config: ~/.config/fexa-workflow/config.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/jira-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not installed. Run: sudo apt install -y jq" >&2
  exit 1
fi

response=$(curl -sS \
  -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -G "$JIRA_HOST/rest/api/3/search/jql" \
  --data-urlencode "jql=assignee = currentUser() AND sprint in openSprints()" \
  --data-urlencode "fields=summary,status,issuetype,priority")

if echo "$response" | jq -e '.errorMessages // empty | length > 0' >/dev/null 2>&1; then
  echo "Jira returned an error:" >&2
  echo "$response" | jq -r '.errorMessages[]' >&2
  exit 1
fi

issue_count=$(echo "$response" | jq -r '(.issues // []) | length')
if [[ "$issue_count" -eq 0 ]]; then
  echo "(no tickets in any open sprint assigned to $JIRA_EMAIL)"
  exit 0
fi

{
  printf "KEY\tTYPE\tSTATUS\tPRIORITY\tSUMMARY\n"
  echo "$response" | jq -r '
    .issues[] | [
      .key,
      .fields.issuetype.name,
      .fields.status.name,
      (.fields.priority.name // "—"),
      .fields.summary
    ] | @tsv
  '
} | column -t -s $'\t'
