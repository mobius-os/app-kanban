#!/usr/bin/env bash
# Every five minutes: ask this deployment's Kanban service to wake members whose
# mention notifications are due again. The service does the work and its own
# backoff (5, 10, 20, 40 minutes, then hourly, for up to a week); most runs find
# nothing due and return at once.
set -euo pipefail

APP_ID="${1:?numeric app id required}"
curl -sf -X POST \
  -H "Authorization: Bearer $APP_TOKEN" -H "Content-Type: application/json" \
  --data '{}' "${API_BASE_URL:-http://localhost:8000}/api/apps/$APP_ID/service/boards/mentions/retry" >/dev/null
