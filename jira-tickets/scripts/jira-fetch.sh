#!/bin/bash
# jira-fetch.sh — Fetch a single Jira ticket's full details.
# Prints raw JSON from /rest/api/3/issue/{key} so callers can parse with jq.
# Config: ~/.config/fexa-workflow/config.env
#
# Usage: jira-fetch.sh <TICKET-KEY>  (e.g., TANGO-123)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/jira-common.sh"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY>  (e.g., TANGO-123)" >&2
  exit 1
fi

KEY="$1"

curl -sS \
  -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -G "$JIRA_HOST/rest/api/3/issue/$KEY" \
  --data-urlencode "fields=summary,status,issuetype,priority,labels,description,parent,subtasks,comment,assignee,reporter,created,updated"
