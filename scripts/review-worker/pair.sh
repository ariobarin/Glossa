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
until journalctl -u glossa-review.service --since "$since" --no-pager -o cat | grep -q 'Pairing code:'; do
  sleep 1
done
journalctl -u glossa-review.service --since "$since" --no-pager -o cat | grep -E 'Pairing code:|Enter it at' | tail -n 2

until [ -s "$credential" ]; do
  sleep 2
done
chattr +i "$credential"
echo "Paired. The device credential is locked."
journalctl -u glossa-review.service --since "$since" --no-pager -o cat | tail -n 3
