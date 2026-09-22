#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ElcanoTek, Inc.
# scripts/test/doctor_test.sh — deal-onboarding doctor, no root and no host mutation.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${TMPDIR:-/tmp}"
avail="$(df -Pk "$ROOT" | awk 'END {print $4}')"
if [[ ! "$avail" =~ ^[0-9]+$ || "$avail" -lt 1048576 ]]; then
  ROOT="$HOME"
fi
TMP="$(mktemp -d "$ROOT/deal-onboarding-doctor.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

SECRET='SUPER_SECRET_SENTINEL_VALUE_1234567890'
ORKEY='sk-or-v1-DO_NOT_PRINT_THIS_OPENROUTER_KEY'
RUNKEY='runner-key-DO_NOT_PRINT'
APP_USER="$(id -un)"
BIN="$TMP/bin"
APP="$TMP/app"
SRC="$TMP/src"
LOG="$TMP/systemctl.log"
mkdir -p "$BIN" "$APP/data" "$SRC"
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *fetch* ]]; then
  echo "git fetch is not allowed during doctor --check" >&2
  exit 99
fi
exec /usr/bin/git "$@"
EOF
chmod 755 "$BIN/git"

git -C "$SRC" init -q -b main
git -C "$SRC" config user.email t@example.com
git -C "$SRC" config user.name t
printf 'hi\n' > "$SRC/README"
git -C "$SRC" add README
git -C "$SRC" commit -q -m init
git init -q --bare "$TMP/origin.git"
git -C "$SRC" remote add origin "$TMP/origin.git"
git -C "$SRC" push -q origin main

write_env() {
  cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP/data
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
OPENROUTER_API_KEY=$ORKEY
RUNNER_BASE_URL=https://fleet.example.com
RUNNER_API_KEY=$RUNKEY
EOF
  chmod 600 "$APP/.env"
  if getent group "$APP_USER" >/dev/null 2>&1; then
    chgrp "$APP_USER" "$APP/.env" 2>/dev/null || true
  fi
}
write_env

cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
unit=""
for a in "$@"; do
  case "$a" in
    *.service|*.target|*.timer) unit="$a" ;;
  esac
done
case "$1" in
  start)
    printf '%s\n' "$unit" >> "${DOCTOR_STUB_LOG:?}"
    exit 0
    ;;
  cat|is-active|is-enabled)
    [[ "$unit" == "deal-onboarding.service" ]]
    ;;
  *) exit 1 ;;
esac
EOF

cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *releases.json*)
    printf '%s\n' '[{"version":"44"},{"version":"45 Beta"},{"version":"43"}]'
    ;;
  *)
    printf '200'
    ;;
esac
EOF

cat > "$BIN/dnf" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$BIN/needs-restarting" <<'EOF'
#!/usr/bin/env bash
# Shadow a host binary. 127 means "unusable", so doctor falls through to dnf.
exit 127
EOF

cat > "$BIN/openssl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *x509* ]]; then
  date -u -d '+90 days' '+notAfter=%b %e %H:%M:%S %Y GMT'
  exit 0
fi
[[ "$*" == *-verify_hostname* && "$*" == *-verify_return_error* ]] || exit 1
exit 0
EOF

