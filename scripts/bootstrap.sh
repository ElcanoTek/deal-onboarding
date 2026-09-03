#!/usr/bin/env bash
# Deal Onboarding — single-host bootstrap for a fresh Fedora/RHEL-family box.
# Safe to re-run: existing secrets, users, and data are preserved.
set -euo pipefail

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
APP_DIR="${APP_DIR:-/opt/deal-onboarding}"
APP_USER="${APP_USER:-deal-onboarding}"
CLI_PATH="/usr/local/bin/deal-onboarding"
NON_INTERACTIVE="${DEAL_ONBOARDING_BOOTSTRAP_NON_INTERACTIVE:-0}"

if [[ ! -t 0 && "$NON_INTERACTIVE" != "1" ]]; then
  exec </dev/tty
fi

say() { printf '%s\n' "$*"; }
info() { printf '» %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

prompt() {
  local envvar="$1" label="$2" default="${3:-}" answer=""
  if [[ -n "${!envvar:-}" ]]; then
    printf '%s' "${!envvar}"
    return
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    printf '%s' "$default"
    return
  fi
  if [[ -n "$default" ]]; then
    printf '? %s [%s]: ' "$label" "$default" >&2
  else
    printf '? %s: ' "$label" >&2
  fi
  read -r answer
  [[ -z "$answer" ]] && answer="$default"
  printf '%s' "$answer"
}

confirm() {
  local envvar="$1" label="$2" default="${3:-y}" answer=""
  if [[ -n "${!envvar:-}" ]]; then
    answer="${!envvar}"
  elif [[ "$NON_INTERACTIVE" == "1" ]]; then
    answer="$default"
  else
    local hint="y/N"
    [[ "$default" == "y" ]] && hint="Y/n"
    printf '? %s (%s) ' "$label" "$hint" >&2
    read -r answer
    answer="${answer:-$default}"
  fi
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" || "${answer,,}" == "1" || "${answer,,}" == "true" ]]
}

gen_secret() { openssl rand -hex 32; }

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

env_value() { awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$2" 2>/dev/null | tail -n1 || true; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $SRC_DIR/scripts/bootstrap.sh"
[[ -f "$SRC_DIR/go.mod" ]] || die "bootstrap must run from the deal-onboarding repo"

say "Deal Onboarding bootstrap"
say "Safe to re-run: existing secrets and data are preserved."

step "Installing system dependencies"
dnf install -y git curl jq golang nodejs npm openssl rsync >/dev/null

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_USER"
fi

step "Syncing app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude '/.git' --exclude '/data' --exclude '/.env' "$SRC_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"

PRIVATE_LISTS_SOURCE="$(trim "$(prompt DEAL_ONBOARDING_BOOTSTRAP_PRIVATE_LISTS_DIR 'Private standard-list source directory (blank to skip)' '')")"
if [[ -n "$PRIVATE_LISTS_SOURCE" ]]; then
  "$APP_DIR/scripts/provision-private-lists.sh" "$PRIVATE_LISTS_SOURCE" "$APP_DIR/data"
fi

step "Configuring environment"
info "What hostname will people open in their browser?"
info "Examples: 'localhost' for local-only access, or 'deals.example.com' for a real DNS name."
info "Enter just the host name, not 'https://' and not a path."
HOSTNAME_ANSWER="$(prompt DEAL_ONBOARDING_BOOTSTRAP_HOSTNAME 'Hostname' 'localhost')"
SETUP_CADDY="n"
USE_LETSENCRYPT="n"
if [[ "$HOSTNAME_ANSWER" != "localhost" ]] && confirm DEAL_ONBOARDING_BOOTSTRAP_SETUP_CADDY 'Set up Caddy with HTTPS?' y; then
  SETUP_CADDY="y"
  if confirm DEAL_ONBOARDING_BOOTSTRAP_USE_LETSENCRYPT "Use Let's Encrypt certificates?" y; then
    USE_LETSENCRYPT="y"
  fi
fi

ENV_FILE="$APP_DIR/.env"
SESSION_SECRET="$(env_value DEAL_ONBOARDING_SESSION_SECRET "$ENV_FILE")"
[[ -z "$SESSION_SECRET" ]] && SESSION_SECRET="$(env_value MANIFEST_SESSION_SECRET "$ENV_FILE")"
[[ -z "$SESSION_SECRET" ]] && SESSION_SECRET="$(gen_secret)"

info "Operator identity — fills the Curator slot of every deal name and the campaign-id format."
ORG_NAME_ANSWER="$(trim "$(prompt DEAL_ONBOARDING_BOOTSTRAP_ORG_NAME 'Organization name (deal-name curator slot)' "$(env_value ORG_NAME "$ENV_FILE")")")"
[[ -n "$ORG_NAME_ANSWER" ]] || ORG_NAME_ANSWER="Curator"
PREFIX_ANSWER="$(trim "$(prompt DEAL_ONBOARDING_BOOTSTRAP_CAMPAIGN_PREFIX 'Campaign-id prefix (uppercase, e.g. DEAL)' "$(env_value CAMPAIGN_ID_PREFIX "$ENV_FILE")")")"
[[ -n "$PREFIX_ANSWER" ]] || PREFIX_ANSWER="DEAL"

EXISTING_OPENROUTER_KEY="$(env_value OPENROUTER_API_KEY "$ENV_FILE")"
info "OpenRouter powers 'Parse Deal Data', the AI audit, and the Deal Assistant."
info "Get a key at https://openrouter.ai/keys — leave blank to skip and disable those features."
if [[ -n "$EXISTING_OPENROUTER_KEY" ]]; then
  info "An OpenRouter key is already saved. Press enter to keep it, or paste a new one to replace."
  OPENROUTER_KEY_ANSWER="$(prompt DEAL_ONBOARDING_BOOTSTRAP_OPENROUTER_KEY 'OpenRouter API key' "$EXISTING_OPENROUTER_KEY")"
else
  OPENROUTER_KEY_ANSWER="$(prompt DEAL_ONBOARDING_BOOTSTRAP_OPENROUTER_KEY 'OpenRouter API key' '')"
fi
OPENROUTER_KEY_ANSWER="$(trim "$OPENROUTER_KEY_ANSWER")"

# Preserve any runner configuration an operator already added by hand.
RUNNER_BLOCK=""
if [[ -f "$ENV_FILE" ]]; then
  RUNNER_BLOCK="$(grep -E '^(RUNNER_|OPENROUTER_(MODEL|AUDIT_MODEL|CHAT_EDIT_MODEL|IMPORT_MODEL)=|DEFAULT_ATTRIBUTION_CODE=)' "$ENV_FILE" || true)"
fi

cat > "$ENV_FILE" <<EOT
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP_DIR/data
FRONTEND_DIST_DIR=$APP_DIR/frontend/dist
CORS_ORIGINS=http://localhost:5173,http://localhost:4173
ORG_NAME=$ORG_NAME_ANSWER
CAMPAIGN_ID_PREFIX=$PREFIX_ANSWER
DEAL_ONBOARDING_USER_STORE=$APP_DIR/data/users.json
DEAL_ONBOARDING_SESSION_SECRET=$SESSION_SECRET
OPENROUTER_API_KEY=$OPENROUTER_KEY_ANSWER
EOT
if [[ -n "$RUNNER_BLOCK" ]]; then
  printf '\n# Preserved from the previous .env\n%s\n' "$RUNNER_BLOCK" >> "$ENV_FILE"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [[ -z "$OPENROUTER_KEY_ANSWER" ]]; then
  say "  (no OpenRouter key — LLM features return 503 until one is added)"
fi

step "Building Deal Onboarding"
mkdir -p "$APP_DIR/bin"
(cd "$APP_DIR/frontend" && npm install --no-audit --no-fund --loglevel=warn && npm run build)
(cd "$APP_DIR" && go build -o bin/deal-onboarding ./cmd/server && go build -o bin/deal-onboarding-admin ./cmd/deal-onboarding-admin)
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Installing service + CLI"
install -m 0644 "$APP_DIR/deploy/deal-onboarding.service" /etc/systemd/system/deal-onboarding.service
install -m 0755 "$APP_DIR/deploy/deal-onboarding-cli" "$CLI_PATH"
systemctl daemon-reload
systemctl enable --now deal-onboarding.service

step "Provisioning initial users"
INITIAL_USERS="$(prompt DEAL_ONBOARDING_BOOTSTRAP_USERS 'Comma-separated login emails' '')"
SUMMARY=()
if [[ -n "$INITIAL_USERS" ]]; then
  IFS=',' read -r -a USERS <<< "$INITIAL_USERS"
  for raw_email in "${USERS[@]}"; do
    email="$(trim "$raw_email")"
    [[ -z "$email" ]] && continue
    if out="$(sudo -u "$APP_USER" "$APP_DIR/bin/deal-onboarding-admin" user add "$email" --user-store "$APP_DIR/data/users.json" 2>&1)"; then
      printf '%s\n' "$out"
    elif [[ "$out" == *"user already exists"* ]]; then
      say "- user already exists: $email (leaving as-is)"
      continue
    else
      printf '%s\n' "$out"
      continue
    fi
    password="$(printf '%s\n' "$out" | awk '/^  password: /{print $2}')"
    [[ -n "$password" ]] && SUMMARY+=("$email|$password")
  done
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

step "Optional Caddy"
if [[ "$SETUP_CADDY" == "y" ]]; then
  dnf install -y caddy >/dev/null
  cat > /etc/caddy/Caddyfile <<EOT
$HOSTNAME_ANSWER {
	$( [[ "$USE_LETSENCRYPT" == "y" ]] || printf 'tls internal\n\t' )reverse_proxy 127.0.0.1:8080 {
		transport http {
			read_timeout 5m
			write_timeout 5m
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
EOT
  systemctl enable --now caddy
  if command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    firewall-cmd --reload
  fi
else
  say "Skipping Caddy. Reach the app at http://$HOSTNAME_ANSWER:8080"
fi

say
say "Deal Onboarding installed."
if [[ "$SETUP_CADDY" == "y" ]]; then
  say "  URL: https://$HOSTNAME_ANSWER"
else
  say "  URL: http://$HOSTNAME_ANSWER:8080"
fi
say "  Logs: deal-onboarding logs"
say "  CLI:  deal-onboarding user add ... | deal-onboarding restart | deal-onboarding update"
say "  Next: set RUNNER_BASE_URL / RUNNER_API_KEY in $ENV_FILE to enable booking (deal-onboarding env edit)."
say "  Back up $APP_DIR/data on your own schedule — it holds users, uploads, and audit logs."

if [[ ${#SUMMARY[@]} -gt 0 ]]; then
  say
  say "Share these one-time passwords now:"
  printf '  %-40s  %s\n' 'EMAIL' 'PASSWORD'
  for row in "${SUMMARY[@]}"; do
    IFS='|' read -r email password <<< "$row"
    printf '  %-40s  %s\n' "$email" "$password"
  done
fi
