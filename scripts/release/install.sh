#!/bin/sh
# Install Gateway on Linux or macOS.
#
# Two ways to run it:
#   ./install.sh                 interactive: asks where and what command
#   curl -fsSL <url> | sh        unattended with the defaults
#
# Options (all optional; on a TTY you are asked where and for the command):
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
# machine. The checksum in SHA256SUMS is required: a download is refused when
# no checksum can be obtained for it.
set -eu

REPO="${GATEWAY_REPO:-asajid2-cell/gateway}"
VERSION="${GATEWAY_VERSION:-}"
PREFIX="${GATEWAY_PREFIX:-}"
ALIAS="${GATEWAY_ALIAS:-gateway}"
ALIAS_EXPLICIT=0
BIN_DIR=""
ADD_PATH=ask
ASSUME_YES=0
ARCHIVE=""
ARCHIVE_EXPLICIT=0
ASSUME_ROOT=0
URL=""

if [ -n "${GATEWAY_ALIAS:-}" ]; then ALIAS_EXPLICIT=1; fi

if [ "$(id -u)" -eq 0 ]; then ASSUME_ROOT=1; fi

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --alias) ALIAS="$2"; ALIAS_EXPLICIT=1; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    --no-path) ADD_PATH=no; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --archive) ARCHIVE="$2"; ARCHIVE_EXPLICIT=1; shift 2 ;;
    --help|-h) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
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

# --- name and folder rules -------------------------------------------------
# The name becomes a file name and a command, so it is restricted to one path
# component. `cc`/`cl`/`gcc`/`clang` are compilers on these systems; taking one
# of those names would shadow the toolchain, so they are refused.
alias_is_valid() {
  case "$1" in
    ''|-*|.|..) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}

alias_is_compiler() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    cc|cl|gcc|clang) return 0 ;;
  esac
  return 1
}

normalize_dir() {
  d="$1"
  while [ "$d" != "/" ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done
  printf '%s' "$d"
}

# rm -rf runs on this path, so a whole system tree is never acceptable.
prefix_is_forbidden() {
  case "$1" in
    /|/usr|/usr/local|/usr/bin|/bin|/sbin|/etc|/var|/opt|/home|"$HOME"|"$HOME/.local"|"$HOME/.local/share"|"$HOME/bin")
      return 0 ;;
  esac
  return 1
}

prefix_is_ours() {
  [ -f "$1/install.json" ] && [ -f "$1/scripts/cc" ]
}

