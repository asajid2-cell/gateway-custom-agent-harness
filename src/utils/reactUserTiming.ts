/**
 * Keep react-reconciler's DEV build from filling the Web Performance timeline.
 *
 * react-reconciler.development.js computes, once when `createReconciler(config)`
 * is called (the flag lives inside the exported factory body, not at module
 * scope, so hiding the marker before that call is always early enough):
 *
 *   supportsUserTiming =
 *     typeof console.timeStamp === 'function' &&
 *     typeof performance.measure === 'function'
 *
 * and — when true — calls `performance.measure(...)` / `console.timeStamp(...)`
 * for every component commit. Neither Bun nor this process ever drains that
 * timeline, so `performance.getEntries()` grows without bound: measured at ~166
 * entries per rendered gateway frame, ~125 KB of native (off-JS-heap) memory per
 * frame, which survives both `Bun.gc(true)` and unmount. A long session reaches
 * tens of GB of private commit that way.
 *
 * The dev build is what actually loads: `dist/cli.js` leaves `react-reconciler`
 * external and nothing sets NODE_ENV, so the package's index picks the
 * development entry. Bun also implements no `performance.timeStamp`, and
 * `console.timeStamp` writes no entry on its own (verified: 200k calls leave
 * `getEntries()` at 0, and `performance.measure` is the sole entry producer
 * that React reaches). So the marker is pure overhead in this runtime and the
 * timeline it feeds has no consumer here — hiding it costs no diagnosis.
 *
 * Must run before the reconciler is created, i.e. before `createReconciler()`.
 */
export function suppressReactDevUserTiming(): void {
  const consoleObject: Partial<Console> = console
  if (typeof consoleObject.timeStamp !== 'function') {
    return
  }
  // Own property on the console singleton, so it is configurable and can be
  // restored by a caller that wants the timeline.
  Object.defineProperty(consoleObject, 'timeStamp', {
    value: undefined,
    configurable: true,
    writable: true,
    enumerable: false,
  })
}
