#!/usr/bin/env bash
# Start the Chrome that the browser relay attaches to.
#
# WHY A DEDICATED --user-data-dir IS MANDATORY, NOT A PREFERENCE
# From Chrome 136 on, --remote-debugging-port and --remote-debugging-pipe are IGNORED when Chrome
# uses its default user-data directory (developer.chrome.com/blog/remote-debugging-port). This
# machine runs Google Chrome 157.0.8103.38, so attaching to the everyday ~/.config/google-chrome
# profile over CDP is impossible by design — it is anti-cookie-theft hardening, not a missing flag.
# A separate --user-data-dir also has its own encryption key, so it cannot read the real profile's
# cookies either. That is the point: the profile you expose here holds only what you put in it.
#
# What that means for the relay: you sign into perplexity.ai ONCE in this window. Perplexity
# conversations are account-scoped server-side, so threads you started elsewhere are reachable
# here — which is what preserves "continue the same chat".
#
# The port default matches scripts/perplexity-browser-adapter.mjs --cdp so the two agree without
# anyone passing a flag.
set -euo pipefail

PROFILE="${BROWSER_PROFILE:-$HOME/ai/scratch/pw-probe/profile}"  # the profile you already signed into; must NOT be ~/.config/google-chrome
PORT="${CDP_PORT:-9333}"                                         # matches the adapter's default --cdp

if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${PORT} "; then
  echo "port ${PORT} is already listening — a CDP Chrome is probably already running."
  echo "  curl -s http://127.0.0.1:${PORT}/json/version   # inspect it; if it is yours, skip this script"
  exit 1
fi

mkdir -p "$PROFILE"
echo "launching Chrome  port=${PORT}  user-data-dir=${PROFILE}"
echo "then: sign in to perplexity.ai in that window (once), and open — or start — the conversation to"
echo "relay to. Nothing reads or types into it until you run the adapter and approve a run."
exec google-chrome-stable \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  https://www.perplexity.ai/
