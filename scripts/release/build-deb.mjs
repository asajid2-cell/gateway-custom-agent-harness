#!/usr/bin/env node
/**
 * Build a Debian package from a packaged release tree.
 *
 * A .deb is an `ar` archive of three members, which is why this can be built on
 * a Windows host: `ar` itself is written here (30 lines) and the two tarballs
 * come from bsdtar. Symlinks and executable bits are applied by `postinst`
 * rather than created in the staging directory, because a Windows host cannot
 * create the first and does not reliably carry the second.
 *
 * Installs under /opt/gateway and links /usr/bin/cc and /usr/bin/gateway.
 *
 * Usage: node scripts/release/build-deb.mjs --tree <dir> --out <dir> [--maintainer <email>]
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`build-deb: ${message}`)
  process.exit(1)
}

const tree = path.resolve(arg('tree') ?? '')
if (!tree || !existsSync(path.join(tree, 'install-manifest.json'))) {
  fail('--tree must name a packaged release tree (install-manifest.json is missing)')
}
const manifest = JSON.parse(await readFile(path.join(tree, 'install-manifest.json'), 'utf8'))
if (manifest.platform !== 'linux') fail(`tree is ${manifest.platform}, not linux`)
const out = path.resolve(arg('out') ?? path.join(ROOT, 'release-out'))
const maintainer = arg('maintainer') ?? 'Ahmed Sajid <ahmedsajid2k3@outlook.com>'
const version = manifest.numeric_version ?? '1.0.0'
const architecture = manifest.arch === 'arm64' ? 'arm64' : 'amd64'

const TAR = process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`)
  }
  return result
}

async function walk(directory, base = directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full, base))
    else if (entry.isFile()) files.push(path.relative(base, full))
  }
  return files
}

// --- rootfs ----------------------------------------------------------------
const work = path.join(out, `.deb-${manifest.package}`)
const rootfs = path.join(work, 'rootfs')
await rm(work, { recursive: true, force: true })
await mkdir(path.join(rootfs, 'opt'), { recursive: true })
await mkdir(path.join(rootfs, 'DEBIAN'), { recursive: true })
await mkdir(path.join(rootfs, 'usr', 'bin'), { recursive: true })
// `cp -r` of the tree, done by the platform tar so modes are libarchive's
// defaults rather than Node's copy semantics.
await mkdir(path.join(rootfs, 'opt', 'gateway'), { recursive: true })
run(TAR, ['-cf', path.join(work, 'tree.tar'), '-C', tree, '.'])
run(TAR, ['-xf', path.join(work, 'tree.tar'), '-C', path.join(rootfs, 'opt', 'gateway')])

const files = await walk(path.join(rootfs, 'opt', 'gateway'))
let installedBytes = 0
for (const file of files) installedBytes += (await stat(path.join(rootfs, 'opt', 'gateway', file))).size

const control = `Package: gateway-cc
Version: ${version}
Architecture: ${architecture}
Maintainer: ${maintainer}
Installed-Size: ${Math.ceil(installedBytes / 1024)}
Section: utils
Priority: optional
Homepage: https://github.com/asajid2-cell/gateway
Description: Gateway (Claude Code) CLI and model gateway
 A source-built Claude Code harness with a local model gateway that routes
 Claude, Codex, and key-based providers. Ships its own bun runtime, so the
 install has no external runtime dependency.
`

// /usr/bin/cc is the system C-compiler alternative. Taking that name would
// replace the compiler on install and delete it on uninstall, which is a
// toolchain break no one would attribute to a gateway. `gateway` is the
// command; `cc-gateway` is the short one; bare `cc` is claimed only when
// nothing else owns it.
const postinst = `#!/bin/sh
set -e
chmod 0755 /opt/gateway/scripts/cc /opt/gateway/runtime/bun 2>/dev/null || true
ln -sf /opt/gateway/scripts/cc /usr/bin/gateway
ln -sf /opt/gateway/scripts/cc /usr/bin/cc-gateway
if [ ! -e /usr/bin/cc ] && [ ! -L /usr/bin/cc ]; then
  ln -sf /opt/gateway/scripts/cc /usr/bin/cc
fi
# The installed gateway runs on the bundled vault, kept apart from any
# development session's ~/.claude/keysafe. A system install cannot name one
# user's path, so it names a suffix and each user gets ~/.claude/keysafe-gateway.
cat > /opt/gateway/install.env <<'GATEWAYENV'
# Written by the Gateway package.
GATEWAY_CREDENTIALS_MODE=bundled
GATEWAY_KEYSAFE_ID=gateway
GATEWAYENV
exit 0
`
const prerm = `#!/bin/sh
set -e
rm -f /usr/bin/gateway /usr/bin/cc-gateway /opt/gateway/install.env
# Only remove \`cc\` when this package created it. readlink without -f: if the
# target is already gone, -f yields an empty string and the link would survive.
if [ -L /usr/bin/cc ] && [ "$(readlink /usr/bin/cc)" = "/opt/gateway/scripts/cc" ]; then
  rm -f /usr/bin/cc
fi
exit 0
`

await writeFile(path.join(rootfs, 'DEBIAN', 'control'), control)
await writeFile(path.join(rootfs, 'DEBIAN', 'postinst'), postinst, { mode: 0o755 })
await writeFile(path.join(rootfs, 'DEBIAN', 'prerm'), prerm, { mode: 0o755 })

// --- tarballs --------------------------------------------------------------
const controlTar = path.join(work, 'control.tar.gz')
const dataTar = path.join(work, 'data.tar.gz')
run(TAR, ['-czf', controlTar, '-C', path.join(rootfs, 'DEBIAN'), '.'])
run(TAR, ['-czf', dataTar, '-C', rootfs, 'opt', 'usr'])

// --- ar writer -------------------------------------------------------------
/**
 * The `ar` container: a fixed global header, then members with a 60-byte
 * header each. Names here are short enough for the original format (<= 16
 * bytes including the trailing slash), so no long-name table is needed.
 */
function arMember(name, bytes, mtime = 0) {
  const header = Buffer.alloc(60, 0x20)
  header.write(`${name}/`.padEnd(16, ' '), 0, 16, 'ascii')
  header.write(String(mtime).padEnd(12, ' '), 16, 12, 'ascii')
  header.write('0'.padEnd(6, ' '), 28, 6, 'ascii')
  header.write('0'.padEnd(6, ' '), 34, 6, 'ascii')
  header.write('100644'.padEnd(8, ' '), 40, 8, 'ascii')
  header.write(String(bytes.length).padEnd(10, ' '), 48, 10, 'ascii')
  header.write('`\n', 58, 2, 'ascii')
  const pad = bytes.length % 2 === 1 ? Buffer.from('\n') : Buffer.alloc(0)
  return Buffer.concat([header, bytes, pad])
}

const members = [
  arMember('debian-binary', Buffer.from('2.0\n')),
  arMember('control.tar.gz', await readFile(controlTar)),
  arMember('data.tar.gz', await readFile(dataTar)),
]
const deb = Buffer.concat([Buffer.from('!<arch>\n'), ...members])
await mkdir(out, { recursive: true })
const debPath = path.join(out, `${manifest.package}.deb`)
await writeFile(debPath, deb)

console.log(
  JSON.stringify(
    {
      deb: debPath,
      bytes: deb.length,
      sha256: createHash('sha256').update(deb).digest('hex'),
      package: 'gateway-cc',
      version,
      architecture,
      files: files.length,
      installedBytes,
    },
    null,
    2,
  ),
)
