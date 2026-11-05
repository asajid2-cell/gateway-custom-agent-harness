#!/bin/sh
# Install Gateway on Linux or macOS.
#
# Two ways to run it:
#   ./install.sh                 interactive: asks where, what command, PATH
#   curl -fsSL <url> | sh        unattended with the defaults
#
# Options (all optional; on a TTY you are asked):
#   --prefix DIR    install directory   (default: /opt/gateway as root,
#                                        ~/.local/share/gateway otherwise)
#   --alias NAME    command name        (default: gateway)
#   --bin DIR       where to link the command (default: /usr/local/bin as root,
#                                        ~/.local/bin otherwise)
#   --no-path       do not offer to add the bin directory to your PATH
#   --yes           accept every default, never prompt
#   --archive FILE  use this tarball instead of downloading or discovering one
#
# The archive carries its own bun runtime, so nothing else is needed on the
# machine. A checksum is verified whenever a SHA256SUMS or .sha256 is present.
set -eu

REPO="${GATEWAY_REPO:-asajid2-cell/gateway}"
VERSION="${GATEWAY_VERSION:-}"
PREFIX="${GATEWAY_PREFIX:-}"
ALIAS="${GATEWAY_ALIAS:-gateway}"
BIN_DIR=""
ADD_PATH=ask
ASSUME_YES=0
ARCHIVE=""
ASSUME_ROOT=0

if [ "$(id -u)" -eq 0 ]; then ASSUME_ROOT=1; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    --no-path) ADD_PATH=no; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

# A TTY is what makes a prompt honest. Piped into sh there is nobody to ask.
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi
ask() {
  # ask <prompt> <default>
  if [ "$INTERACTIVE" -ne 1 ]; then printf '%s' "$2"; return; fi
  printf '%s [%s]: ' "$1" "$2" >&2
  IFS= read -r answer || answer=""
  if [ -z "$answer" ]; then printf '%s' "$2"; else printf '%s' "$answer"; fi
}

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

if [ -z "$PREFIX" ]; then
  if [ "$ASSUME_ROOT" -eq 1 ]; then PREFIX=/opt/gateway; else PREFIX="$HOME/.local/share/gateway"; fi
  PREFIX="$(ask "Install Gateway where?" "$PREFIX")"
fi
if [ -z "$BIN_DIR" ]; then
  if [ "$ASSUME_ROOT" -eq 1 ]; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi

printf '\nGateway %s for %s-%s\n' "${VERSION:-latest}" "$OS" "$ARCH"
printf '  install folder : %s\n' "$PREFIX"
printf '  command        : %s\n' "$ALIAS"
printf '  linked into    : %s\n\n' "$BIN_DIR"

# --- locate the archive ----------------------------------------------------
NAME=""
if [ -n "$ARCHIVE" ]; then
  NAME="$(basename "$ARCHIVE")"
else
  # Prefer an archive sitting beside this script: that is what the release
  # folder ships, and it means an install needs no network.
  HERE="$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo .)"
  for dir in "$HERE" "$PWD"; do
    for candidate in "$dir"/gateway-*-"$OS"-"$ARCH".tar.gz; do
      [ -f "$candidate" ] || continue
      ARCHIVE="$candidate"
      NAME="$(basename "$candidate")"
      break
    done
    [ -n "$ARCHIVE" ] && break
  done
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

if [ -z "$ARCHIVE" ]; then
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$VERSION" ] || { echo "install.sh: could not resolve the latest release; set GATEWAY_VERSION" >&2; exit 1; }
  fi
  NAME="gateway-$VERSION-$OS-$ARCH"
  ARCHIVE="$TMP/$NAME.tar.gz"
  URL="https://github.com/$REPO/releases/download/v$VERSION/$NAME.tar.gz"
  echo "Downloading $URL"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then wget -q "$URL" -O "$ARCHIVE"
  else echo "install.sh: curl or wget is required" >&2; exit 1
  fi
fi

# The version is in the archive name; record it rather than "unknown".
if [ -z "$VERSION" ] && [ -n "$NAME" ]; then
  VERSION="$(printf '%s' "$NAME" | sed -n "s/^gateway-\(.*\)-$OS-$ARCH\.tar\.gz$/\1/p")"
fi

# --- verify ----------------------------------------------------------------
HERE_DIR="$(cd -- "$(dirname -- "$ARCHIVE")" && pwd)"
EXPECTED=""
for sums in "$HERE_DIR/SHA256SUMS" "$ARCHIVE.sha256"; do
  [ -f "$sums" ] || continue
  EXPECTED="$(awk -v name="$(basename "$ARCHIVE")" '$2 == name { print $1; exit }' "$sums" 2>/dev/null || true)"
  [ -n "$EXPECTED" ] && break
