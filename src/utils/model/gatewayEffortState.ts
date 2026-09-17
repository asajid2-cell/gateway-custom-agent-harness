import type { EffortLevel, EffortValue, NativeEffortLevel } from '../effort.js'

/**
 * Normalize a selected value against the model's own ladder. A value the model
 * does not implement resolves to `undefined`, which means "send no effort
 * parameter and let the provider default govern" — never a different level.
 * Substituting a nearby level (the old high/medium/low fallback order) changed
 * the request in a way the user could neither see nor refuse.
 */
export function clampGatewayEffort(
  nativeLevels: readonly NativeEffortLevel[],
  value: EffortValue | undefined,
): EffortValue | undefined {
  if (value === undefined || value === 'ultracode' || typeof value === 'number') {
    return value
  }
  if (!nativeLevels.includes(value as NativeEffortLevel)) return undefined
  return value
}

/**
 * The launch default for a model, mirroring scripts/cc.ps1
 * Resolve-DefaultGatewayEffort so the picker's "(default)" label and the level a
 * fresh session actually starts on cannot disagree: prefer medium, then high,
 * then the model's first (lowest) level. Models with no ladder get no default
 * because cc.ps1 passes no --effort for them.
 */
export function defaultGatewayEffortForLevels(
  nativeLevels: readonly NativeEffortLevel[],
): EffortLevel | undefined {
  if (nativeLevels.length === 0) return undefined
  if (nativeLevels.includes('medium')) return 'medium'
  if (nativeLevels.includes('high')) return 'high'
  return nativeLevels[0]
}

export function cycleGatewayEffort(
  current: EffortLevel,
  direction: 'left' | 'right',
  supportedLevels: readonly EffortLevel[],
): EffortLevel {
  const levels = [...supportedLevels]
  if (levels.length === 0) return 'ultracode'

  const index = levels.indexOf(current)
  const currentIndex = index !== -1
    ? index
    : Math.max(levels.indexOf('high'), levels.indexOf('ultracode'))

  return direction === 'right'
    ? levels[(currentIndex + 1) % levels.length]!
    : levels[(currentIndex - 1 + levels.length) % levels.length]!
}

export function resolveGatewayEffortAfterModelSwitch(
  nativeLevels: readonly NativeEffortLevel[],
  current: EffortLevel | undefined,
  defaultCandidate: EffortValue | undefined,
  sessionEffort: EffortValue | undefined,
  hasToggledEffort: boolean,
): EffortLevel | undefined {
  const candidate =
    !hasToggledEffort && sessionEffort === undefined
      ? defaultCandidate
      : current

  if (candidate === undefined) return undefined
  return clampGatewayEffort(nativeLevels, candidate) as EffortLevel | undefined
}
