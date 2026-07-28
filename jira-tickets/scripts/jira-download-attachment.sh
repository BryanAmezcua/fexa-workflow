#!/bin/bash
# jira-download-attachment.sh — Download a single Jira attachment by ID.
# Saves under <repo>/qa/_attachments/ (gitignored) by default; override with
# JIRA_ATTACHMENTS_DIR in the config.
# Config: ~/.config/fexa-workflow/config.env
#
# Usage: jira-download-attachment.sh <TICKET-KEY> <ATTACHMENT-ID> [output-filename]
# Output filename defaults to "<KEY>_attachment_<ID>.bin" if not given.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/jira-common.sh"

# scripts/ -> jira-tickets/ -> repo root (resolves through the ~/.claude symlink)
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ATTACH_DIR="${JIRA_ATTACHMENTS_DIR:-$REPO_ROOT/qa/_attachments}"

if [[ -z "${1:-}" || -z "${2:-}" ]]; then
  echo "Usage: $0 <TICKET-KEY> <ATTACHMENT-ID> [output-filename]" >&2
  exit 1
fi

KEY="$1"
ATTACH_ID="$2"
OUT_NAME="${3:-${KEY}_attachment_${ATTACH_ID}.bin}"

mkdir -p "$ATTACH_DIR"
OUT_PATH="$ATTACH_DIR/$OUT_NAME"

curl -sS -L -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -o "$OUT_PATH" \
  "$JIRA_HOST/rest/api/3/attachment/content/$ATTACH_ID"

echo "saved: $OUT_PATH"
ls -la "$OUT_PATH"
file "$OUT_PATH"
