#!/usr/bin/env bash
# Pairs the reviewer worker with the dedicated reviewer account, then locks
# the device credential so a reviewer command can't remove it.
# Redeem the printed code at https://mcp.glossa.sh/panel while signed in as
# the reviewer account.
set -euo pipefail

credential=/var/lib/glossa-review/.config/glossa/device.json

if [ -e "$credential" ]; then
  echo "Already paired. To pair again: chattr -i $credential, run 'glossa unpair' as glossa-review, then rerun this script." >&2
  exit 1
fi

since="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart glossa-review.service
echo "Waiting for a pairing code..."
deadline=$((SECONDS + 120))
until journalctl -u glossa-review.service --since "$since" --no-pager -o cat | grep -q 'Pairing code:'; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "No pairing code after 2 minutes. Check: journalctl -u glossa-review.service" >&2
    exit 1
  fi
  sleep 1
done
journalctl -u glossa-review.service --since "$since" --no-pager -o cat | grep -E 'Pairing code:|Enter it at' | tail -n 2

# The CLI prints a fresh code when one expires; give the reviewer 30 minutes.
deadline=$((SECONDS + 1800))
until [ -s "$credential" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Not paired after 30 minutes. Rerun this script to try again." >&2
    exit 1
  fi
  sleep 2
done
chattr +i "$credential"
echo "Paired. The device credential is locked."
journalctl -u glossa-review.service --since "$since" --no-pager -o cat | tail -n 3