done
if [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "install.sh: checksum mismatch for $(basename "$ARCHIVE"); refusing to install" >&2
    exit 1
  fi
  echo "Checksum verified."
else
  echo "No checksum file beside the archive; continuing without verification."
fi

# --- install ---------------------------------------------------------------
mkdir -p "$TMP/tree"
tar -xzf "$ARCHIVE" -C "$TMP/tree"

rm -rf "$PREFIX.new"
mv "$TMP/tree" "$PREFIX.new"
chmod 0755 "$PREFIX.new/scripts/cc" "$PREFIX.new/runtime/bun" 2>/dev/null || true
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"
mkdir -p "$PREFIX/bin"

# The shim is what makes the command name configurable without touching the
# payload. It resolves its own directory, so a moved prefix still works.
cat > "$PREFIX/bin/$ALIAS" <<EOF
#!/bin/sh
exec "$PREFIX/scripts/cc" "\$@"
EOF
chmod 0755 "$PREFIX/bin/$ALIAS"
if [ "$ALIAS" != "gateway" ]; then
  cat > "$PREFIX/bin/gateway" <<EOF
#!/bin/sh
exec "$PREFIX/scripts/cc" "\$@"
EOF
  chmod 0755 "$PREFIX/bin/gateway"
fi

# --- link into a PATH directory -------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/bin/$ALIAS" "$BIN_DIR/$ALIAS"
if [ "$ALIAS" != "gateway" ]; then ln -sf "$PREFIX/bin/gateway" "$BIN_DIR/gateway"; fi

# `cc` is the system C compiler; take the name only when it is free (or ours).
EXISTING_CC="$(command -v cc 2>/dev/null || true)"
if [ -z "$EXISTING_CC" ] \
  || [ "$EXISTING_CC" = "$BIN_DIR/cc" ] \
  || [ "$(readlink -f "$EXISTING_CC" 2>/dev/null || readlink "$EXISTING_CC" 2>/dev/null)" = "$PREFIX/scripts/cc" ]; then
  ln -sf "$PREFIX/bin/$ALIAS" "$BIN_DIR/cc"
  CC_NOTE="  cc           -> $BIN_DIR/cc"
else
  CC_NOTE="  (cc is the system C compiler here; not replaced)"
fi

# --- PATH ------------------------------------------------------------------
ON_PATH=0
case ":$PATH:" in *":$BIN_DIR:"*) ON_PATH=1 ;; esac
ADDED_PATH=0
if [ "$ON_PATH" -eq 0 ] && [ "$ADD_PATH" != "no" ]; then
  ANSWER=yes
  if [ "$INTERACTIVE" -eq 1 ]; then
    printf 'Add %s to your PATH? [Y/n]: ' "$BIN_DIR" >&2
    IFS= read -r reply || reply=""
    case "$reply" in [nN]*) ANSWER=no ;; esac
  fi
  if [ "$ANSWER" = yes ]; then
    RC=""
    case "${SHELL:-}" in
      */zsh) RC="$HOME/.zshrc" ;;
      */bash) RC="$HOME/.bashrc"; [ -f "$RC" ] || RC="$HOME/.bash_profile" ;;
    esac
    if [ -z "$RC" ]; then
      for candidate in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -f "$candidate" ] && RC="$candidate" && break
      done
    fi
    if [ -n "$RC" ]; then
      if ! grep -q '^# >>> gateway >>>$' "$RC" 2>/dev/null; then
        {
          printf '\n# >>> gateway >>>\n'
          printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
          printf '# <<< gateway <<<\n'
        } >> "$RC"
        ADDED_PATH=1
        echo "Added $BIN_DIR to PATH in $RC (open a new terminal)."
      fi
    fi
  fi
fi

# What was installed and where the links went, so uninstall does not guess.
cat > "$PREFIX/install.json" <<EOF
{
  "prefix": "$PREFIX",
  "bin": "$BIN_DIR",
  "alias": "$ALIAS",
  "version": "${VERSION:-unknown}",
  "platform": "$OS",
  "arch": "$ARCH"
}
EOF

printf '\nGateway installed in %s\n' "$PREFIX"
printf '  %s -> %s/%s\n' "$ALIAS" "$BIN_DIR" "$ALIAS"
[ "$ALIAS" != "gateway" ] && printf '  gateway -> %s/gateway\n' "$BIN_DIR"
printf '%s\n' "$CC_NOTE"
if [ "$ON_PATH" -eq 0 ] && [ "$ADDED_PATH" -eq 0 ]; then
  printf 'Add %s to PATH to run it from any terminal.\n' "$BIN_DIR"
fi
printf '\nCheck it with:  %s login --status\n' "$ALIAS"
