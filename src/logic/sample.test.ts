import { describe, expect, it } from 'vitest'
import { rules } from '../data/gameData'
import { formationError } from './party'
import { sampleParty } from './sample'
import { spTotal, spUsed } from './skills'

describe('サンプルの編成（U11）', () => {
  it('5人で、隊列の決まりと SP の上限を守る', () => {
    const ms = sampleParty('expert')
    expect(ms.map((m) => m.jobId)).toEqual(['swordsman', 'paladin', 'medic', 'alchemist', 'bard'])
    for (const m of ms) {
      expect(spUsed(m.skills)).toBeGreaterThan(0)
      expect(spUsed(m.skills)).toBeLessThanOrEqual(spTotal(rules, m.level))
    }
    expect(formationError(ms)).toBeNull()
  }, 60000)
})
