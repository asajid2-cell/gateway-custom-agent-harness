import type { EffortLevel, EffortValue, NativeEffortLevel } from '../effort.js'

const FALLBACK_ORDER: NativeEffortLevel[] = [
  'high',
  'medium',
  'low',
  'minimal',
  'none',
]

export function clampGatewayEffort(
  nativeLevels: readonly NativeEffortLevel[],
  value: EffortValue | undefined,
): EffortValue | undefined {
  if (value === undefined || value === 'ultracode' || typeof value === 'number') {
    return value
  }
  if (nativeLevels.includes(value as NativeEffortLevel)) return value
  if (nativeLevels.length === 0) return undefined
  return FALLBACK_ORDER.find(level => nativeLevels.includes(level))
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
