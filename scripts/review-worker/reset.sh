#!/usr/bin/env bash
# Restores the reviewer fixture to its original files. Run by
# glossa-review-reset.timer daily at 09:00 UTC.
set -euo pipefail

systemctl stop glossa-review.service
trap 'systemctl start glossa-review.service' EXIT
runuser -u glossa-review -- env HOME=/var/lib/glossa-review \
  node /var/lib/glossa-review/glossa/scripts/prepare-app-review-workspace.mjs --reset
