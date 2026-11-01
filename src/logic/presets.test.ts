import { describe, expect, it } from 'vitest'
import { equipmentAvailability, rules } from '../data/gameData'
import { formationError } from './party'
import { PRESET_LEVELS, presetParty } from './presets'
import { spTotal, spUsed } from './skills'

describe('おすすめパーティ（Lv10〜60）', () => {
  it.each(PRESET_LEVELS)('Lv%i：5人で、隊列と SP の決まりを守り、装備はそのレベルで手に入る物', (level) => {
    const ms = presetParty(level, 'expert')
    expect(ms).toHaveLength(5)
    expect(formationError(ms)).toBeNull()
    for (const m of ms) {
      expect(m.level).toBe(level)
      expect(spUsed(m.skills)).toBeGreaterThan(0)
      expect(spUsed(m.skills)).toBeLessThanOrEqual(spTotal(rules, level))
      for (const id of [m.weaponId, ...(m.armorIds ?? [])]) {
        if (!id) continue
        const a = equipmentAvailability[id]
        expect(a.stratum).not.toBeNull()
        expect(a.stratum!).toBeLessThanOrEqual(level / 10)
      }
    }
  }, 60000)

  it('レベルが上がると、ソードマンの武器の攻撃力は下がらない', async () => {
    const { findEquipment } = await import('../data/gameData')
    const atk = PRESET_LEVELS.map((l) => findEquipment(presetParty(l, 'expert')[0].weaponId)?.atk ?? 0)
    for (let i = 1; i < atk.length; i++) expect(atk[i]).toBeGreaterThanOrEqual(atk[i - 1])
  }, 60000)
})