chmod 755 "$BIN"/*

cat > "$TMP/os-release" <<'EOF'
ID=fedora
VERSION_ID=44
EOF

export PATH="$BIN:/usr/sbin:/usr/bin:/sbin:/bin"
export DOCTOR_STUB_LOG="$LOG"
export DEAL_ONBOARDING_APP_DIR="$APP"
export DEAL_ONBOARDING_SRC_DIR="$SRC"
export DEAL_ONBOARDING_ENV_FILE="$APP/.env"
export DEAL_ONBOARDING_APP_USER="$APP_USER"
export DEAL_ONBOARDING_OS_RELEASE="$TMP/os-release"

doctor() { bash "$REPO/scripts/doctor.sh" "$@"; }

assert_clean() {
  local out="$1"
  if [[ "$out" == *"$SECRET"* || "$out" == *"$ORKEY"* || "$out" == *"$RUNKEY"* ]]; then
    printf 'secret value leaked:\n%s\n' "$out" >&2
    exit 1
  fi
}

echo "== help"
help_out="$(doctor --help)"
[[ "$help_out" == *"read-only"* && "$help_out" == *"--repair"* && "$help_out" == *"--json"* ]]

echo "== bad flags"
set +e
doctor --nope >/dev/null 2>"$TMP/bad.err"
rc=$?
set -e
[[ "$rc" -eq 2 ]]
set +e
doctor --check --repair >/dev/null 2>"$TMP/both.err"
rc=$?
set -e
[[ "$rc" -eq 2 ]]
[[ "$(cat "$TMP/both.err")" == *"not allowed"* ]]

echo "== happy path"
out="$(doctor --check --json)"
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
assert doc["ok"] is True, doc
want = {
    "install": "pass",
    "env-perms": "pass",
    "env-keys": "pass",
    "service": "pass",
    "caddy": "warn",
    "health": "pass",
    "tls": "pass",
    "database": "pass",
    "updates": "pass",
    "reboot": "pass",
    "fedora": "pass",
    "git-clean": "pass",
    "git-branch": "pass",
    "git-upstream": "pass",
}
got = {c["name"]: c["status"] for c in doc["checks"]}
for name, status in want.items():
    if got.get(name) != status:
        raise SystemExit(f"{name}: want {status}, got {got.get(name)!r}\n{doc}")
disk = got.get("disk")
if disk not in ("pass", "warn"):
    raise SystemExit(f"disk: {disk}")
PY
[[ ! -s "$LOG" ]]

echo "== cli dispatch"
cli_out="$(APP_DIR="$REPO" bash "$REPO/deploy/deal-onboarding-cli" doctor --help)"
[[ "$cli_out" == *"read-only"* ]]

if [[ "$EUID" -ne 0 ]]; then
  echo "== repair refused when not root"
  chmod 644 "$APP/.env"
  set +e
  doctor --repair --json >"$TMP/repair.out" 2>"$TMP/repair.err"
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
  [[ "$(cat "$TMP/repair.err")" == *"sudo deal-onboarding doctor --repair"* ]]
  [[ "$(stat -c '%a' "$APP/.env")" == "644" ]]
  [[ ! -s "$LOG" ]]
  assert_clean "$(cat "$TMP/repair.out" "$TMP/repair.err")"
  chmod 600 "$APP/.env"
else
  echo "== repair refusal skipped (already root)"
fi

echo "== symlink env is not read"
printf 'DEAL_ONBOARDING_SESSION_SECRET=%s\n' "$SECRET" > "$TMP/real.env"
ln -s "$TMP/real.env" "$TMP/link.env"
set +e
out="$(DEAL_ONBOARDING_ENV_FILE="$TMP/link.env" doctor --json)"
set -e
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
env = next(c for c in doc["checks"] if c["name"] == "env-file")
assert env["status"] == "fail", env
assert "symlink" in env["detail"]
PY

echo "== missing session secret fails without echoing it"
cat > "$APP/.env" <<EOF
PORT=8080
DATA_DIR=$APP/data
DEAL_ONBOARDING_SESSION_SECRET=short
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
set +e
out="$(doctor --json)"
rc=$?
set -e
[[ "$rc" -eq 1 ]]
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
assert doc["ok"] is False
keys = next(c for c in doc["checks"] if c["name"] == "env-keys")
assert keys["status"] == "fail"
assert "DEAL_ONBOARDING_SESSION_SECRET" in keys["detail"]
assert "short" not in keys["detail"]
PY

echo "== dirty checkout is a warning, not a pull"
write_env
printf 'x\n' > "$SRC/dirty"
out="$(doctor --json)" || true
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
git = next(c for c in doc["checks"] if c["name"] == "git-clean")
assert git["status"] == "warn", git
assert "dirty" in git["detail"]
PY

echo "== install.sh --help"
install_help="$(bash "$REPO/install.sh" --help)"
[[ "$install_help" == *"/opt/deal-onboarding-src"* ]]
set +e
bash "$REPO/install.sh" --nope >/dev/null 2>"$TMP/install.err"
rc=$?
set -e
[[ "$rc" -eq 2 ]]
set +e
bash "$REPO/install.sh" >/dev/null 2>"$TMP/install-root.err"
rc=$?
set -e
[[ "$rc" -eq 1 ]]
[[ "$(cat "$TMP/install-root.err")" == *"sudo"* ]]

echo "== fetch reports commits behind origin"
git -C "$TMP/origin.git" symbolic-ref HEAD refs/heads/main
git clone -q "$TMP/origin.git" "$TMP/ahead"
git -C "$TMP/ahead" config user.email t@example.com
git -C "$TMP/ahead" config user.name t
git -C "$TMP/ahead" commit -q --allow-empty -m newer
git -C "$TMP/ahead" push -q origin main
out="$(doctor --json)" || true
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
git = next(c for c in doc["checks"] if c["name"] == "git-upstream")
assert git["status"] == "warn", git
assert git["detail"].startswith("not at origin/main"), git
assert "deal-onboarding update" in git["detail"]
PY
[[ ! -e "$SRC/.git/FETCH_HEAD" ]]

echo "== reboot falls back to the installed kernel"
cat > "$BIN/dnf" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "needs-restarting" ]]; then
  exit 2
fi
exit 0
EOF
cat > "$BIN/rpm" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"--last"* ]]; then
  printf 'kernel-9.9.9-test.fc44.x86_64 Mon Jan 1 00:00:00 2026\n'
  exit 0
fi
exit 1
EOF
chmod 755 "$BIN/dnf" "$BIN/rpm"
out="$(doctor --json)" || true
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
reboot = next(c for c in doc["checks"] if c["name"] == "reboot")
assert reboot["status"] == "warn" and "9.9.9-test.fc44.x86_64" in reboot["detail"], reboot
PY

echo "== repairs run before units, and --check does not fetch"
awk '
  /^check_data$/ { if (!d) d = NR }
  /^check_unit / { if (!u) u = NR }
  END { exit !(d && u && d < u) }
' "$REPO/scripts/doctor.sh"
if grep -q 'safe\.directory' "$REPO/scripts/doctor.sh"; then
  echo "doctor must not set safe.directory" >&2
  exit 1
fi
if grep -q 'git fetch' "$REPO/scripts/doctor.sh"; then
  echo "doctor --check must not git fetch" >&2
  exit 1
fi
grep -q 'ls-remote' "$REPO/scripts/doctor.sh"
grep -q -- '-verify_hostname' "$REPO/scripts/doctor.sh"

echo "== padded short secret fails after trim"
cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP/data
DEAL_ONBOARDING_SESSION_SECRET=$(printf '%32s' short)
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
set +e
out="$(doctor --json)"
rc=$?
set -e
[[ "$rc" -eq 1 ]]
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
keys = next(c for c in doc["checks"] if c["name"] == "env-keys")
assert keys["status"] == "fail" and "DEAL_ONBOARDING_SESSION_SECRET" in keys["detail"], keys
assert "short" not in keys["detail"]
PY

echo "== legacy secret is trimmed before the length check"
cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP/data
MANIFEST_SESSION_SECRET=  $SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
out="$(doctor --json)" || true
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
keys = next(c for c in doc["checks"] if c["name"] == "env-keys")
assert keys["status"] == "warn" and "MANIFEST_SESSION_SECRET" in keys["detail"], keys
PY

echo "== DATA_DIR /etc is refused and disk uses that path"
cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=/etc
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
set +e
out="$(doctor --json)"
rc=$?
set -e
[[ "$rc" -eq 1 ]]
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
db = next(c for c in doc["checks"] if c["name"] == "database")
disk = next(c for c in doc["checks"] if c["name"] == "disk")
assert db["status"] == "fail" and "/etc" in db["detail"], db
assert "/etc" in disk["detail"], disk
PY

echo "== nested data dir under the service tree is accepted"
mkdir -p "$APP/data/prod"
chmod 750 "$APP/data/prod"
cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP/data/prod
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
out="$(doctor --json)" || true
assert_clean "$out"
python3 - "$out" "$APP/data/prod" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
want = sys.argv[2]
db = next(c for c in doc["checks"] if c["name"] == "database")
assert db["status"] == "pass" and want in db["detail"], db
PY

echo "== trailing slash on the default data dir is the same directory"
cat > "$APP/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATA_DIR=$APP/data/
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
out="$(doctor --json)" || true
python3 - "$out" "$APP/data" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
want = sys.argv[2]
db = next(c for c in doc["checks"] if c["name"] == "database")
assert db["status"] == "pass" and want in db["detail"] and f"{want}/" not in db["detail"], db
PY

echo "== health uses a concrete HOST"
cat > "$APP/.env" <<EOF
HOST=10.1.2.3
PORT=8080
DATA_DIR=$APP/data
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com:8443
EOF
chmod 600 "$APP/.env"
export DOCTOR_OPENSSL_LOG="$TMP/openssl.log"
: > "$DOCTOR_OPENSSL_LOG"
cat > "$BIN/openssl" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${DOCTOR_OPENSSL_LOG:-}" ]]; then
  printf '%s\n' "$*" >> "$DOCTOR_OPENSSL_LOG"
fi
if [[ "$*" == *x509* ]]; then
  date -u -d '1 hour ago' '+notAfter=%b %e %H:%M:%S %Y GMT'
  exit 0
fi
[[ "$*" == *-verify_hostname* && "$*" == *-verify_return_error* ]] || exit 1
exit 0
EOF
chmod 755 "$BIN/openssl"
set +e
out="$(doctor --json)"
rc=$?
set -e
[[ "$rc" -eq 1 ]]
assert_clean "$out"
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
health = next(c for c in doc["checks"] if c["name"] == "health")
tls = next(c for c in doc["checks"] if c["name"] == "tls")
assert "http://10.1.2.3:8080/health" in health["detail"], health
assert tls["status"] == "fail" and "expired" in tls["detail"], tls
PY
[[ "$(cat "$DOCTOR_OPENSSL_LOG")" == *"-connect 127.0.0.1:8443"* ]]
[[ "$(cat "$DOCTOR_OPENSSL_LOG")" == *"-verify_hostname deals.example.com"* ]]

echo "== bracketed IPv6 bind is probed as written"
cat > "$APP/.env" <<EOF
HOST=[::1]
PORT=8080
DATA_DIR=$APP/data
DEAL_ONBOARDING_SESSION_SECRET=$SECRET
DEAL_ONBOARDING_PUBLIC_URL=https://deals.example.com
EOF
chmod 600 "$APP/.env"
out="$(doctor --json)" || true
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
health = next(c for c in doc["checks"] if c["name"] == "health")
assert "http://[::1]:8080/health" in health["detail"], health
PY

echo "== active but disabled unit is a warning"
cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
unit=""
for a in "$@"; do
  case "$a" in
    *.service|*.target|*.timer) unit="$a" ;;
  esac
done
case "$1" in
  is-active) [[ "$unit" == "deal-onboarding.service" ]] ;;
  is-enabled) exit 1 ;;
  cat) [[ "$unit" == "deal-onboarding.service" ]] ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$BIN/systemctl"
out="$(doctor --json)" || true
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
svc = next(c for c in doc["checks"] if c["name"] == "service")
assert svc["status"] == "warn" and "not enabled" in svc["detail"], svc
PY

echo "== git status failure is not a clean tree"
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  [[ "$a" == fetch ]] && exit 99
  [[ "$a" == status ]] && exit 7
done
exec /usr/bin/git "$@"
EOF
chmod 755 "$BIN/git"
out="$(doctor --json)" || true
python3 - "$out" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
git = next(c for c in doc["checks"] if c["name"] == "git-clean")
assert git["status"] == "warn" and "cannot inspect" in git["detail"], git
PY

echo "== chown and mkdir do not follow symlinks"
# shellcheck disable=SC1090
eval "$(sed -n '/^priv_chown()/,/^}/p' "$REPO/scripts/doctor.sh")"
# shellcheck disable=SC1090
eval "$(sed -n '/^priv_mkdir()/,/^}/p' "$REPO/scripts/doctor.sh")"
printf 'x\n' > "$TMP/chown-target"
chmod 600 "$TMP/chown-target"
ln -s "$TMP/chown-target" "$TMP/chown-link"
set +e
priv_chown "$TMP/chown-link" "$APP_USER" "$(id -gn)" 640
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ "$(stat -c '%a' "$TMP/chown-target")" == 600 ]]
printf 'owned\n' > "$TMP/chown-file"
chmod 644 "$TMP/chown-file"
priv_chown "$TMP/chown-file" "$APP_USER" "$(id -gn)" 600
[[ "$(stat -c '%a' "$TMP/chown-file")" == 600 ]]
mkdir -p "$TMP/real-parent"
ln -s "$TMP/real-parent" "$TMP/link-parent"
set +e
priv_mkdir "$TMP/link-parent/newdir" "$APP_USER" "$(id -gn)" 750
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ ! -e "$TMP/real-parent/newdir" ]]
priv_mkdir "$TMP/real-parent/newdir" "$APP_USER" "$(id -gn)" 750
[[ -d "$TMP/real-parent/newdir" && ! -L "$TMP/real-parent/newdir" ]]
[[ "$(stat -c '%a' "$TMP/real-parent/newdir")" == 750 ]]

echo "== installer replaces a symlink and refuses a symlink source"
# shellcheck disable=SC1090
eval "$(sed -n '/^install_root_script()/,/^}/p' "$REPO/scripts/bootstrap.sh")"
printf '#!/bin/sh\necho installed\n' > "$TMP/cli-src"
chmod 755 "$TMP/cli-src"
ln -s "$TMP/cli-src" "$TMP/cli-link"
mkdir -p "$TMP/prefix/bin"
set +e
install_root_script "$TMP/cli-link" "$TMP/prefix/bin/deal-onboarding"
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ ! -e "$TMP/prefix/bin/deal-onboarding" ]]
printf 'original\n' > "$TMP/prefix/bin/original"
ln -s "$TMP/prefix/bin/original" "$TMP/prefix/bin/deal-onboarding"
install_root_script "$TMP/cli-src" "$TMP/prefix/bin/deal-onboarding"
[[ ! -L "$TMP/prefix/bin/deal-onboarding" ]]
[[ "$(cat "$TMP/prefix/bin/deal-onboarding")" == *"installed"* ]]
[[ "$(cat "$TMP/prefix/bin/original")" == original ]]
mkdir -p "$TMP/prefix/bin/realdir"
ln -sfn "$TMP/prefix/bin/realdir" "$TMP/prefix/bin/deal-onboarding"
install_root_script "$TMP/cli-src" "$TMP/prefix/bin/deal-onboarding"
[[ ! -L "$TMP/prefix/bin/deal-onboarding" && -f "$TMP/prefix/bin/deal-onboarding" ]]
[[ -z "$(find "$TMP/prefix/bin/realdir" -name '.install.*' -print -quit)" ]]

echo "== cli does not execute a service-writable doctor"
doctor_src="$REPO/scripts/doctor.sh"
saved_mode="$(stat -c '%a' "$doctor_src")"
chmod a+w "$doctor_src"
mkdir -p "$TMP/sudo-bin"
cat > "$TMP/sudo-bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "sudo should not run" >&2
exit 99
EOF
chmod 755 "$TMP/sudo-bin/sudo"
set +e
cli_out="$(PATH="$TMP/sudo-bin:/usr/bin:/bin" APP_DIR="$REPO" bash "$REPO/deploy/deal-onboarding-cli" doctor --check 2>&1)"
rc=$?
help_out="$(PATH="$TMP/sudo-bin:/usr/bin:/bin" APP_DIR="$REPO" bash "$REPO/deploy/deal-onboarding-cli" doctor --help 2>&1)"
help_rc=$?
set -e
chmod "$saved_mode" "$doctor_src"
[[ "$rc" -eq 1 ]]
[[ "$cli_out" == *"service-writable"* ]]
[[ "$cli_out" != *"sudo should not run"* ]]
if [[ "$EUID" -eq 0 ]]; then
  [[ "$help_rc" -eq 0 ]]
  [[ "$help_out" == *"was not executed"* ]]
fi

echo "ok"
