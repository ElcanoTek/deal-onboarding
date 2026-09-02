#!/usr/bin/env bash
# Deal Onboarding — pull the tracked branch, rebuild, restart.
set -euo pipefail

SRC_DIR="${SRC_DIR:-/opt/deal-onboarding-src}"
APP_DIR="${APP_DIR:-/opt/deal-onboarding}"
APP_USER="${APP_USER:-deal-onboarding}"
CLI_PATH="${CLI_PATH:-/usr/local/bin/deal-onboarding}"

[[ $EUID -eq 0 ]] || { echo "run as root: sudo deal-onboarding update" >&2; exit 1; }
[[ -d "$SRC_DIR/.git" ]] || { echo "no git checkout at $SRC_DIR" >&2; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "no existing install at $APP_DIR" >&2; exit 1; }

cd "$SRC_DIR"
before_sha="$(git rev-parse HEAD)"
branch="${DEAL_ONBOARDING_UPDATE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
git fetch --quiet origin
after_sha="$(git rev-parse "origin/$branch")"

if [[ "$before_sha" == "$after_sha" ]]; then
  echo "already up to date (${before_sha:0:12})"
  exit 0
fi

if [[ "${DEAL_ONBOARDING_UPDATE_YES:-0}" != "1" ]]; then
  echo "incoming commits:"
  git --no-pager log --oneline --no-decorate "${before_sha}..${after_sha}"
  printf 'Apply update %s -> %s? (y/N) ' "${before_sha:0:12}" "${after_sha:0:12}"
  read -r answer
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]] || exit 1
fi

git checkout --quiet "$branch"
git pull --ff-only --quiet origin "$branch"
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
