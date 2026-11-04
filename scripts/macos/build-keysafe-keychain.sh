#!/bin/sh
# Build the native Keychain helper. macOS only: this produces a Mach-O binary
# that the vault prefers over shelling out to `security`.
#
# The release lane runs this on the build host and ships the result next to the
# vault script as macos/bin/keysafe-keychain. A source checkout without the
# binary keeps working through the `security -i` path.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/bin"}
mkdir -p "$out"

command -v swiftc >/dev/null 2>&1 || {
  echo "swiftc not found; install the Xcode command line tools" >&2
  exit 1
}

swiftc -O -whole-module-optimization \
  -o "$out/keysafe-keychain" \
  "$here/keysafe-keychain.swift" \
  -framework Security

echo "built $out/keysafe-keychain"
