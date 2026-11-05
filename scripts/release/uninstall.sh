#!/bin/sh
# Remove a Gateway install made by install.sh on Linux or macOS.
#
#   ./uninstall.sh [--prefix DIR] [--yes]
#
# The install folder is discovered from the command's symlink, so you do not
# have to remember where it went. Your settings, accounts and vault live in
# ~/.claude and are never touched.
set -eu

PREFIX=""
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

# Discover the prefix from a command that resolves into it.
if [ -z "$PREFIX" ]; then
  for name in gateway; do
    target="$(command -v "$name" 2>/dev/null || true)"
    [ -n "$target" ] || continue
    resolved="$(readlink -f "$target" 2>/dev/null || readlink "$target" 2>/dev/null || echo "$target")"
    case "$resolved" in
      */bin/*)
        PREFIX="$(dirname "$(dirname "$resolved")")"
        break
        ;;
    esac
  done
fi
if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" -eq 0 ]; then PREFIX=/opt/gateway; else PREFIX="$HOME/.local/share/gateway"; fi
fi

if [ ! -d "$PREFIX" ]; then
  echo "uninstall.sh: $PREFIX does not exist; nothing to remove." >&2
  exit 1
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Remove Gateway from %s? [y/N]: ' "$PREFIX" >&2
  IFS= read -r reply || reply=""
  case "$reply" in [yY]*) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

# The install records where its links went; fall back to the usual places.
BIN_DIRS="/usr/local/bin $HOME/.local/bin $HOME/bin /usr/bin"
META="$(sed -n 's/.*"bin": *"\([^"]*\)".*/\1/p' "$PREFIX/install.json" 2>/dev/null || true)"
[ -n "$META" ] && BIN_DIRS="$META $BIN_DIRS"

for bin in $BIN_DIRS; do
  [ -d "$bin" ] || continue
  for name in gateway cc-gateway cc; do
    link="$bin/$name"
    [ -L "$link" ] || continue
    target="$(readlink "$link" 2>/dev/null || true)"
    case "$target" in
      "$PREFIX"/*) rm -f "$link"; echo "Removed $link" ;;
    esac
  done
done

# Our PATH block, identified by the markers install.sh writes.
for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if grep -q '^# >>> gateway >>>$' "$rc" 2>/dev/null; then
    tmp="$(mktemp)"
    awk 'BEGIN { skip = 0 } /^# >>> gateway >>>$/ { skip = 1; next } /^# <<< gateway <<<$/ { skip = 0; next } skip != 1 { print }' "$rc" > "$tmp"
    cat "$tmp" > "$rc"
    rm -f "$tmp"
    echo "Removed the PATH entry from $rc"
  fi
done

rm -rf "$PREFIX"
echo "Gateway removed. ~/.claude (settings, accounts, vault) was not touched."
