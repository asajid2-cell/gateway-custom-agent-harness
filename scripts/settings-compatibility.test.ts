import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../src/utils/settings/types.js'
import { guardSettingsCompatibility } from '../src/utils/settings/validation.js'

// The guard logs both directions. These assertions read the returned report,
// which mirrors what is logged, so they do not depend on capturing the log.

describe('guardSettingsCompatibility', () => {
  test('records a known field the build accepts (added direction)', () => {
    const data: Record<string, unknown> = { model: 'sonnet' }
    const report = guardSettingsCompatibility(data, 'test.json')
    expect(report.acceptedFields).toContain('model')
    expect(report.unknownFields).toEqual([])
    expect(report.warnings).toEqual([])
  })

  test('reports an unknown field and keeps it (incompatible direction)', () => {
    const data: Record<string, unknown> = {
      model: 'opus',
      brandNewSetting: { on: true },
    }
    const report = guardSettingsCompatibility(data, 'test.json')
    expect(report.unknownFields).toContain('brandNewSetting')
    expect(report.acceptedFields).toContain('model')
    // passthrough keeps the field alive; the guard only reports it
    expect(data.brandNewSetting).toEqual({ on: true })
  })

  test('drops a value the schema silently swallows, naming it', () => {
    const data: Record<string, unknown> = {
      permissions: { defaultMode: 'auto', allow: ['Bash(ls:*)'] },
    }
    const report = guardSettingsCompatibility(data, 'test.json')
    const warning = report.warnings.find(
      w => w.path === 'permissions.defaultMode',
    )
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('auto')
    const permissions = data.permissions as Record<string, unknown>
    expect(permissions.defaultMode).toBeUndefined()
    // the rest of the file survives
    expect(permissions.allow).toEqual(['Bash(ls:*)'])
    expect(SettingsSchema().safeParse(data).success).toBe(true)
  })

  test('drops a value the schema rejects outright (a changed enum)', () => {
    const data: Record<string, unknown> = { effortLevel: 'not-a-level' }
    const report = guardSettingsCompatibility(data, 'test.json')
    expect(report.warnings.some(w => w.path === 'effortLevel')).toBe(true)
    expect(data.effortLevel).toBeUndefined()
    expect(SettingsSchema().safeParse(data).success).toBe(true)
  })

  test('drops a field whose type changed', () => {
    const data: Record<string, unknown> = { cleanupPeriodDays: 'soon' }
    const report = guardSettingsCompatibility(data, 'test.json')
    expect(report.warnings.some(w => w.path === 'cleanupPeriodDays')).toBe(true)
    expect(data.cleanupPeriodDays).toBeUndefined()
    expect(SettingsSchema().safeParse(data).success).toBe(true)
  })

  test('a valid file warns about nothing', () => {
    const data: Record<string, unknown> = {
      permissions: { defaultMode: 'plan' },
      model: 'sonnet',
    }
    const report = guardSettingsCompatibility(data, 'test.json')
    expect(report.warnings).toEqual([])
    expect(report.acceptedFields).toContain('permissions')
    expect(report.acceptedFields).toContain('model')
  })
})
