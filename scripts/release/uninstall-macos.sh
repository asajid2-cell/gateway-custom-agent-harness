#!/bin/bash
# Remove a Gateway install made by the macOS package.
#
# The links live in /usr/local/bin and belong to the package's postinstall, so
# forgetting the receipt and deleting the tree leaves them dangling. Windows
# removes its links with the MSI; this is the macOS equivalent.
#
#   sudo scripts/release/uninstall-macos.sh [identifier]
#
# Deliberately not touched: ~/.claude (settings, accounts, vault) and anything
# in the login Keychain. Uninstalling the program is not deleting the user's
# credentials.
set -euo pipefail

IDENTIFIER="${1:-com.asajid2.gateway}"
PREFIX="/usr/local/gateway"

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall-macos: run with sudo (it removes /usr/local/gateway and two links)" >&2
  exit 1
fi

# Remove a link only when it points into this install; a file the user put in
# /usr/local/bin must survive, and so must clang's `cc`.
for name in gateway cc-gateway; do
  link="/usr/local/bin/$name"
  if [ "$(readlink "$link" 2>/dev/null)" = "$PREFIX/scripts/cc" ] || \
     [ "$(readlink "$link" 2>/dev/null)" = "$PREFIX/bin/$name" ]; then
    rm -f "$link"
  fi
done
if [ "$(readlink /usr/local/bin/cc 2>/dev/null)" = "$PREFIX/scripts/cc" ]; then
  rm -f /usr/local/bin/cc
fi
rm -rf "$PREFIX"
# A missing receipt is not a failure: the tree may have been installed by hand.
pkgutil --forget "$IDENTIFIER" >/dev/null 2>&1 || true

echo "Gateway removed from $PREFIX. ~/.claude and the Keychain were not touched."
