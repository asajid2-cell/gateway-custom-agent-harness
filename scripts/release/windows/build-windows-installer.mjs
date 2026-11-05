#!/usr/bin/env node
/**
 * Build the Windows setup wizard (Inno Setup) from a packaged release tree.
 *
 * Two steps, both from source in this directory:
 *   1. compile GatewayManager.cs with the .NET Framework compiler that ships
 *      with Windows (a WinForms window, no runtime to install),
 *   2. run ISCC over gateway.iss with the tree, version and SHA as defines.
 *
 * Usage: node scripts/release/windows/build-windows-installer.mjs
 *          --tree <dir> --out <dir> [--version 1.0.0] [--sha be49df8]
 *
 * Environment: CSC (csc.exe path), ISCC (ISCC.exe path).
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function fail(message) {
  console.error(`build-windows-installer: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.status !== 0) {
    fail(`${path.basename(command)} failed:\n${(result.stderr || result.stdout || '').trim().slice(0, 4000)}`)
  }
  return result
}

/** Inno's VersionInfoVersion needs four numeric parts, with no suffix. */
function quadVersion(version) {
  const parts = String(version)
    .replace(/[^0-9.].*$/, '')
    .split('.')
    .map(part => (/^[0-9]+$/.test(part) ? part : '0'))
    .slice(0, 3)
  while (parts.length < 4) parts.push('0')
  return parts.join('.')
}

const tree = path.resolve(arg('tree', ''))
if (!tree || !existsSync(path.join(tree, 'install-manifest.json'))) {
  fail('--tree must name a packaged release tree (install-manifest.json is missing)')
}
const manifest = JSON.parse(await readFile(path.join(tree, 'install-manifest.json'), 'utf8'))
if (manifest.platform !== 'win32') fail(`tree is ${manifest.platform}, not win32`)
const version = arg('version', manifest.numeric_version ?? '1.0.0')
const sha = arg('sha', manifest.source_sha ?? 'unknown')
const out = path.resolve(arg('out', path.join(HERE, 'out')))
await mkdir(out, { recursive: true })

// --- manager ---------------------------------------------------------------
const csc = process.env.CSC
  ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) fail(`csc.exe not found at ${csc}; set CSC`)
const manager = path.join(out, 'GatewayManager.exe')
run(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/out:${manager}`,
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:Microsoft.CSharp.dll',
  path.join(HERE, 'GatewayManager.cs'),
])

// --- setup -----------------------------------------------------------------
const iscc = process.env.ISCC
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe')
if (!existsSync(iscc)) fail(`ISCC.exe not found at ${iscc}; install Inno Setup 6 or set ISCC`)

// ISCC keeps the quotes of a `/DName="value"` define as part of the value,
// which turns a version into `"1.0.0".0` and a path into `""C:\...""`. Values
// are therefore passed bare, which means the build paths must not contain
// spaces; refuse early rather than produce a setup with a broken Source path.
for (const [label, value] of [['tree', tree], ['out', out], ['manager', manager]]) {
  if (/\s/.test(value)) fail(`${label} path contains a space, which ISCC cannot take as a bare /D value: ${value}`)
}

run(iscc, [
  `/DTreeDir=${tree}`,
  `/DManagerExe=${manager}`,
  `/DAppVersion=${version}`,
  `/DVersionQuad=${quadVersion(version)}`,
  `/DSourceSha=${sha}`,
  `/O${out}`,
  path.join(HERE, 'gateway.iss'),
])

// Inno names the file from OutputBaseFilename; fail if it did not.
const setup = path.join(out, 'GatewaySetup.exe')
if (!existsSync(setup)) fail(`Inno returned success but ${setup} is missing`)
const info = await stat(setup)
console.log(JSON.stringify({ setup, bytes: info.size, version, sourceSha: sha, managerBytes: (await stat(manager)).size }, null, 2))
