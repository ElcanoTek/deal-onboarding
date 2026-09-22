#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ElcanoTek, Inc.
# scripts/doctor.sh — diagnose a Deal Onboarding box. Read-only unless --repair.
#
#   deal-onboarding doctor                 inspect only (the default)
#   deal-onboarding doctor --check         same, explicit
#   deal-onboarding doctor --json          same report as JSON on stdout
#   sudo deal-onboarding doctor --repair   fix env ownership/mode, create a
#                                          missing data directory, and start an
#                                          inactive deal-onboarding.service
#                                          (caddy only if it is enabled)
#
# Secret values are never printed. Doctor does not pull git, upgrade
# packages, edit Caddy, or reboot. Exit 1 when any check failed, 2 on a
# bad flag. --check together with --repair is refused.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${DEAL_ONBOARDING_APP_DIR:-/opt/deal-onboarding}"
SRC_DIR="${DEAL_ONBOARDING_SRC_DIR:-/opt/deal-onboarding-src}"
ENV_FILE="${DEAL_ONBOARDING_ENV_FILE:-$APP_DIR/.env}"
APP_USER="${DEAL_ONBOARDING_APP_USER:-deal-onboarding}"
SERVICE="${DEAL_ONBOARDING_SERVICE:-deal-onboarding.service}"
UPDATE_CMD="deal-onboarding update"
CADDYFILE="${DEAL_ONBOARDING_CADDYFILE:-/etc/caddy/Caddyfile}"
OS_RELEASE="${DEAL_ONBOARDING_OS_RELEASE:-/etc/os-release}"
FEDORA_FEED="https://fedoraproject.org/releases.json"

if [[ ! -d "$SRC_DIR/.git" && -d "$SCRIPT_DIR/../.git" ]]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

REPAIR=0
JSON=0
CHECK_EXPLICIT=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_EXPLICIT=1 ;;
    --repair) REPAIR=1 ;;
    --json) JSON=1 ;;
    -h|--help)
      cat <<'EOF'
deal-onboarding doctor — read-only box diagnosis (safe repairs only with --repair)

  deal-onboarding doctor            inspect only; change nothing
  deal-onboarding doctor --check    same as the default
  deal-onboarding doctor --json     print {"ok","checks":[{"name","status","detail"}]}
  sudo deal-onboarding doctor --repair
                                    chown/chmod the env file to the service
                                    user mode 600, create a missing data
                                    directory, and start deal-onboarding.service
                                    if it is installed but inactive. Starts
                                    caddy only when that unit is enabled.
                                    Does not pull, upgrade, or reboot.

Exit 1 if any check failed. Warnings leave the exit status 0. Secret
values are never printed. --check with --repair is an error.
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done
if [[ "$REPAIR" == 1 && "$CHECK_EXPLICIT" == 1 ]]; then
  echo "--check and --repair together are not allowed" >&2
  exit 2
fi
if [[ "$REPAIR" == 1 && "$EUID" -ne 0 ]]; then
  echo "run as root: sudo deal-onboarding doctor --repair" >&2
  exit 1
fi
if [[ ! "$APP_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "invalid service user name: $APP_USER" >&2
  exit 2
fi

if [[ -t 1 && "${TERM:-}" != "dumb" && -z "${NO_COLOR:-}" && "$JSON" != 1 ]]; then
  c_reset=$'\033[0m' c_red=$'\033[0;31m' c_green=$'\033[0;32m' c_yellow=$'\033[0;33m'
else
  c_reset='' c_red='' c_green='' c_yellow=''
fi

checks=()
n_pass=0
n_warn=0
n_fail=0
n_fixed=0

add() {
  local status="$1" name="$2" detail="$3"
  detail="${detail//$'\t'/ }"
  detail="${detail//$'\n'/ }"
  detail="${detail//$'\r'/ }"
  checks+=("${status}"$'\t'"${name}"$'\t'"${detail}")
  case "$status" in
    pass) n_pass=$((n_pass + 1)) ;;
    warn) n_warn=$((n_warn + 1)) ;;
    fail) n_fail=$((n_fail + 1)) ;;
    *) echo "internal: bad status $status" >&2; exit 1 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

file_mode() { stat -c '%a' "$1" 2>/dev/null || true; }
file_owner() { stat -c '%U:%G' "$1" 2>/dev/null || true; }

