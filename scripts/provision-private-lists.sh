#!/usr/bin/env bash
# Install privately-held standard lists into DATA_DIR/lists without ever
# copying their contents into the repository checkout.
#
#   provision-private-lists.sh SOURCE_DIR DATA_DIR
#
# SOURCE_DIR holds one or more <id>.json manifests, each next to the data
# file it names (see lists/README.md for the manifest shape). Every pair is
# validated for shape here and again, strictly, by the server on startup.
# Set PRIVATE_LIST_SHA256_<ID> (id uppercased, non-alphanumerics → _) to pin a
# data file's checksum.

set -euo pipefail

SOURCE_DIR="${1:?usage: provision-private-lists.sh SOURCE_DIR DATA_DIR}"
DATA_DIR="${2:?usage: provision-private-lists.sh SOURCE_DIR DATA_DIR}"
DEST_DIR="$DATA_DIR/lists"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

shopt -s nullglob
manifests=("$SOURCE_DIR"/*.json)
[[ ${#manifests[@]} -gt 0 ]] || { echo "no *.json list manifests in $SOURCE_DIR" >&2; exit 1; }

mkdir -p "$DEST_DIR"
installed=0
for manifest in "${manifests[@]}"; do
  id="$(jq -r '.id // empty' "$manifest")"
  file="$(jq -r '.file // empty' "$manifest")"
  base="$(basename "$manifest" .json)"
  [[ -n "$id" && -n "$file" ]] || { echo "$manifest: missing id or file" >&2; exit 1; }
  [[ "$id" == "$base" ]] || { echo "$manifest: id $id must match the file name $base.json" >&2; exit 1; }
  jq -e '(.kind == "allow" or .kind == "block") and (.scope == "domain" or .scope == "app_bundle")' "$manifest" >/dev/null \
    || { echo "$manifest: kind must be allow|block and scope domain|app_bundle" >&2; exit 1; }
  [[ -f "$SOURCE_DIR/$file" ]] || { echo "$manifest: data file $file missing next to the manifest" >&2; exit 1; }

  pin_var="PRIVATE_LIST_SHA256_$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9\n' '_')"
  if [[ -n "${!pin_var:-}" ]]; then
    actual="$(sha256sum "$SOURCE_DIR/$file" | awk '{print $1}')"
    [[ "$actual" == "${!pin_var}" ]] || { echo "$id: checksum mismatch for $file" >&2; exit 1; }
  fi

  install -m 0600 "$SOURCE_DIR/$file" "$DEST_DIR/.$file.new"
  install -m 0600 "$manifest" "$DEST_DIR/.$id.json.new"
  mv -f "$DEST_DIR/.$file.new" "$DEST_DIR/$file"
  mv -f "$DEST_DIR/.$id.json.new" "$DEST_DIR/$id.json"
  installed=$((installed + 1))
done

echo "installed $installed private list(s) into $DEST_DIR"
