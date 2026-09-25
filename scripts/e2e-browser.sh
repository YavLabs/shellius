#!/usr/bin/env bash
#
# e2e-browser.sh — run the Playwright suite against the running dev instance.
#
# Browsers are not installed on this machine and installing them needs root,
# so Chromium comes from Microsoft's Playwright image instead. The container
# runs with --network host so `localhost:5173` and `localhost:3001` mean the
# same thing inside it as outside.
#
# Prerequisites: the dev stack up (frontend :5173, API :3001, guacd), and an
# RDP host reachable. Run backend/scripts/e2e-browser-setup.mjs first — it
# provisions a throwaway account and an approved request, and writes the
# credentials to frontend/e2e/.auth.json.
#
#   ./scripts/e2e-browser.sh              # everything
#   ./scripts/e2e-browser.sh rdp.spec.js  # one file
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.49.1-noble"

if [ ! -f "$REPO/frontend/e2e/.auth.json" ]; then
  echo "No frontend/e2e/.auth.json — run:" >&2
  echo "  (cd backend && node scripts/e2e-browser-setup.mjs)" >&2
  exit 1
fi

# Fail early and clearly rather than inside a browser timeout.
for url in http://localhost:5173/ http://localhost:3001/api/health; do
  if ! curl -fsS -o /dev/null --max-time 5 "$url"; then
    echo "not reachable: $url — is the dev stack running?" >&2
    exit 1
  fi
done

exec docker run --rm --network host \
  -v "$REPO/frontend":/work \
  -w /work \
  -e HOME=/tmp \
  -e CI=1 \
  "$IMAGE" \
  npx playwright test "$@"