# Refuse to run as root from a script the service user could have written.
assert_root_may_run() {
  [[ $EUID -eq 0 ]] || return 0
  local p owner mode
  for p in "$@"; do
    [[ -e "$p" ]] || continue
    if [[ -L "$p" ]]; then
      echo "doctor: refusing to run symlink $p as root" >&2
      return 1
    fi
    owner="$(stat -c '%U' "$p" 2>/dev/null || echo unknown)"
    mode="$(stat -c '%a' "$p" 2>/dev/null || echo 666)"
    if [[ "$owner" != root || $((8#$mode & 022)) -ne 0 ]]; then
      echo "doctor: refusing to run as root; $p is $owner mode $mode (install the root-owned copy under /usr/local/lib)" >&2
      return 1
    fi
  done
}

# fchown/fchmod the inode opened with O_NOFOLLOW on every path component.
priv_chown() {
  python3 - "$@" <<'PY'
import os, stat, sys, pwd, grp
path, user, group, mode = sys.argv[1:]
if not path.startswith("/") or "\x00" in path:
    raise SystemExit(2)
parts = [p for p in path.split("/") if p]
if not parts or any(p in (".", "..") for p in parts):
    raise SystemExit(2)
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try:
    try:
        for part in parts:
            nxt = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
        st = os.fstat(fd)
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            raise SystemExit(2)
        os.fchown(fd, pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid)
        os.fchmod(fd, int(mode, 8))
    except OSError:
        raise SystemExit(2)
finally:
    try:
        os.close(fd)
    except OSError:
        pass
PY
}

# mkdir the final component with O_NOFOLLOW. install -d follows a symlink
# planted in a service-writable parent and would chown the target.
priv_mkdir() {
  python3 - "$@" <<'PY'
import os, sys, pwd, grp
path, user, group, mode = sys.argv[1:]
if not path.startswith("/") or "\x00" in path:
    raise SystemExit(2)
parts = [p for p in path.split("/") if p]
if len(parts) < 2 or any(p in (".", "..") for p in parts):
    raise SystemExit(2)
fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try:
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
        last = parts[-1]
        os.mkdir(last, 0o700, dir_fd=fd)
        child = os.open(last, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        os.close(fd)
        fd = child
        os.fchown(fd, pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid)
        os.fchmod(fd, int(mode, 8))
    except OSError:
        raise SystemExit(2)
finally:
    try:
        os.close(fd)
    except OSError:
        pass
PY
}

# A data directory taken from an env file may be attacker-controlled.
# Only APP_DIR/data, or an existing directory the service user already owns
# under root-owned parents, may be chowned.
data_dir_claimable() {
  local data="$1" app parent owner mode
  [[ "$data" == /* && "$data" != *..* ]] || return 1
  app="${APP_DIR%/}"
  if [[ "$data" == "$app/data" ]]; then
    [[ -L "$app" || -L "$data" ]] && return 1
    return 0
  fi
  [[ -d "$data" && ! -L "$data" ]] || return 1
  [[ "$(stat -c '%U' "$data" 2>/dev/null || echo "")" == "$APP_USER" ]] || return 1
  parent="$(dirname "$data")"
  while :; do
    [[ -L "$parent" ]] && return 1
    owner="$(stat -c '%U' "$parent" 2>/dev/null || echo "")"
    mode="$(stat -c '%a' "$parent" 2>/dev/null || echo 777)"
    [[ "$owner" == root ]] || return 1
    [[ $((8#$mode & 022)) -eq 0 ]] || return 1
    [[ "$parent" == / ]] && break
    parent="$(dirname "$parent")"
  done
}

# https_host URL prints the hostname, or returns 1. The result is a DNS
# name only, so it can be passed to openssl -servername without becoming a flag.
# Prints "host port". An explicit https port is kept; the default is 443.
https_host() {
  local url="$1" host port=443
  [[ "$url" == https://* ]] || return 1
  host="${url#https://}"
  host="${host%%/*}"
  host="${host%%\?*}"
  host="${host##*@}"
  if [[ "$host" == *:* ]]; then
    port="${host##*:}"
    host="${host%%:*}"
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || return 1
  printf '%s %s\n' "$host" "$port"
}

sane_env_mode() {
  case "$1" in
    600|640|400) return 0 ;;
    *) return 1 ;;
  esac
}

print_report() {
  local row status name detail color label
  if [[ "$JSON" == 1 ]]; then
    if ! have python3; then
      echo "--json needs python3" >&2
      exit 1
    fi
    printf '%s\n' "${checks[@]}" | python3 -c '
import json, sys
checks = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    status, name, detail = line.split("\t", 2)
    checks.append({"name": name, "status": status, "detail": detail})
json.dump({"ok": not any(c["status"] == "fail" for c in checks), "checks": checks}, sys.stdout, indent=2)
sys.stdout.write("\n")
'
    return
  fi
  for row in "${checks[@]}"; do
    status="${row%%$'\t'*}"
    detail="${row#*$'\t'}"
    name="${detail%%$'\t'*}"
    detail="${detail#*$'\t'}"
    case "$status" in
      pass) color="$c_green"; label=PASS ;;
      warn) color="$c_yellow"; label=WARN ;;
      fail) color="$c_red"; label=FAIL ;;
    esac
    printf '%s%s%s  %-16s %s\n' "$color" "$label" "$c_reset" "$name" "$detail"
  done
  printf '\n'
  if [[ "$REPAIR" == 1 ]]; then
    printf 'Doctor: %d pass, %d warn, %d fail (%d repaired).\n' \
      "$n_pass" "$n_warn" "$n_fail" "$n_fixed"
  else
    printf 'Doctor: %d pass, %d warn, %d fail. Read-only; the checkout was not changed.\n' \
      "$n_pass" "$n_warn" "$n_fail"
  fi
}

check_install() {
  if [[ -d "$APP_DIR" && ! -L "$APP_DIR" ]]; then
    add pass install "$APP_DIR present"
  else
    add fail install "$APP_DIR is missing or not a directory — rerun bootstrap"
  fi
}

check_env() {
  local mode owner secret legacy or_key runner_url runner_key
  local -a missing=() notes=()
  if [[ -L "$ENV_FILE" ]]; then
    add fail env-file "$ENV_FILE is a symlink; refusing to read it"
    return
  fi
  if [[ ! -e "$ENV_FILE" ]]; then
    add fail env-file "$ENV_FILE is missing — bootstrap writes it; doctor does not create secrets"
    return
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    add fail env-file "$ENV_FILE is not a regular file"
    return
  fi
  mode="$(file_mode "$ENV_FILE")"
  owner="$(file_owner "$ENV_FILE")"
  if [[ "$owner" == "$APP_USER:$APP_USER" ]] && sane_env_mode "$mode"; then
    add pass env-perms "$ENV_FILE is $owner mode $mode"
  elif [[ "$REPAIR" == 1 ]] && priv_chown "$ENV_FILE" "$APP_USER" "$APP_USER" 600; then
    mode="$(file_mode "$ENV_FILE")"
    owner="$(file_owner "$ENV_FILE")"
    if [[ "$owner" == "$APP_USER:$APP_USER" && "$mode" == "600" ]]; then
      n_fixed=$((n_fixed + 1))
      add pass env-perms "repaired; $ENV_FILE is $owner mode $mode"
    else
      add fail env-perms "repair did not stick on $ENV_FILE (now ${owner:-unknown} mode ${mode:-unknown})"
    fi
  else
    add fail env-perms "$ENV_FILE is ${owner:-unknown} mode ${mode:-unknown}; want $APP_USER:$APP_USER mode 600 (640 and 400 also pass). Fix: sudo chown $APP_USER:$APP_USER $ENV_FILE && sudo chmod 600 $ENV_FILE"
  fi
  if [[ ! -r "$ENV_FILE" ]]; then
    add fail env-keys "cannot read $ENV_FILE; re-run with sudo. Values are not shown either way."
    return
  fi
  # The server accepts the legacy MANIFEST_SESSION_SECRET name, but only
  # the length is checked. The value itself is never printed.
  secret="$(env_get DEAL_ONBOARDING_SESSION_SECRET "$ENV_FILE" 2>/dev/null || true)"
  secret="${secret#"${secret%%[![:space:]]*}"}"
  secret="${secret%"${secret##*[![:space:]]}"}"
  if [[ ${#secret} -lt 32 ]]; then
    legacy="$(env_get MANIFEST_SESSION_SECRET "$ENV_FILE" 2>/dev/null || true)"
    legacy="${legacy#"${legacy%%[![:space:]]*}"}"
    legacy="${legacy%"${legacy##*[![:space:]]}"}"
    if [[ ${#legacy} -ge 32 ]]; then
      notes+=("session secret is still named MANIFEST_SESSION_SECRET; prefer DEAL_ONBOARDING_SESSION_SECRET")
    else
      missing+=("DEAL_ONBOARDING_SESSION_SECRET")
    fi
    unset legacy
  fi
  unset secret
  or_key="$(env_get OPENROUTER_API_KEY "$ENV_FILE" 2>/dev/null || true)"
  if [[ -z "$or_key" ]]; then
    notes+=("OPENROUTER_API_KEY unset, so Parse Deal Data, AI audit, and Deal Assistant stay off")
  fi
  unset or_key
  runner_url="$(env_get RUNNER_BASE_URL "$ENV_FILE" 2>/dev/null || true)"
  runner_key="$(env_get RUNNER_API_KEY "$ENV_FILE" 2>/dev/null || true)"
  if [[ -z "$runner_url" && -z "$runner_key" ]]; then
    notes+=("RUNNER_BASE_URL and RUNNER_API_KEY unset, so submission stays off")
  elif [[ -z "$runner_url" || -z "$runner_key" ]]; then
    missing+=("RUNNER_BASE_URL and RUNNER_API_KEY")
  fi
  unset runner_url runner_key
  if [[ ${#missing[@]} -gt 0 ]]; then
    add fail env-keys "missing or invalid: ${missing[*]} (values not shown)"
  elif [[ ${#notes[@]} -gt 0 ]]; then
    add warn env-keys "${notes[*]}"
  else
    add pass env-keys "required keys set (values not shown)"
  fi
}

check_unit() {
  local name="$1" unit="$2" level="$3"
  local enabled=0
  if ! have systemctl; then
    add warn "$name" "systemctl is not installed; skipped $unit"
    return
  fi
  if ! systemctl cat "$unit" >/dev/null 2>&1; then
    if [[ "$level" == "core" ]]; then
      add fail "$name" "$unit is not installed — rerun bootstrap"
    else
      add warn "$name" "$unit is not installed"
    fi
    return
  fi
  if systemctl is-active --quiet "$unit"; then
    if systemctl is-enabled --quiet "$unit"; then
      add pass "$name" "$unit active and enabled"
    else
      add warn "$name" "$unit is active but not enabled — it will not start on boot"
    fi
    return
  fi
  if systemctl is-enabled --quiet "$unit"; then
    enabled=1
  fi
  if [[ "$REPAIR" == 1 && ( "$level" == "core" || "$enabled" == 1 ) ]]; then
    if systemctl start "$unit" >/dev/null 2>&1 && systemctl is-active --quiet "$unit"; then
      n_fixed=$((n_fixed + 1))
      add pass "$name" "repaired; started $unit"
      return
    fi
  fi
  if [[ "$level" == "core" ]]; then
    add fail "$name" "$unit is not active — sudo systemctl start ${unit%.service}"
  else
    add warn "$name" "$unit is not active — sudo systemctl start ${unit%.service}"
  fi
}

check_health() {
  local port url code bind
  port="$(env_get PORT "$ENV_FILE" 2>/dev/null || true)"
  [[ "$port" =~ ^[0-9]+$ ]] || port=8080
  bind="$(env_get HOST "$ENV_FILE" 2>/dev/null || true)"
  case "$bind" in
    ""|0.0.0.0|"::"|"[::]"|"*") bind=127.0.0.1 ;;
  esac
  # A concrete bracketed IPv6 address (HOST=[::1]) is a valid bind. Only
  # wildcards were rewritten above; do not collapse those brackets to loopback.
  if [[ "$bind" =~ ^\[[0-9A-Fa-f:.]+\]$ ]]; then
    :
  elif [[ ! "$bind" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    bind=127.0.0.1
  fi
  url="http://${bind}:${port}/health"
  code="$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    add pass health "$url returned 200"
  elif [[ -z "$code" || "$code" == "000" ]]; then
    add fail health "$url did not respond — journalctl -u deal-onboarding -n 50"
  else
    add fail health "$url returned HTTP $code — journalctl -u deal-onboarding -n 50"
  fi
}

caddy_hostname() {
  [[ -f "$CADDYFILE" && ! -L "$CADDYFILE" && -r "$CADDYFILE" ]] || return 1
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      name = $1
      sub(/\{$/, "", name)
      sub(/^https:\/\//, "", name)
      sub(/:.*/, "", name)
      if (name ~ /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/) { print name; exit }
    }
  ' "$CADDYFILE"
}

check_tls() {
  local url host line epoch now days tls_port=443
  url="$(env_get DEAL_ONBOARDING_PUBLIC_URL "$ENV_FILE" 2>/dev/null || true)"
  if ! read -r host tls_port < <(https_host "$url"); then
    host="$(caddy_hostname || true)"
    tls_port=443
  fi
  if [[ -z "$host" || "$host" == "localhost" ]]; then
    add warn tls "no public https hostname (set DEAL_ONBOARDING_PUBLIC_URL or a Caddy site); skipped the certificate"
    return
  fi
  if ! have openssl; then
    add fail tls "openssl is missing; cannot read the certificate for $host"
    return
  fi
  # Connect to loopback with the public name as SNI so the check is the
  # certificate Caddy is serving, not DNS or hairpin NAT.
  # -verify_hostname and -verify_return_error make a wrong host or a bad
  # chain a failed handshake, not a certificate we then trust by expiry alone.
  line="$(timeout 15 openssl s_client -verify_hostname "$host" -verify_return_error -servername "$host" -connect "127.0.0.1:${tls_port}" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || true)"
  if [[ "$line" != notAfter=* ]]; then
    add fail tls "no verified certificate from 127.0.0.1:${tls_port} for $host — is Caddy running?"
    return
  fi
  line="${line#notAfter=}"
  epoch="$(date -d "$line" +%s 2>/dev/null || true)"
  now="$(date +%s)"
  if [[ ! "$epoch" =~ ^[0-9]+$ ]]; then
    add fail tls "could not parse the certificate expiry for $host"
    return
  fi
  if [[ "$epoch" -le "$now" ]]; then
    add fail tls "certificate for $host is expired"
    return
  fi
  days="$(( (epoch - now) / 86400 ))"
  if [[ "$days" -lt 0 ]]; then
    add fail tls "certificate for $host is expired"
  elif [[ "$days" -lt 30 ]]; then
    add warn tls "certificate for $host expires in $days day(s)"
  else
    add pass tls "certificate for $host is valid ($days day(s) left)"
  fi
}

check_caddy_config() {
  if ! have caddy; then
    return
  fi
  if [[ ! -f "$CADDYFILE" || -L "$CADDYFILE" ]]; then
    return
  fi
  if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
    add pass caddy-config "Caddyfile valid"
  else
    add fail caddy-config "caddy validate failed for $CADDYFILE"
  fi
}

service_can_write() {
  if [[ $EUID -eq 0 ]]; then
    runuser -u "$APP_USER" -- test -w "$1" && runuser -u "$APP_USER" -- test -x "$1"
    return
  fi
  if [[ "$(id -un)" == "$APP_USER" ]]; then
    [[ -w "$1" && -x "$1" ]]
    return
  fi
  return 2
}

check_data() {
  local data writable=0 owner mode
  data="$(env_get DATA_DIR "$ENV_FILE" 2>/dev/null || true)"
  [[ -n "$data" ]] || data="$APP_DIR/data"
  if [[ "$data" != /* ]]; then
    data="$APP_DIR/${data#./}"
  fi
  while [[ "$data" == */ && "$data" != "/" ]]; do
    data="${data%/}"
  done
  DISK_PATH="$data"
  if [[ -L "$data" || "$data" == *..* ]]; then
    add fail database "refusing $data (symlink or ..); the file store must be a real directory"
    return
  fi
  if [[ ! -d "$data" ]]; then
    if [[ -e "$data" ]]; then
      add fail database "$data exists but is not a directory"
      return
    fi
    # Create only the default directory, and only when every parent is trusted.
    if [[ "$REPAIR" == 1 && "$data" == "${APP_DIR%/}/data" ]] && data_dir_claimable "$data" && priv_mkdir "$data" "$APP_USER" "$APP_USER" 750; then
      n_fixed=$((n_fixed + 1))
      add pass database "repaired; created file store $data"
      return
    fi
    add fail database "$data is missing — sudo install -d -o $APP_USER -g $APP_USER -m 0750 $data"
    return
  fi
  # Read-only: a real directory the service user owns and can write is enough.
  # A nested store under the service-owned app tree is valid. Claimability
  # only decides whether --repair may chown the path.
  if service_can_write "$data"; then
    writable=1
  fi
  owner="$(file_owner "$data")"
  mode="$(file_mode "$data")"
  if [[ "$writable" -eq 1 && "$owner" == "$APP_USER:"* && $((8#${mode:-777} & 2)) -eq 0 ]]; then
    add pass database "file store at $data is writable by $APP_USER (no database server)"
    return
  fi
  if [[ "$REPAIR" == 1 ]] && data_dir_claimable "$data" && priv_chown "$data" "$APP_USER" "$APP_USER" 750; then
    n_fixed=$((n_fixed + 1))
    add pass database "repaired; $data is $APP_USER:$APP_USER mode 750"
    return
  fi
  if ! data_dir_claimable "$data"; then
    add fail database "$data is not a writable $APP_USER directory, and repair will not chown it"
    return
  fi
  add fail database "$data is not writable by $APP_USER ($owner mode $mode)"
}

check_disk() {
  local path="$1" kb
  [[ -d "$path" ]] || path="/"
  kb="$(df -Pk "$path" 2>/dev/null | awk 'END {print $4}')"
  if [[ ! "$kb" =~ ^[0-9]+$ ]]; then
    add fail disk "cannot read free space for $path"
  elif [[ "$kb" -lt 1048576 ]]; then
    add fail disk "less than 1 GiB free on $path"
  elif [[ "$kb" -lt 5242880 ]]; then
    add warn disk "less than 5 GiB free on $path ($(awk -v k="$kb" 'BEGIN {printf "%.1f", k/1048576}') GiB)"
  else
    add pass disk "at least 5 GiB free on $path"
  fi
}

check_updates() {
  local rc=0 pending n
  if ! have dnf; then
    add warn updates "dnf is not installed; skipped package currency"
    return
  fi
  set +e
  pending="$(timeout 25 dnf --setopt='*.skip_if_unavailable=1' -q check-update 2>/dev/null)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    add pass updates "no pending dnf updates"
  elif [[ "$rc" -eq 100 ]]; then
    n="$(printf '%s\n' "$pending" | awk 'NF>=2 && $1 !~ /^(Last|Security)$/ {c++} END {print c+0}')"
    add warn updates "${n} pending dnf update(s); doctor does not upgrade (sudo dnf upgrade)"
  elif [[ "$rc" -eq 124 ]]; then
    add warn updates "dnf check-update timed out; doctor does not upgrade"
  else
    add warn updates "dnf check-update exited $rc; doctor does not upgrade"
  fi
}

# reboot_hint runs a needs-restarting probe. Returns 0 and records the check
# when the command itself worked (exit 0 = no reboot, exit 1 = reboot).
# Returns 1 when the command is missing or failed, so the caller can try
# the next probe. Fedora 44 boxes often have no needs-restarting binary;
# `dnf needs-restarting -r` is the dnf5 plugin, and the kernel list is last.
reboot_hint() {
  local rc=0 out
  set +e
  out="$(timeout 20 "$@" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    add pass reboot "no reboot required"
    return 0
  fi
  if [[ "$rc" -eq 1 ]]; then
    case "$out" in
      *[Uu]nknown*command*|*[Nn]o\ such*|*not\ a\ valid*|*No\ such\ command*|*[Ee]rror:*)
        return 1
        ;;
    esac
    add warn reboot "reboot required to finish updates; doctor does not reboot"
    return 0
  fi
  return 1
}

check_reboot() {
  local line installed running
  if have needs-restarting && reboot_hint needs-restarting -r; then
    return
  fi
  if have dnf && reboot_hint dnf needs-restarting -r; then
    return
  fi
  if have rpm; then
    # Newest installed kernel by install time. `uname -r` is that NVR
    # without the kernel- prefix (pages/scripts/doctor.sh uses the same fact).
    line="$(rpm -q kernel --last 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    if [[ "$line" == kernel-* ]]; then
      installed="${line#kernel-}"
      running="$(uname -r)"
      if [[ "$installed" == "$running" ]]; then
        add pass reboot "running kernel matches the newest installed"
      else
        add warn reboot "reboot pending: running kernel $running, installed $installed"
      fi
      return
    fi
  fi
  if [[ -e /run/reboot-required || -e /var/run/reboot-required ]]; then
    add warn reboot "reboot required (/run/reboot-required); doctor does not reboot"
    return
  fi
  add warn reboot "could not determine whether a reboot is required"
}

check_fedora() {
  local id="" version="" latest
  if [[ ! -r "$OS_RELEASE" ]]; then
    add warn fedora "cannot read $OS_RELEASE"
    return
  fi
  # Assignments only. Do not source the file: a tampered os-release is still
  # the distro's, but doctor should not execute it.
  id="$(awk -F= '$1=="ID"{gsub(/"/,"",$2); print $2; exit}' "$OS_RELEASE")"
  version="$(awk -F= '$1=="VERSION_ID"{gsub(/"/,"",$2); print $2; exit}' "$OS_RELEASE")"
  if [[ "$id" != "fedora" ]]; then
    add warn fedora "this host is ${id:-unknown}, not Fedora; skipped the release comparison"
    return
  fi
  if [[ ! "$version" =~ ^[0-9]+$ ]]; then
    add warn fedora "could not read VERSION_ID from $OS_RELEASE"
    return
  fi
  if ! have python3 || ! have curl; then
    add warn fedora "Fedora $version; cannot compare (need curl and python3). Doctor does not upgrade the OS."
    return
  fi
  latest="$(curl -fsS --connect-timeout 5 --max-time 20 "$FEDORA_FEED" 2>/dev/null | python3 -c 'import json,sys
try:
    rows=json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
nums=[int(r["version"]) for r in rows if str(r.get("version","")).isdigit()]
if not nums:
    raise SystemExit(1)
print(max(nums))' 2>/dev/null || true)"
  if [[ ! "$latest" =~ ^[0-9]+$ ]]; then
    add warn fedora "Fedora $version; could not read the stable release feed. Doctor does not upgrade the OS."
    return
  fi
  if [[ "$version" -eq "$latest" ]]; then
    add pass fedora "Fedora $version is the latest stable release"
  elif [[ "$version" -lt "$latest" ]]; then
    add warn fedora "Fedora $version; latest stable is $latest. Doctor does not upgrade the OS."
  else
    add warn fedora "Fedora $version is newer than the latest stable feed ($latest)"
  fi
}

# Never disable Git's ownership check. A service-owned checkout can set
# core.fsmonitor; running that as root is code execution. Inspect as the owner.
gitc() {
  local owner
  if [[ $EUID -eq 0 ]]; then
    owner="$(stat -c '%U' "$SRC_DIR" 2>/dev/null || true)"
    if [[ -n "$owner" && "$owner" != root ]]; then
      runuser -u "$owner" -- git -C "$SRC_DIR" "$@"
      return
    fi
  fi
  git -C "$SRC_DIR" "$@"
}

# Keep core.sshCommand (deploy key and known_hosts) and only add timeouts.
# GIT_SSH_COMMAND replaces that command entirely, so it must include it.
git_ssh_command() {
  local base
  base="$(gitc config --get core.sshCommand 2>/dev/null || true)"
  base="${base//$'\n'/ }"
  base="${base#"${base%%[![:space:]]*}"}"
  base="${base%"${base##*[![:space:]]}"}"
  [[ -n "$base" ]] || base="ssh"
  case "$base" in
    *BatchMode*) ;;
    *) base="$base -o BatchMode=yes" ;;
  esac
  case "$base" in
    *ConnectTimeout*) ;;
    *) base="$base -o ConnectTimeout=5" ;;
  esac
  printf '%s' "$base"
}

gitc_timeout() {
  local secs="$1"
  shift
  local owner
  if [[ $EUID -eq 0 ]]; then
    owner="$(stat -c '%U' "$SRC_DIR" 2>/dev/null || true)"
    if [[ -n "$owner" && "$owner" != root ]]; then
      if [[ -n "${GIT_SSH_COMMAND:-}" ]]; then
        timeout "$secs" runuser -u "$owner" -- env \
          "GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-0}" \
          "GIT_SSH_COMMAND=${GIT_SSH_COMMAND}" \
          git -C "$SRC_DIR" "$@"
      else
        timeout "$secs" runuser -u "$owner" -- git -C "$SRC_DIR" "$@"
      fi
      return
    fi
  fi
  timeout "$secs" git -C "$SRC_DIR" "$@"
}

check_git() {
  local dirty branch counts behind ahead fetch_rc dirty_rc remote_sha head_sha
  if [[ ! -d "$SRC_DIR/.git" ]]; then
    add warn git-clean "no git checkout at $SRC_DIR (deal-onboarding update needs it)"
    add warn git-branch "no git checkout at $SRC_DIR"
    add warn git-upstream "no git checkout at $SRC_DIR; doctor does not fetch or pull"
    return
  fi
  dirty_rc=0
  dirty="$(gitc status --porcelain 2>/dev/null)" || dirty_rc=$?
  if [[ "$dirty_rc" -ne 0 ]]; then
    add warn git-clean "cannot inspect $SRC_DIR (git status exited $dirty_rc)"
  elif [[ -n "$dirty" ]]; then
    add warn git-clean "checkout at $SRC_DIR is dirty; deal-onboarding update will refuse"
  else
    add pass git-clean "clean at $SRC_DIR"
  fi
  branch="$(gitc rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$branch" == "main" ]]; then
    add pass git-branch "on main"
  elif [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    add warn git-branch "on $branch, not main"
  else
    add warn git-branch "detached HEAD at $SRC_DIR, not main"
  fi
  # ls-remote does not write FETCH_HEAD or remote-tracking refs, so --check
  # cannot change the checkout. A missing object locally still reports drift.
  fetch_rc=0
  remote_sha="$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$(git_ssh_command)" gitc_timeout 10 ls-remote origin refs/heads/main 2>/dev/null)" || fetch_rc=$?
  remote_sha="${remote_sha%%$'\t'*}"
  remote_sha="${remote_sha%% *}"
  if [[ "$fetch_rc" -ne 0 || ! "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
    add warn git-upstream "could not reach origin"
    return
  fi
  head_sha="$(gitc rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head_sha" == "$remote_sha" ]]; then
    add pass git-upstream "level with origin/main"
    return
  fi
  if ! gitc cat-file -e "${remote_sha}^{commit}" >/dev/null 2>&1; then
    add warn git-upstream "not at origin/main (${remote_sha:0:12}); $UPDATE_CMD"
    return
  fi
  counts="$(gitc rev-list --left-right --count "${remote_sha}...HEAD" 2>/dev/null || true)"
  counts="${counts//$'\t'/ }"
  # shellcheck disable=SC2086
  read -r behind ahead <<<"$counts"
  if [[ ! "$behind" =~ ^[0-9]+$ || ! "$ahead" =~ ^[0-9]+$ ]]; then
    add warn git-upstream "could not reach origin"
    return
  fi
  if [[ "$behind" -eq 0 && "$ahead" -eq 0 ]]; then
    add pass git-upstream "level with origin/main"
  elif [[ "$behind" -gt 0 && "$ahead" -eq 0 ]]; then
    if [[ "$behind" -eq 1 ]]; then
      add warn git-upstream "1 commit behind — $UPDATE_CMD"
    else
      add warn git-upstream "$behind commits behind — $UPDATE_CMD"
    fi
  elif [[ "$ahead" -gt 0 && "$behind" -eq 0 ]]; then
    add warn git-upstream "$ahead commits ahead of origin/main"
  else
    add warn git-upstream "diverged from origin/main ($behind behind, $ahead ahead)"
  fi
}

assert_root_may_run "${BASH_SOURCE[0]}" "$SCRIPT_DIR/lib/envfile.sh" || exit 1
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/envfile.sh"

check_install
check_env
check_data
check_unit service "$SERVICE" core
check_unit caddy caddy.service optional
check_health
check_tls
check_caddy_config
check_disk "${DISK_PATH:-$APP_DIR}"
check_updates
check_reboot
check_fedora
check_git
print_report
exit "$(( n_fail > 0 ))"
