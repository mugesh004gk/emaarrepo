#!/bin/sh
# Push to GitHub, then put one screenshot of the pushed property on the client progress tracker.
#   sh scripts/push.sh
# The push itself creates the tracker update (GitHub webhook, date and time in IST); this adds the screenshot,
# taken on this computer with Chrome from the pushed version of the 3D app (about 1-2 minutes).
set -e
cd "$(git rev-parse --show-toplevel)"
before=$(git rev-parse -q --verify refs/remotes/origin/main || true)
git push origin HEAD
if [ -n "$before" ]; then commits=$(git rev-list --reverse "$before..HEAD" | tail -5 | tr '\n' ' '); else commits=$(git rev-parse HEAD); fi
[ -n "$commits" ] || { echo "Nothing new pushed."; exit 0; }
echo "Taking the screenshot for the tracker..."
COMMITS="$commits" PW_MODULE="$HOME/.emaar-tracker/node_modules/playwright-core/index.mjs" PW_CHANNEL=chrome \
  node .github/tracker/capture.mjs
