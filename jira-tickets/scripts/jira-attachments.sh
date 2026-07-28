#!/bin/bash
# jira-attachments.sh — List attachments on a Jira issue.
# Outputs TSV: id<TAB>filename<TAB>content_url
# Config: ~/.config/fexa-workflow/config.env
#
# Usage: jira-attachments.sh <TICKET-KEY>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/jira-common.sh"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY>" >&2
  exit 1
fi

KEY="$1"

curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -G "$JIRA_HOST/rest/api/3/issue/$KEY" \
  --data-urlencode 'fields=attachment' \
  | jq -r '.fields.attachment[] | [.id, .filename, .content] | @tsv'
