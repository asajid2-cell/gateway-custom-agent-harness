/**
 * Session-comms tests must not inherit the gateway route of the process that
 * launched them.
 *
 * Every leaf runs under cc.ps1, which exports the box's real
 * `CLAUDE_CODE_GATEWAY_BASE_URL` and `MODEL_GATEWAY_MODEL`. A bare test
 * transport reads those in `describeOwnRoute()` and advertises a route, and a
 * sender then probes that route before delivering. That is exactly right in
 * production, and wrong in a test: it makes the suite's verdict depend on
 * whether one of this box's own keys happens to be out of credits. A probe that
 * answers `exhausted` or `unauthorized` holds the message, and a test asserting
 * `queued` goes red for a reason that has nothing to do with the code under
 * test.
 *
 * Clearing the three variables for the duration of a test leaves a scratch
 * transport route-less, which every sender reads as `unknown` and delivers.
 *
 * This is test-side only. Production is untouched: a real session always has
 * these set, and it still advertises and probes.
 */
import { afterEach, beforeEach } from 'node:test'

const AMBIENT_ROUTE_ENV = ['MODEL_GATEWAY_MODEL', 'CLAUDE_CODE_GATEWAY_BASE_URL', 'CLAUDE_CODE_USE_GATEWAY'] as const

/** Clear the launcher's route advertisement; the returned function restores it. */
export function clearAmbientGatewayRoute(): () => void {
  const saved = AMBIENT_ROUTE_ENV.map(key => [key, process.env[key]] as const)
  for (const key of AMBIENT_ROUTE_ENV) delete process.env[key]
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Register the clearing around every test in the calling file. Call once at
 * module scope: hooks are file-scoped, so one call covers every test rather
 * than each scratch-env builder having to remember.
 *
 * A test that deliberately wants an advertised route (gateway-route-gate) sets
 * the variables itself inside the test, after this hook has run, and must call
 * `clearAmbientGatewayRoute` directly instead.
 */
export function isolateAmbientGatewayRoute(): void {
  let restore: (() => void) | undefined
  beforeEach(() => { restore = clearAmbientGatewayRoute() })
  afterEach(() => {
    restore?.()
    restore = undefined
  })
}