check_prefix() {
  case "$1" in
    /*) ;;
    *) die "the install folder must be an absolute path: $1" ;;
  esac
  if prefix_is_forbidden "$1"; then
    die "refusing to use $1 as the install folder; choose a dedicated directory such as $HOME/.local/share/gateway"
  fi
  if [ -e "$1" ] && [ ! -d "$1" ]; then die "$1 exists and is not a directory"; fi
  if [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null || true)" ] && ! prefix_is_ours "$1"; then
    die "$1 is not empty and was not installed by Gateway; refusing to replace it (choose another --prefix)"
  fi
}

# True when a link already points at this install (a reinstall/rename) or at
# another Gateway tree, in which case replacing it is safe.
link_is_ours() {
  [ -L "$1" ] || return 1
  t="$(readlink "$1" 2>/dev/null || true)"
  case "$t" in
    "$PREFIX"/*) return 0 ;;
  esac
  case "$t" in
    */bin/*)
      owner="$(dirname "$(dirname "$t")")"
      [ -f "$owner/install.json" ] && [ -f "$owner/scripts/cc" ] && return 0
      ;;
  esac
  return 1
}

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin|linux) ;;
  *) die "unsupported OS: $OS" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

if [ -z "$PREFIX" ]; then
  if [ "$ASSUME_ROOT" -eq 1 ]; then PREFIX=/opt/gateway; else PREFIX="$HOME/.local/share/gateway"; fi
  PREFIX="$(ask "Install Gateway where?" "$PREFIX")"
fi
PREFIX="$(normalize_dir "$PREFIX")"
if [ -z "$BIN_DIR" ]; then
  if [ "$ASSUME_ROOT" -eq 1 ]; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi
BIN_DIR="$(normalize_dir "$BIN_DIR")"
check_prefix "$PREFIX"
case "$BIN_DIR" in
  /*) ;;
  *) die "the link folder must be an absolute path: $BIN_DIR" ;;
esac

if [ "$INTERACTIVE" -eq 1 ] && [ "$ALIAS_EXPLICIT" -eq 0 ]; then
  while :; do
    ALIAS="$(ask 'Command name (cc, cl, gcc and clang are compilers)' 'gateway')"
    if alias_is_valid "$ALIAS" && ! alias_is_compiler "$ALIAS"; then break; fi
    printf 'Use 1-64 letters, digits, ".", "-" or "_", do not start with "-", and avoid cc/cl/gcc/clang.\n' >&2
  done
fi
alias_is_valid "$ALIAS" || die "invalid command name \"$ALIAS\": use 1-64 letters, digits, \".\", \"-\" or \"_\", not starting with \"-\""
if alias_is_compiler "$ALIAS"; then
  die "\"$ALIAS\" is the name of a C compiler on these systems; choose another name (for example gateway)"
fi

# Preflight the links before touching the disk: never silently replace a file
# or a foreign symlink the user put there.
SKIP_CC=0
check_link() {
  target="$BIN_DIR/$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if link_is_ours "$target"; then return 0; fi
    if [ "$1" = cc ]; then SKIP_CC=1; return 0; fi
    die "$target already exists and is not a Gateway link; remove it, or pass --bin DIR"
  fi
  return 0
}
check_link "$ALIAS"
[ "$ALIAS" = gateway ] || check_link gateway
if [ "$SKIP_CC" -eq 0 ]; then
  EXISTING_CC="$(command -v cc 2>/dev/null || true)"
  if [ -n "$EXISTING_CC" ] && [ "$EXISTING_CC" != "$BIN_DIR/cc" ] && ! link_is_ours "$BIN_DIR/cc"; then
    SKIP_CC=1
  fi
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
    [ -n "$VERSION" ] || die "could not resolve the latest release; set GATEWAY_VERSION"
  fi
  NAME="gateway-$VERSION-$OS-$ARCH.tar.gz"
  ARCHIVE="$TMP/$NAME"
  URL="https://github.com/$REPO/releases/download/v$VERSION/$NAME"
  echo "Downloading $URL"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then wget -q "$URL" -O "$ARCHIVE"
  else die "curl or wget is required"
  fi
fi
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"

# The version is in the archive name; record it rather than "unknown".
if [ -z "$VERSION" ] && [ -n "$NAME" ]; then
  VERSION="$(printf '%s' "$NAME" | sed -n "s/^gateway-\(.*\)-$OS-$ARCH\.tar\.gz$/\1/p")"
fi

# --- verify ----------------------------------------------------------------
# A line in SHA256SUMS may be a bare name or a path (linux/gateway-...); match
# on the basename so both layouts work.
sums_lookup() {
  awk -v name="$(basename "$ARCHIVE")" '{
    n = $2
    sub(/^\.\//, "", n)
    sub(/^.*\//, "", n)
    if (n == name) { print $1; exit }
  }' "$1" 2>/dev/null || true
}

HERE_DIR="$(cd -- "$(dirname -- "$ARCHIVE")" && pwd)"
EXPECTED=""
for sums in "$HERE_DIR/SHA256SUMS" "$ARCHIVE.sha256"; do
  [ -f "$sums" ] || continue
  EXPECTED="$(sums_lookup "$sums")"
  if [ -n "$EXPECTED" ]; then break; fi
done
if [ -z "$EXPECTED" ] && [ -n "$URL" ]; then
  SUMS_URL="https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SUMS_URL" -o "$TMP/SHA256SUMS" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$SUMS_URL" -O "$TMP/SHA256SUMS" 2>/dev/null || true
  fi
  if [ -f "$TMP/SHA256SUMS" ]; then EXPECTED="$(sums_lookup "$TMP/SHA256SUMS")"; fi
fi
if [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch for $(basename "$ARCHIVE"); refusing to install"
  fi
  echo "Checksum verified."
elif [ -n "$URL" ]; then
  die "no SHA256SUMS entry for $(basename "$ARCHIVE") in the release; refusing to install an unverified download"
elif [ "$ARCHIVE_EXPLICIT" -eq 1 ]; then
  echo "No checksum beside $(basename "$ARCHIVE"); installing the file you named." >&2
else
  echo "No SHA256SUMS beside $(basename "$ARCHIVE"); continuing without verification." >&2
fi

# --- install ---------------------------------------------------------------
mkdir -p "$TMP/tree"
tar -xzf "$ARCHIVE" -C "$TMP/tree"
[ -f "$TMP/tree/scripts/cc" ] || die "the archive does not contain scripts/cc"

rm -rf "$PREFIX.new"
mv "$TMP/tree" "$PREFIX.new"
chmod 0755 "$PREFIX.new/scripts/cc" "$PREFIX.new/runtime/bun" 2>/dev/null || true
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"
mkdir -p "$PREFIX/bin"

# The shim records the install folder. Moving or renaming that folder means
# running install.sh again (or editing this one line).
write_shim() {
  cat > "$PREFIX/bin/$1" <<EOF
#!/bin/sh
exec "$PREFIX/scripts/cc" "\$@"
EOF
  chmod 0755 "$PREFIX/bin/$1"
}
write_shim "$ALIAS"
[ "$ALIAS" = gateway ] || write_shim gateway

# --- link into a PATH directory -------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/bin/$ALIAS" "$BIN_DIR/$ALIAS"
[ "$ALIAS" = gateway ] || ln -sf "$PREFIX/bin/gateway" "$BIN_DIR/gateway"

if [ "$SKIP_CC" -eq 0 ]; then
  ln -sf "$PREFIX/bin/gateway" "$BIN_DIR/cc"
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
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
cat > "$PREFIX/install.json" <<EOF
{
  "prefix": "$(json_escape "$PREFIX")",
  "bin": "$(json_escape "$BIN_DIR")",
  "alias": "$(json_escape "$ALIAS")",
  "version": "$(json_escape "${VERSION:-unknown}")",
  "platform": "$OS",
  "arch": "$ARCH"
}
EOF

printf '\nGateway installed in %s\n' "$PREFIX"
printf '  %s -> %s/%s\n' "$ALIAS" "$BIN_DIR" "$ALIAS"
if [ "$ALIAS" != "gateway" ]; then printf '  gateway -> %s/gateway\n' "$BIN_DIR"; fi
printf '%s\n' "$CC_NOTE"
if [ "$ON_PATH" -eq 0 ] && [ "$ADDED_PATH" -eq 0 ]; then
  printf 'Add %s to PATH to run it from any terminal.\n' "$BIN_DIR"
fi
printf '\nCheck it with:  %s login --status\n' "$ALIAS"
