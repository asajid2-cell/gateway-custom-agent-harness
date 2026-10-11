import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  GATEWAY_RELOAD_EXIT_CODE,
  buildGatewayLaunch,
  buildKeyInjectLaunch,
  isGatewayKeyEnvVar,
  keysafeScriptPath,
  listKeysafeProviders,
  stripGatewayKeys,
} from './gateway-keysafe.mjs'

async function fixtureVault(records) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gateway-keysafe-'))
  await mkdir(path.join(home, '.keysafe'), { recursive: true })
  await mkdir(path.dirname(keysafeScriptPath(home)), { recursive: true })
  await writeFile(keysafeScriptPath(home), '# fixture keysafe\n')
  for (const name of records) {
    await writeFile(path.join(home, '.keysafe', `${name}.cred`), 'fixture\n')
  }
  return home
}

test('reload exit code is a distinct temp-fail code', () => {
  assert.equal(GATEWAY_RELOAD_EXIT_CODE, 75)
})

test('only the numbered OpenCode and fixed provider variables count as gateway keys', () => {
  for (const name of ['OPENCODE_API_KEY', 'OPENCODE_API_KEY2', 'OPENCODE_API_KEY12', 'DEEPSEEK_API_KEY', 'AMD_API_KEY', 'COMMANDCODE_API_KEY', 'COMMANDCODE_API_KEY2']) {
    assert.equal(isGatewayKeyEnvVar(name), true, name)
  }
  for (const name of ['OPENCODE_API_KEY_OTHER', 'OPENCODE_API_KEY1', 'OPENCODE_API_KEY0', 'COMMANDCODE_API_KEY_OTHER', 'COMMANDCODE_API_KEY1', 'COMMANDCODE_API_KEY0', 'PATH', 'ANTHROPIC_API_KEY']) {
    assert.equal(isGatewayKeyEnvVar(name), false, name)
  }
})

test('providers are listed in vault order, numbered OpenCode first then the fixed layers', async () => {
  const home = await fixtureVault(['opencode-go', 'opencode-go3', 'opencode-go2', 'amd-ds', 'commandcode2', 'commandcode', 'ds', 'unrelated'])
  try {
    assert.deepEqual(listKeysafeProviders(home), [
      { credential: 'opencode-go', envVar: 'OPENCODE_API_KEY' },
      { credential: 'opencode-go2', envVar: 'OPENCODE_API_KEY2' },
      { credential: 'opencode-go3', envVar: 'OPENCODE_API_KEY3' },
      { credential: 'amd-ds', envVar: 'AMD_API_KEY' },
      { credential: 'commandcode', envVar: 'COMMANDCODE_API_KEY' },
      { credential: 'commandcode2', envVar: 'COMMANDCODE_API_KEY2' },
      { credential: 'ds', envVar: 'DEEPSEEK_API_KEY' },
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the inject launch runs one keysafe child that posts the key without an argument', async () => {
  const home = await fixtureVault(['opencode-go6'])
  const env = { ...process.env, OPENCODE_API_KEY6: 'stale' }
  try {
    const launch = buildKeyInjectLaunch({
      credential: 'opencode-go6',
      envVar: 'OPENCODE_API_KEY6',
      port: 4123,
      home,
      env,
      platform: 'win32',
      nodePath: 'node',
    })
    assert.equal(launch.file, 'powershell.exe')
    assert.deepEqual(launch.args.slice(0, 6), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', keysafeScriptPath(home), 'run'])
    // One record, injected as one env var; the key is never an argument.
    assert.equal(launch.args[6], 'opencode-go6')
    assert.deepEqual(launch.args.slice(7, 9), ['-EnvVar', 'OPENCODE_API_KEY6'])
    assert.equal(launch.args[9], '-Command')
    const command = launch.args[10]
    assert.match(command, /gateway-key-inject\.mjs/)
    assert.match(command, /OPENCODE_API_KEY6/)
    assert.match(command, /4123/)
    assert.doesNotMatch(command, /stale/)
    // The inherited stale value is stripped, so only the fresh injection survives.
    assert.equal('OPENCODE_API_KEY6' in launch.env, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an empty vault spawns the gateway directly with the inherited environment', async () => {
  const home = await fixtureVault([])
  const env = { ...process.env, OPENCODE_API_KEY: 'kept' }
  try {
    const launch = buildGatewayLaunch({ gatewayPath: '/gw.mjs', gatewayArgs: ['--port', '1'], home, env, platform: 'win32' })
    assert.equal(launch.file, process.execPath)
    assert.deepEqual(launch.args, ['/gw.mjs', '--port', '1'])
    assert.equal(launch.env, env)
    assert.equal(launch.env.OPENCODE_API_KEY, 'kept')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a populated vault injects every key through one keysafe run-many call and strips inherited keys', async () => {
  const home = await fixtureVault(['opencode-go', 'opencode-go3', 'amd-ds', 'commandcode', 'ds'])
  const env = { ...process.env, OPENCODE_API_KEY: 'stale', DEEPSEEK_API_KEY: 'stale', KEEP_ME: 'yes' }
  try {
    const launch = buildGatewayLaunch({ gatewayPath: 'C:\\gw\\model-gateway.mjs', gatewayArgs: ['--port', '4011'], home, env, platform: 'win32' })
    assert.equal(launch.file, 'powershell.exe')
    assert.deepEqual(launch.args.slice(0, 6), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', keysafeScriptPath(home), 'run-many'])
    assert.equal(launch.args[6], '-Inject')
    // One cred=ENVVAR spec per vault record, in vault order.
    assert.equal(
      launch.args[7],
      'opencode-go=OPENCODE_API_KEY;opencode-go3=OPENCODE_API_KEY3;amd-ds=AMD_API_KEY;commandcode=COMMANDCODE_API_KEY;ds=DEEPSEEK_API_KEY',
    )
    assert.equal(launch.args[8], '-Command')
    // The command is a single gateway invocation, not a nested keysafe chain.
    const command = launch.args[9]
    assert.match(command, /model-gateway\.mjs/)
    assert.doesNotMatch(command, /keysafe/)
    // The stale inherited values are gone; unrelated variables survive.
    assert.equal('OPENCODE_API_KEY' in launch.env, false)
    assert.equal('DEEPSEEK_API_KEY' in launch.env, false)
    assert.equal(launch.env.KEEP_ME, 'yes')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('off Windows the chain is skipped and the environment is untouched', async () => {
  const home = await fixtureVault(['ds'])
  const env = { ...process.env, DEEPSEEK_API_KEY: 'kept' }
  try {
    const launch = buildGatewayLaunch({ gatewayPath: '/gw.mjs', home, env, platform: 'linux' })
    assert.equal(launch.file, process.execPath)
    assert.equal(launch.env, env)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('stripGatewayKeys removes only gateway key variables', () => {
  const stripped = stripGatewayKeys({
    OPENCODE_API_KEY: 'a',
    OPENCODE_API_KEY4: 'b',
    AMD_API_KEY: 'c',
    COMMANDCODE_API_KEY: 'd',
    DEEPSEEK_API_KEY: 'e',
    OPENCODE_API_KEY_OTHER: 'f',
    PATH: '/bin',
  })
  assert.deepEqual(stripped, { OPENCODE_API_KEY_OTHER: 'f', PATH: '/bin' })
})
