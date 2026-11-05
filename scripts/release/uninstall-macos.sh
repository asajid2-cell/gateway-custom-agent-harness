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

rm -f /usr/local/bin/gateway /usr/local/bin/cc-gateway
# Remove `cc` only when it points into this install; it is clang's name
# otherwise and must survive.
if [ "$(readlink /usr/local/bin/cc 2>/dev/null)" = "$PREFIX/scripts/cc" ]; then
  rm -f /usr/local/bin/cc
fi
rm -rf "$PREFIX"
# A missing receipt is not a failure: the tree may have been installed by hand.
pkgutil --forget "$IDENTIFIER" >/dev/null 2>&1 || true

echo "Gateway removed from $PREFIX. ~/.claude and the Keychain were not touched."
