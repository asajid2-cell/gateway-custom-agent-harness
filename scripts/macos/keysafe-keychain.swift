// Native Keychain access for the bundled keysafe master key.
//
// The vault only needs one item: a generic password named by the vault's
// service/account pair. This helper does that with Security.framework so the
// vault does not depend on the `security` CLI, its interactive stdin protocol,
// or its human-readable error text.
//
// The secret moves on stdin (set) or stdout (get) only, never in argv. Exit
// codes are the contract:
//
//   0   success
//   44  no such item (errSecItemNotFound)
//   45  the item exists but this session may not read it
//       (errSecInteractionNotAllowed / errSecAuthFailed)
//   1   anything else; a short diagnostic goes to stderr
//
// The item is an ordinary login-keychain generic password whose data is the
// base64 text of the key, with an ACL that trusts any application (what
// `security add-generic-password -A` creates). That keeps the item readable
// after a rebuild of this unsigned helper and by any of our processes without
// an approval prompt. The access is what a 0600 master-key file already grants
// the same user.

import Foundation
import Security

let usage = "usage: keysafe-keychain <get|set> <service> <account>\n"

func fail(_ status: OSStatus) -> Never {
  let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
  let line = "keysafe-keychain: \(text) (\(status))\n"
  FileHandle.standardError.write(Data(line.utf8))
  switch status {
  case errSecItemNotFound:
    exit(44)
  case errSecInteractionNotAllowed, errSecAuthFailed:
    exit(45)
  default:
    exit(1)
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3 else {
  FileHandle.standardError.write(Data(usage.utf8))
  exit(64)
}

let operation = arguments[0]
let service = arguments[1]
let account = arguments[2]

let baseQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]

switch operation {
case "get":
  var query = baseQuery
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  if status != errSecSuccess { fail(status) }
  guard
    let data = item as? Data,
    let text = String(data: data, encoding: .utf8)
  else { fail(errSecDecode) }
  var out = Data(text.utf8)
  out.append(0x0a)
  FileHandle.standardOutput.write(out)

case "set":
  let raw = FileHandle.standardInput.readDataToEndOfFile()
  guard
    let text = String(data: raw, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
    !text.isEmpty
  else {
    FileHandle.standardError.write(Data("keysafe-keychain: expected a base64 secret on stdin\n".utf8))
    exit(64)
  }
  let secret = Data(text.utf8)
  // A trusted application created from a nil path stands for "any
  // application". Without it the item would be bound to this binary's code
  // identity and a rebuild could lock the vault behind an approval prompt.
  var trusted: SecTrustedApplication?
  let trustStatus = SecTrustedApplicationCreateFromPath(nil, &trusted)
  if trustStatus != errSecSuccess || trusted == nil { fail(trustStatus) }
  var access: SecAccess?
  let accessStatus = SecAccessCreate(service as CFString, [trusted!] as CFArray, &access)
  if accessStatus != errSecSuccess || access == nil { fail(accessStatus) }

  var add = baseQuery
  add[kSecValueData as String] = secret
  add[kSecAttrAccess as String] = access
  var status = SecItemAdd(add as CFDictionary, nil)
  if status == errSecDuplicateItem {
    status = SecItemUpdate(
      baseQuery as CFDictionary,
      [kSecValueData as String: secret] as CFDictionary
    )
  }
  if status != errSecSuccess { fail(status) }

default:
  FileHandle.standardError.write(Data(usage.utf8))
  exit(64)
}
