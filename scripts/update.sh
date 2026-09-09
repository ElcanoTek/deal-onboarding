#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ElcanoTek, Inc.
# Deal Onboarding — pull the tracked branch, rebuild, restart.
set -euo pipefail

SRC_DIR="${SRC_DIR:-/opt/deal-onboarding-src}"
APP_DIR="${APP_DIR:-/opt/deal-onboarding}"
APP_USER="${APP_USER:-deal-onboarding}"
CLI_PATH="${CLI_PATH:-/usr/local/bin/deal-onboarding}"

[[ $EUID -eq 0 ]] || { echo "run as root: sudo deal-onboarding update" >&2; exit 1; }
[[ -d "$SRC_DIR/.git" ]] || { echo "no git checkout at $SRC_DIR" >&2; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "no existing install at $APP_DIR" >&2; exit 1; }

if ! command -v go >/dev/null 2>&1; then
  echo "error: go command not found in PATH" >&2
  exit 1
fi
if ! raw_go_version="$(GOTOOLCHAIN=local go version 2>&1)"; then
  echo "error: failed to inspect Go toolchain: $raw_go_version" >&2
  exit 1
fi
if [[ "$raw_go_version" =~ go([0-9]+)\.([0-9]+) ]]; then
  go_major="${BASH_REMATCH[1]}"
  go_minor="${BASH_REMATCH[2]}"
  if (( go_major < 1 || (go_major == 1 && go_minor < 26) )); then
    echo "error: Go 1.26+ required (found go${go_major}.${go_minor}). Upgrade Go before updating." >&2
    exit 1
  fi
else
  echo "error: could not parse Go version from: $raw_go_version" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node command not found in PATH" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm command not found in PATH" >&2
  exit 1
fi
if ! raw_node_version="$(node -v 2>&1)"; then
  echo "error: failed to inspect Node runtime: $raw_node_version" >&2
  exit 1
fi
if [[ "$raw_node_version" =~ v?([0-9]+)\.([0-9]+) ]]; then
  node_major="${BASH_REMATCH[1]}"
  node_minor="${BASH_REMATCH[2]}"
  if (( node_major < 22 || (node_major == 22 && node_minor < 12) || node_major == 23 || node_major == 25 )); then
    echo "error: Node 22.12+, 24.x, or >=26 required (found v${node_major}.${node_minor}). Upgrade Node before updating." >&2
    exit 1
  fi
else
  echo "error: could not parse Node version from: $raw_node_version" >&2
  exit 1
fi

cd "$SRC_DIR"
before_sha="$(git rev-parse HEAD)"
branch="${DEAL_ONBOARDING_UPDATE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
git fetch --quiet origin
after_sha="$(git rev-parse "origin/$branch")"

if [[ "$before_sha" == "$after_sha" ]]; then
  echo "source already at ${before_sha:0:12}; rebuilding deployment"
else
  if [[ "${DEAL_ONBOARDING_UPDATE_YES:-0}" != "1" ]]; then
    echo "incoming commits:"
    git --no-pager log --oneline --no-decorate "${before_sha}..${after_sha}"
    printf 'Apply update %s -> %s? (y/N) ' "${before_sha:0:12}" "${after_sha:0:12}"
    read -r answer
    [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]] || exit 1
  fi
  git checkout --quiet "$branch"
  git pull --ff-only --quiet origin "$branch"
fi
rsync -a --delete \
  --exclude='/.git' \
  --exclude='/.env' \
  --exclude='/data' \
  --exclude='/bin' \
  "$SRC_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/bin"

(cd "$APP_DIR/frontend" && npm install --no-audit --no-fund --loglevel=warn && npm run build)
(cd "$APP_DIR" && go build -o bin/deal-onboarding ./cmd/server && go build -o bin/deal-onboarding-admin ./cmd/deal-onboarding-admin)
chown "$APP_USER:$APP_USER" "$APP_DIR/bin/deal-onboarding" "$APP_DIR/bin/deal-onboarding-admin"
install -m 0755 "$APP_DIR/deploy/deal-onboarding-cli" "$CLI_PATH"
install -m 0644 "$APP_DIR/deploy/deal-onboarding.service" /etc/systemd/system/deal-onboarding.service
systemctl daemon-reload
systemctl restart deal-onboarding.service

echo "updated to ${after_sha:0:12}"
