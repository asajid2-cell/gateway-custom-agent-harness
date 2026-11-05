#!/bin/sh
# Install Gateway from a published release archive.
#
#   curl -fsSL https://raw.githubusercontent.com/asajid2-cell/gateway/main/scripts/release/install.sh | sh
#
# Environment:
#   GATEWAY_VERSION   release tag to install (default: latest)
#   GATEWAY_REPO      owner/repo (default: asajid2-cell/gateway)
#   GATEWAY_PREFIX    install directory (default: /opt/gateway as root,
#                     ~/.local/share/gateway otherwise)
#
# The archive already carries its own bun runtime, so nothing else is required
# on the machine beyond a POSIX shell and either curl or wget.
set -eu

REPO="${GATEWAY_REPO:-asajid2-cell/gateway}"
VERSION="${GATEWAY_VERSION:-latest}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin|linux) ;;
  *) echo "install.sh: unsupported OS: $OS" >&2; exit 1 ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "install.sh: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  PREFIX="${GATEWAY_PREFIX:-/opt/gateway}"
  BIN_DIR=/usr/local/bin
else
  PREFIX="${GATEWAY_PREFIX:-$HOME/.local/share/gateway}"
  BIN_DIR="$HOME/.local/bin"
fi

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$VERSION" ]; then
    echo "install.sh: could not resolve the latest release; set GATEWAY_VERSION" >&2
    exit 1
  fi
fi

NAME="gateway-$VERSION-$OS-$ARCH"
URL="https://github.com/$REPO/releases/download/v$VERSION/$NAME.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else echo "install.sh: curl or wget is required" >&2; exit 1
  fi
}

echo "Downloading $URL"
fetch "$URL" "$TMP/$NAME.tar.gz"

# A checksum beside the archive is optional, but when it exists it is checked:
# an installer that skips it is a supply-chain hole that looks like a feature.
if fetch "$URL.sha256" "$TMP/checksum" 2>/dev/null; then
  EXPECTED="$(cut -d' ' -f1 "$TMP/checksum")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP/$NAME.tar.gz" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$TMP/$NAME.tar.gz" | cut -d' ' -f1)"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "install.sh: checksum mismatch; refusing to install" >&2
    exit 1
  fi
fi

mkdir -p "$TMP/tree"
tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP/tree"

# Replace in place only after the new tree is complete, so a failed download
# never leaves a half-installed prefix.
rm -rf "$PREFIX.new"
mv "$TMP/tree" "$PREFIX.new"
chmod 0755 "$PREFIX.new/scripts/cc" "$PREFIX.new/runtime/bun" 2>/dev/null || true
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"

mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/scripts/cc" "$BIN_DIR/gateway"
ln -sf "$PREFIX/scripts/cc" "$BIN_DIR/cc-gateway"
# `cc` is the C compiler on every POSIX box, and $BIN_DIR usually precedes
# /usr/bin in PATH. Claim the short name only when it is free.
if ! command -v cc >/dev/null 2>&1; then
  ln -sf "$PREFIX/scripts/cc" "$BIN_DIR/cc"
  CC_NOTE="  cc      -> $BIN_DIR/cc"
else
  CC_NOTE="  (cc is the system C compiler here; use cc-gateway)"
fi

echo "Gateway $VERSION installed to $PREFIX"
echo "  gateway -> $BIN_DIR/gateway"
echo "  cc-gateway -> $BIN_DIR/cc-gateway"
[ -n "${CC_NOTE:-}" ] && echo "$CC_NOTE"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH to run it from any shell." ;;
esac
