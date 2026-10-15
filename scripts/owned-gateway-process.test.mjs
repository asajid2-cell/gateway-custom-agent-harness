import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repoScripts = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const helper = join(repoScripts, 'owned-gateway-process.ps1');
const powershell = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function quote(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function runPowerShell(script) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function isAlive(pid) {
  const result = runPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 }; exit 1`);
  return result.status === 0;
}

function killFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true });
}

function killFixtureProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

// Process ids, not paths: the needle is a full fixture path, so only fixture-owned
// roots can match it.
function commandLineHits(needle) {
  const script = [
    `$needle = '${needle.replace(/'/g, "''")}'`,
    "$hits = Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) }',
    '$hits | ForEach-Object { $_.ProcessId }',
  ].join('; ');
  return runPowerShell(script).stdout.trim().split(/\r?\n/).filter(Boolean).map(Number);
}

async function waitFor(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readPids(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'owned-gateway-process-'));
  const child = join(directory, 'child.mjs');
  const parent = join(directory, 'parent.mjs');
  const root = join(directory, 'root.ps1');
  const holder = join(directory, 'holder.ps1');
  const pids = join(directory, 'pids.json');
  const stdout = join(directory, 'gateway.out.log');
  const stderr = join(directory, 'gateway.err.log');
  const ready = join(directory, 'holder.ready');

  await writeFile(child, "setInterval(() => {}, 1000);\n", 'utf8');
  await writeFile(parent, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit', windowsHide: true });`,
    `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
    "console.log('node-parent-out');",
    "console.error('node-parent-err');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');
  await writeFile(root, [
    "[Console]::Out.WriteLine('root-out')",
    "[Console]::Error.WriteLine('root-err')",
    `& node.exe ${quote(parent)}`,
    '',
  ].join('\n'), 'utf8');
  await writeFile(holder, [
    'param([string]$Helper, [string]$Root, [string]$Stdout, [string]$Stderr, [string]$Ready, [string]$Mode)',
    "$ErrorActionPreference = 'Stop'",
    '. $Helper',
    "$owned = Start-OwnedGatewayProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('\"' + $Root + '\"')) -WorkingDirectory (Split-Path -Parent $Root) -StdoutPath $Stdout -StderrPath $Stderr",
    '[Console]::Out.WriteLine($owned.Process.Id)',
    "if ($Mode -eq 'dispose') { while (-not (Test-Path -LiteralPath $Ready)) { Start-Sleep -Milliseconds 25 }; $owned.Job.Dispose(); exit 0 }",
    "Set-Content -LiteralPath $Ready -Value 'ready' -Encoding ascii",
    'while ($true) { Start-Sleep -Seconds 60 }',
    '',
  ].join('\n'), 'utf8');

  return { directory, child, parent, root, holder, pids, stdout, stderr, ready, fixturePids: [] };
}

function startHolder(fixture, mode) {
  const child = spawn(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.holder,
    '-Helper', helper, '-Root', fixture.root, '-Stdout', fixture.stdout, '-Stderr', fixture.stderr,
    '-Ready', fixture.ready, '-Mode', mode,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return { child, getOutput: () => output, getErrors: () => errors };
}

async function launchContained(fixture, mode) {
  const holder = startHolder(fixture, mode);
  await waitFor(() => /^\d+\s*$/.test(holder.getOutput()), 'holder to report the root PID');
  const rootPid = Number(holder.getOutput().trim());
  await waitFor(async () => {
    const pids = await readPids(fixture.pids);
    return pids && isAlive(pids.parent) && isAlive(pids.child);
  }, 'node parent and child');
  const nodes = await readPids(fixture.pids);
  if (mode === 'dispose') {
    await waitFor(async () => {
      const pids = await readPids(fixture.pids);
      return pids && isAlive(pids.parent) && isAlive(pids.child);
    }, 'node tree before owner disposal');
    await writeFile(fixture.ready, 'dispose\n', 'ascii');
  }
  fixture.fixturePids.push(holder.child.pid, rootPid, nodes.parent, nodes.child);
  return { holder, rootPid, ...nodes };
}

async function cleanup(fixture) {
  for (const pid of fixture.fixturePids.reverse()) killFixtureProcessTree(pid);
  await rm(fixture.directory, { recursive: true, force: true });
}

test('disposing the owner job kills the PowerShell-to-Node process tree and redirects logs', { timeout: 20000 }, async () => {
  const fixture = await makeFixture();
  try {
    const launched = await launchContained(fixture, 'dispose');
    await waitFor(() => !isAlive(launched.rootPid) && !isAlive(launched.parent) && !isAlive(launched.child), 'job disposal to kill contained tree');
    const stdout = await readFile(fixture.stdout, 'utf8');
    const stderr = await readFile(fixture.stderr, 'utf8');
    assert.match(stdout, /root-out/);
    assert.match(stdout, /node-parent-out/);
    assert.match(stderr, /root-err/);
    assert.match(stderr, /node-parent-err/);
  } finally {
    await cleanup(fixture);
  }
});

test('hard-killing the holder closes the job but preserves an unrelated sibling', { timeout: 20000 }, async () => {
  const fixture = await makeFixture();
  let sibling;
  try {
    const launched = await launchContained(fixture, 'hold');
    sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
    fixture.fixturePids.push(sibling.pid);
    await waitFor(() => isAlive(sibling.pid), 'unrelated sibling');
    killFixtureProcessTree(launched.holder.child.pid);
    await waitFor(() => !isAlive(launched.rootPid) && !isAlive(launched.parent) && !isAlive(launched.child), 'holder termination to kill contained tree');
    assert.equal(isAlive(sibling.pid), true, 'unrelated process must not be in the holder job');
  } finally {
    if (sibling) killFixtureProcessTree(sibling.pid);
    await cleanup(fixture);
  }
});

test('a job that cannot accept the process fails closed and starts no child', { timeout: 20000 }, async () => {
  const fixture = await makeFixture();
  const needle = `-File "${fixture.root}"`;
  try {
    // Derived from the real helper with one deliberate difference: an empty
    // ActiveProcessLimit makes AssignProcessToJobObject fail with
    // ERROR_NOT_ENOUGH_QUOTA (1816), which is the branch the launcher must refuse
    // on rather than run the backend chain uncontained. Both replacement anchors
    // are asserted so the variant cannot silently stop matching the source.
    const source = await readFile(helper, 'utf8');
    const withConst = source.replace(
      'private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;',
      'private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;\n    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;',
    );
    assert.notEqual(withConst, source, 'the job-limit constant must exist to extend the variant');
    const quotaHelper = withConst.replace(
      'limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;',
      'limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_BREAKAWAY_OK;\n        limits.BasicLimitInformation.ActiveProcessLimit = 0;',
    );
    assert.notEqual(quotaHelper, withConst, 'the job-creation flags must exist to extend the variant');

    const quotaHelperPath = join(fixture.directory, 'helper-quota.ps1');
    const failHolder = join(fixture.directory, 'holder-fail.ps1');
    await writeFile(quotaHelperPath, quotaHelper, 'utf8');
    await writeFile(failHolder, [
      'param([string]$Helper, [string]$Root, [string]$Stdout, [string]$Stderr)',
      "$ErrorActionPreference = 'Stop'",
      '. $Helper',
      "$null = Start-OwnedGatewayProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('\"' + $Root + '\"')) -WorkingDirectory (Split-Path -Parent $Root) -StdoutPath $Stdout -StderrPath $Stderr",
      '',
    ].join('\n'), 'utf8');

    const failed = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', failHolder,
      '-Helper', quotaHelperPath, '-Root', fixture.root, '-Stdout', fixture.stdout, '-Stderr', fixture.stderr],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.notEqual(failed.status, 0, 'an unassignable job must refuse the launch');
    assert.match(`${failed.stdout}${failed.stderr}`, /AssignProcessToJobObject failed/);
    assert.deepEqual(commandLineHits(needle), [], 'the refused root must not be left running');
    assert.equal(await readPids(fixture.pids), null, 'the refused root must never reach its workload');
  } finally {
    for (const pid of commandLineHits(needle)) killFixtureProcessTree(pid);
    await cleanup(fixture);
  }
});

test('a durable leaf started through the helper outlives the job that started it', { timeout: 20000 }, async () => {
  // The custody contract: a member has to outlive the session that started it,
  // but a process born into the launcher's KILL_ON_JOB_CLOSE job is killed with
  // it. Start-BreakawayLeaf is the one spawner that leaves the job, so a leaf it
  // starts must survive host teardown while an ordinary child in the same job
  // does not. Both are observed after the job is disposed, not by reading flags.
  const directory = await mkdtemp(join(tmpdir(), 'owned-leaf-'))
  const child = join(directory, 'child.mjs')
  const root = join(directory, 'leafroot.ps1')
  const holder = join(directory, 'leafholder.ps1')
  const out = join(directory, 'leafpids.txt')
  const stdout = join(directory, 'leaf.out.log')
  const stderr = join(directory, 'leaf.err.log')
  const launched = [];
  try {
    await writeFile(child, 'setInterval(() => {}, 1000);\n', 'utf8');
    await writeFile(root, [
      'param([string]$Helper, [string]$Child, [string]$OutFile)',
      "$ErrorActionPreference = 'Stop'",
      '. $Helper',
      "$leafPid = Start-BreakawayLeaf -FilePath (Get-Command node).Source -ArgumentList @($Child) -WorkingDirectory (Split-Path -Parent $Child)",
      "$plain = Start-Process -FilePath node -ArgumentList $Child -WindowStyle Hidden -PassThru",
      'Start-Sleep -Milliseconds 300',
      'Set-Content -LiteralPath $OutFile -Value ("$leafPid,$([int]$plain.Id)") -Encoding ascii',
      'while ($true) { Start-Sleep -Seconds 60 }',
      '',
    ].join('\n'), 'utf8');
    await writeFile(holder, [
      'param([string]$Helper, [string]$Root, [string]$Child, [string]$OutFile, [string]$Stdout, [string]$Stderr)',
      "$ErrorActionPreference = 'Stop'",
      '. $Helper',
      "$owned = Start-OwnedGatewayProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('\"' + $Root + '\"'), '-Helper', $Helper, '-Child', $Child, '-OutFile', $OutFile) -WorkingDirectory (Split-Path -Parent $Root) -StdoutPath $Stdout -StderrPath $Stderr",
      'while (-not (Test-Path -LiteralPath $OutFile)) { Start-Sleep -Milliseconds 25 }',
      'Start-Sleep -Milliseconds 300',
      '$owned.Job.Dispose()',
      '',
    ].join('\n'), 'utf8');

    const holderChild = spawn(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holder,
      '-Helper', helper, '-Root', root, '-Child', child, '-OutFile', out, '-Stdout', stdout, '-Stderr', stderr,
    ], { stdio: 'ignore', windowsHide: true });
    launched.push(holderChild.pid);

    await waitFor(async () => {
      try { return (await readFile(out, 'utf8')).trim().length > 0; } catch { return false; }
    }, 'the leaf root to report its pids');
    const [leafPid, plainPid] = (await readFile(out, 'utf8')).trim().split(',').map(Number);
    launched.push(leafPid, plainPid);

    // The job is disposed once the root has reported, so the plain child dying
    // is the signal that teardown has run - and then the leaf is still there.
    await waitFor(() => !isAlive(plainPid), 'the contained child to die with the job');
    assert.equal(isAlive(plainPid), false, 'a child born the ordinary way is killed with the job');
    assert.equal(isAlive(leafPid), true, 'a leaf started through the helper leaves the job and survives it');
  } finally {
    for (const pid of launched.reverse()) killFixtureProcessTree(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('without the helper, killing a holder leaves its PowerShell root and Node tree alive', { timeout: 20000 }, async () => {
  const fixture = await makeFixture();
  let holder;
  try {
    const script = [
      `\$root = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '\"${fixture.root}\"') -WorkingDirectory '${fixture.directory}' -PassThru`,
      '[Console]::Out.WriteLine($root.Id)',
      'while ($true) { Start-Sleep -Seconds 60 }',
    ].join('; ');
    holder = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk) => { output += chunk; });
    await waitFor(() => /^\d+\s*$/.test(output), 'negative-control holder to report root PID');
    const rootPid = Number(output.trim());
    await waitFor(async () => {
      const pids = await readPids(fixture.pids);
      return pids && isAlive(pids.parent) && isAlive(pids.child);
    }, 'negative-control node tree');
    const nodes = await readPids(fixture.pids);
    fixture.fixturePids.push(holder.pid, rootPid, nodes.parent, nodes.child);
    killFixtureProcess(holder.pid);
    await waitFor(() => isAlive(rootPid) && isAlive(nodes.parent) && isAlive(nodes.child), 'uncontained tree to survive holder termination');
  } finally {
    await cleanup(fixture);
  }
});
