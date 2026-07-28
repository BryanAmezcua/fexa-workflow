#!/bin/bash
# jira-common.sh — shared config/token loading, sourced by every jira-*.sh script.
# Identity and secrets live OUTSIDE the repo in ~/.config/fexa-workflow/.

CONFIG="${FEXA_WORKFLOW_CONFIG:-$HOME/.config/fexa-workflow/config.env}"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config missing at $CONFIG" >&2
  echo "Fix: run bin/setup.sh from the fexa-workflow repo, then edit that file." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG"

if [[ -z "${JIRA_EMAIL:-}" || -z "${JIRA_HOST:-}" ]]; then
  echo "ERROR: JIRA_EMAIL and JIRA_HOST must be set in $CONFIG" >&2
  exit 1
fi

TOKEN_FILE="${JIRA_TOKEN_FILE:-$HOME/.config/fexa-workflow/jira-token}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: token file missing at $TOKEN_FILE" >&2
  echo "Fix: generate at https://id.atlassian.com/manage-profile/security/api-tokens" >&2
  echo "     and save it as one line (no quotes) in $TOKEN_FILE" >&2
  exit 1
fi

JIRA_API_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

if [[ -z "$JIRA_API_TOKEN" ]]; then
  echo "ERROR: token file at $TOKEN_FILE is empty." >&2
  exit 1
fi
