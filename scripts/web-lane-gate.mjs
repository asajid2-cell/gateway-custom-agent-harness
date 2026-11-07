/**
 * One lane tab opens at a time in one shared browser.
 *
 * Four senders arriving together each wanted a tab, and four concurrent
 * `newPage`+`goto chatgpt.com` page loads left the driver child silent for
 * more than 50 s; two lane opens then missed the 120 s warm budget and their
 * turns went unanswered. The browser is one resource: opens queue behind this
 * gate, FIFO, with no deadline of its own (the lane's warm budget already
 * bounds each one). Reads and sends on tabs that ALREADY exist are not gated
 * and stay parallel.
 *
 * One gate per driver process: a shared browser has exactly one driver child,
 * so the process is the scope that matters.
 */
export function createLaneGate() {
  let tail = Promise.resolve()
  return function serialLaneOpen(work) {
    // Run the next open after the previous has settled, whichever way it
    // settled: a failed open must not wedge the queue behind it.
    const run = tail.then(work, work)
    tail = run.then(() => {}, () => {})
    return run
  }
}
