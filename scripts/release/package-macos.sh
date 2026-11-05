#!/bin/bash
# Build the macOS installer from a packaged release tree.
#
# Run this ON macOS. A cross-built pkg would not exercise the things that
# differ on the target: the Keychain helper, codesign, the darwin sharp
# prebuilt and the darwin codex tree. That is the whole reason the macOS
# installer is built by the macOS lane rather than shipped from another host.
#
#   scripts/release/package-macos.sh <tree> <out> [version] [identifier]
#
# Outputs, in <out>:
#   gateway-<version>-darwin-<arch>.pkg   component installer, /usr/local/gateway
#   gateway-<version>-darwin-<arch>.dmg   the pkg in a disk image
#   <both>.sha256
#
# Signing is opt-in and never faked:
#   GATEWAY_CODESIGN_IDENTITY="Developer ID Installer: ..."  -> productsign
#   GATEWAY_NOTARY_PROFILE="keychain-profile"                -> notarytool submit
# Without them the pkg is unsigned and Gatekeeper says so; the script prints
# that plainly instead of producing something that claims otherwise.
set -euo pipefail

TREE="${1:?usage: package-macos.sh <tree> <out> [version] [identifier]}"
OUT="${2:?usage: package-macos.sh <tree> <out> [version] [identifier]}"
MANIFEST="$TREE/install-manifest.json"
[ -f "$MANIFEST" ] || { echo "package-macos: $MANIFEST is missing; package the tree first" >&2; exit 1; }

read_manifest() {
  /usr/bin/plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null \
    || /usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$MANIFEST" "$1"
}

PLATFORM="$(read_manifest platform)"
ARCH="$(read_manifest arch)"
[ "$PLATFORM" = "darwin" ] || { echo "package-macos: tree is $PLATFORM, not darwin" >&2; exit 1; }
VERSION="${3:-$(read_manifest numeric_version)}"
IDENTIFIER="${4:-com.asajid2.gateway}"
NAME="gateway-$VERSION-darwin-$ARCH"

WORK="$OUT/.pkg-$NAME"
rm -rf "$WORK"
mkdir -p "$WORK/root/usr/local" "$WORK/scripts" "$WORK/dmg"

# The tree is installed whole; postinstall owns the two things a copy cannot
# carry reliably from a non-mac build host (mode bits and links).
cp -R "$TREE" "$WORK/root/usr/local/gateway"
chmod 0755 "$WORK/root/usr/local/gateway/scripts/cc" "$WORK/root/usr/local/gateway/runtime/bun"

cat > "$WORK/scripts/postinstall" <<'POSTINSTALL'
#!/bin/sh
set -e
chmod 0755 /usr/local/gateway/scripts/cc /usr/local/gateway/runtime/bun 2>/dev/null || true
# /usr/local/bin is not guaranteed to exist on a fresh machine, and the links
# belong to postinstall rather than the payload so pkgutil does not own them.
mkdir -p /usr/local/bin
ln -sf /usr/local/gateway/scripts/cc /usr/local/bin/gateway
ln -sf /usr/local/gateway/scripts/cc /usr/local/bin/cc-gateway
# `cc` is clang's name on macOS and /usr/local/bin precedes /usr/bin, so take
# it only when this path is free.
if [ ! -e /usr/local/bin/cc ] && [ ! -L /usr/local/bin/cc ]; then
  ln -sf /usr/local/gateway/scripts/cc /usr/local/bin/cc
fi
exit 0
POSTINSTALL
chmod 0755 "$WORK/scripts/postinstall"

cat > "$WORK/scripts/preinstall" <<'PREINSTALL'
#!/bin/sh
# The install replaces the tree; the Keychain and ~/.claude are the user's data
# and are never touched by the package.
set -e
exit 0
PREINSTALL
chmod 0755 "$WORK/scripts/preinstall"

pkgbuild \
  --root "$WORK/root" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$WORK/scripts" \
  --install-location "/" \
  "$OUT/$NAME.pkg"

if [ -n "${GATEWAY_CODESIGN_IDENTITY:-}" ]; then
  productsign --sign "$GATEWAY_CODESIGN_IDENTITY" "$OUT/$NAME.pkg" "$OUT/$NAME.signed.pkg"
  mv "$OUT/$NAME.signed.pkg" "$OUT/$NAME.pkg"
  echo "package-macos: signed with $GATEWAY_CODESIGN_IDENTITY"
else
  echo "package-macos: unsigned pkg (set GATEWAY_CODESIGN_IDENTITY to sign)"
fi

if [ -n "${GATEWAY_NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$OUT/$NAME.pkg" --keychain-profile "$GATEWAY_NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/$NAME.pkg"
  echo "package-macos: notarized and stapled"
fi

cp "$OUT/$NAME.pkg" "$WORK/dmg/"
hdiutil create -volname "Gateway $VERSION" -srcfolder "$WORK/dmg" -ov -format UDZO "$OUT/$NAME.dmg"

for artifact in "$OUT/$NAME.pkg" "$OUT/$NAME.dmg"; do
  shasum -a 256 "$artifact" | awk '{print $1}' > "$artifact.sha256"
  printf '%s  %s\n' "$(cat "$artifact.sha256")" "$(basename "$artifact")"
done

rm -rf "$WORK"
echo "package-macos: wrote $OUT/$NAME.pkg and $OUT/$NAME.dmg"
