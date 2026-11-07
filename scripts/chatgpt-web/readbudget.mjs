/**
 * The account's read wall, spent at the one door every backend GET passes.
 *
 * Measured 2026-11-07: four backend reads answer and the fifth is refused with
 * `Retry-After: 48`. One turn spends two or three of them (the send's tree
 * baseline, the reply read, the title walk), so metering only the host's own
 * `conversation` op undercounts and still touches the wall. One child process
 * per browser means this module is the one place all of them meet.
 *
 * A delivery read (the host's `open:true`) may spend the last token; an
 * observation read may not, so a turn that is owed is never starved by a pass.
 * `waitMs` is how long a caller must wait before its next token exists.
 */
export function createReadBudget({ perMinute = 3, burst = 2, now = () => Date.now() } = {}) {
  const rate = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 0
  const cap = Number.isFinite(burst) && burst >= 1 ? burst : 1
  let tokens = -1
  let at = 0

  const refill = () => {
    const stamp = now()
    if (tokens < 0) {
      tokens = cap
      at = stamp
      return
    }
    const gained = ((stamp - at) / 60_000) * rate
    if (gained > 0) {
      tokens = Math.min(cap, tokens + gained)
      at = stamp
    }
  }

  const floorFor = priority => (priority === 'delivery' ? 0 : rate > 0 ? 1 : 0)

  return {
    /** Unlimited when the rate is 0: no wall, no pacing. */
    get unlimited() { return !(rate > 0) },

    /** One read if the bucket allows it; the last token is kept for delivery. */
    take(priority = 'observation') {
      if (!(rate > 0)) return true
      refill()
      if (tokens < floorFor(priority) + 1) return false
      tokens -= 1
      return true
    },

    /** How long until `take(priority)` could succeed. Zero when it would now. */
    waitMs(priority = 'observation') {
      if (!(rate > 0)) return 0
      refill()
      const need = floorFor(priority) + 1 - tokens
      if (need <= 0) return 0
      return Math.ceil((need / rate) * 60_000)
    },

    /** Test seam: the fractional balance, refilled to `now`. */
    balance() {
      if (!(rate > 0)) return Infinity
      refill()
      return tokens
    },
  }
}
