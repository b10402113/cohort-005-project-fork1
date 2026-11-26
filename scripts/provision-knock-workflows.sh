#!/usr/bin/env bash
#
# Pushes the committed Notification workflows and the in-app feed channel into
# Knock's Development environment. Definitions live under knock/ as the source
# of truth; this script only sends them.
#
# Requires a Knock *service token* with workflow write scope, which this repo
# does not carry by default. Without it the script explains what to do in the
# dashboard instead. It never runs as part of tests.
#
# Usage: KNOCK_SERVICE_TOKEN=... bash scripts/provision-knock-workflows.sh

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
API="https://api.knock.app/v1"

_env_value() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line
  line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

SERVICE_TOKEN="${KNOCK_SERVICE_TOKEN:-}"
FEED_CHANNEL_ID="${KNOCK_FEED_CHANNEL_ID:-$(_env_value KNOCK_FEED_CHANNEL_ID || true)}"

if [[ -z "$SERVICE_TOKEN" ]]; then
  echo "No KNOCK_SERVICE_TOKEN set, so nothing is pushed."
  echo
  echo "Provision by hand in the Knock Development environment:"
  echo "  1. Create an in-app feed channel named 'Cadence feed'."
  echo "  2. For each key under knock/workflows/, create a workflow with that key,"
  echo "     add its categories, and add an in-app feed step on 'Cadence feed'."
  echo "  3. Commit each workflow to Development (an uncommitted workflow 404s)."
  echo
  echo "Or re-run with: KNOCK_SERVICE_TOKEN=<service token> bash $0"
  exit 0
fi

if [[ -z "$FEED_CHANNEL_ID" ]]; then
  echo "KNOCK_FEED_CHANNEL_ID is missing from $ENV_FILE and the environment." >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "jq is required." >&2; exit 1; }

for file in knock/workflows/*/workflow.json; do
  key=$(jq -r '.key' "$file")
  categories=$(jq -c '.categories' "$file")
  echo "Pushing workflow $key (categories: $categories)..."
  jq -n --arg key "$key" --argjson categories "$categories" \
    --arg channel "$FEED_CHANNEL_ID" \
    '{key: $key, categories: $categories, channel: $channel}' \
    | curl -sS -X PUT "$API/workflows/$key" \
        -H "Authorization: Bearer $SERVICE_TOKEN" \
        -H "Content-Type: application/json" \
        --data-binary @- >/dev/null
done

echo "Done. Feed channel: $FEED_CHANNEL_ID"
