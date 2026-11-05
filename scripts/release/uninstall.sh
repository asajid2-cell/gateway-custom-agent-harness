#!/bin/sh
# Remove a Gateway install made by install.sh on Linux or macOS.
#
#   ./uninstall.sh [--prefix DIR] [--yes]
#
# The install folder is discovered from the command's symlink, but a folder is
# only removed when it carries the install.json and scripts/cc that install.sh
# wrote. A foreign `gateway` on your PATH therefore refuses, instead of turning
# this into rm -rf of its parent (a `gateway` in /usr/local/bin would otherwise
# mean rm -rf /usr/local). Your settings, accounts and vault live in ~/.claude
# and are never touched.
set -eu

PREFIX=""
ASSUME_YES=0
DISCOVERED=""

die() { printf 'uninstall.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

prefix_is_ours() {
  [ -f "$1/install.json" ] && [ -f "$1/scripts/cc" ]
}

# Discover the prefix from a command that resolves into it, and accept it only
# when it proves it is a Gateway tree.
if [ -z "$PREFIX" ]; then
  target="$(command -v gateway 2>/dev/null || true)"
  if [ -n "$target" ]; then
    resolved="$(readlink -f "$target" 2>/dev/null || readlink "$target" 2>/dev/null || echo "$target")"
    candidate=""
    case "$resolved" in
      */bin/*) candidate="$(dirname "$(dirname "$resolved")")" ;;
    esac
    if [ -n "$candidate" ]; then
      if prefix_is_ours "$candidate"; then PREFIX="$candidate"; else DISCOVERED="$candidate"; fi
    fi
  fi
fi
if [ -z "$PREFIX" ]; then
  if [ -n "$DISCOVERED" ]; then
    die "found $DISCOVERED through the \`gateway\` command, but it is not a Gateway install (no install.json); refusing to remove it. Pass --prefix DIR if you are sure."
  fi
  die "could not find a Gateway install (no \`gateway\` command on PATH). Pass --prefix DIR."
fi
PREFIX="$(printf '%s' "$PREFIX" | sed -e 's:/*$::')"
[ -n "$PREFIX" ] || die "refusing to remove /"
prefix_is_ours "$PREFIX" || die "$PREFIX does not contain install.json and scripts/cc; refusing to remove it"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Remove Gateway from %s? [y/N]: ' "$PREFIX" >&2
  IFS= read -r reply || reply=""
  case "$reply" in [yY]*) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

# Check the rc files before anything is deleted: a marker without its closing
# line would make the strip below eat the rest of the file, so refuse instead.
RCS=""
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if grep -q '^# >>> gateway >>>$' "$rc" 2>/dev/null; then
    if ! grep -q '^# <<< gateway <<<$' "$rc" 2>/dev/null; then
      die "$rc has \`# >>> gateway >>>\` without \`# <<< gateway <<<\`; refusing to edit it (and nothing was removed). Delete the block by hand, then re-run."
    fi
    RCS="$RCS$rc
"
  fi
done

# The install records where its links went; fall back to the usual places.
META_BIN="$(sed -n 's/.*"bin": *"\([^"]*\)".*/\1/p' "$PREFIX/install.json" 2>/dev/null || true)"
META_ALIAS="$(sed -n 's/.*"alias": *"\([^"]*\)".*/\1/p' "$PREFIX/install.json" 2>/dev/null || true)"
# One per line, so a home directory containing a space is still one entry.
BIN_DIRS="$META_BIN
/usr/local/bin
$HOME/.local/bin
$HOME/bin
/usr/bin"
NAMES="gateway
cc-gateway
cc"
case "$META_ALIAS" in
  ''|*[!A-Za-z0-9._-]*) ;;
  cc|cl|gcc|clang) ;;
  *) if [ "$META_ALIAS" != gateway ]; then NAMES="$NAMES
$META_ALIAS"; fi ;;
esac

remove_links_in() {
  bin="$1"
  [ -d "$bin" ] || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    link="$bin/$name"
    [ -L "$link" ] || continue
    target="$(readlink "$link" 2>/dev/null || true)"
    case "$target" in
      "$PREFIX"/*) rm -f "$link"; echo "Removed $link" ;;
    esac
  done <<EOF
$NAMES
EOF
}

while IFS= read -r bin; do
  [ -n "$bin" ] || continue
  remove_links_in "$bin"
done <<EOF
$BIN_DIRS
EOF

# Our PATH block, identified by the markers install.sh writes.
while IFS= read -r rc; do
  [ -n "$rc" ] || continue
  tmp="$(mktemp)"
  awk 'BEGIN { skip = 0 } /^# >>> gateway >>>$/ { skip = 1; next } /^# <<< gateway <<<$/ { skip = 0; next } skip != 1 { print }' "$rc" > "$tmp"
  cat "$tmp" > "$rc"
  rm -f "$tmp"
  echo "Removed the PATH entry from $rc"
done <<EOF
$RCS
EOF

rm -rf "$PREFIX"
echo "Gateway removed. ~/.claude (settings, accounts, vault) was not touched."
