/**
 * Hand one vault key to a running gateway without restarting it.
 *
 * The key reaches this child as an environment variable that a short-lived
 * keysafe invocation injected; this script never prints the value, never writes
 * it to a file, and sends it only as the body of one loopback POST to the
 * gateway's transient overlay (/gateway/keys). Because it runs under the
 * keysafe child, the plaintext is never visible to the agent or the harness and
 * never reaches a log.
 *
 * Usage: node gateway-key-inject.mjs <ENVVAR_NAME> <GATEWAY_PORT>
 */
const [envVarName, port] = process.argv.slice(2)
const value = envVarName ? process.env[envVarName] : ''

if (!value) {
  process.stderr.write(`gateway-key-inject: ${envVarName || '(no name)'} is empty\n`)
  process.exit(1)
}

try {
  const response = await fetch(`http://127.0.0.1:${port}/gateway/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: envVarName, value }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    process.stderr.write(`gateway-key-inject: gateway refused ${envVarName} (HTTP ${response.status})\n`)
    process.exit(1)
  }
  process.stdout.write(`gateway-key-inject: injected ${envVarName}\n`)
} catch {
  process.stderr.write(`gateway-key-inject: could not reach the gateway for ${envVarName}\n`)
  process.exit(1)
}
