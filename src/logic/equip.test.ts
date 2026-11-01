// 装備の枠（ステップ4-4）。枠の決まりは 2026-11-01 に本人がゲームで確かめたもの（防具はどの枠にも、1種類につき1つ）
import { describe, expect, it } from 'vitest'
import { equipment } from '../data/gameData'
import { ARMOR_SLOT_RULES, armorChoices, armorDefense, equipBonuses, gearAllows, hasShield, validArmorIds } from './equip'
import { newMember, type Member } from './party'
import { memberActions } from './sim'
import { memberStats } from './predict'

const byName = (name: string) => equipment.find((e) => e.name === name)!

describe('装備の枠', () => {
  it('防具は鎧53・盾13・兜12・小手16・靴12・アクセサリ40（atwiki の表の行数）', () => {
    const count = (slot: string) => equipment.filter((e) => e.slot === slot).length
    expect([count('armor'), count('shield'), count('helmet'), count('gloves'), count('boots'), count('accessory')]).toEqual([53, 13, 12, 16, 12, 40])
  })

  it('2〜4枠目はどの種類の防具も付けられる（2026-11-01 本人確認）', () => {
    for (let i = 0; i < 3; i++) {
      const kinds = new Set(armorChoices(i, 'paladin').map((e) => e.slot))
      for (const k of ['armor', 'shield', 'helmet', 'gloves', 'boots', 'accessory']) expect(kinds.has(k as never)).toBe(true)
    }
    expect(ARMOR_SLOT_RULES.every((r) => r.length === 6)).toBe(true)
  })

  it('防具は1種類につき1つ：ほかの枠と同じ種類は選べない', () => {
    const aspis = byName('アスピス').id
    expect(armorChoices(1, 'paladin', [aspis, null]).some((e) => e.slot === 'shield')).toBe(false)
    expect(armorChoices(1, 'paladin', [aspis, null]).some((e) => e.slot === 'armor')).toBe(true)
  })

  it('ジョブが付けられない防具・同じ種類の2つ目は外れる', () => {
    const aspis = byName('アスピス').id // パラディン専用の盾
    expect(validArmorIds([aspis, aspis, aspis], 'paladin')).toEqual([aspis, null, null])
    expect(validArmorIds([aspis, null, null], 'medic')).toEqual([null, null, null])
    expect(validArmorIds(undefined, 'medic')).toEqual([null, null, null])
  })

  it('防具の能力補正がステータスに入り、防御力を合計する', () => {
    const m: Member = { ...newMember([], 'swordsman'), level: 30, armorIds: [byName('バーサーカーメイル').id, null, byName('アダマース').id] }
    const plain = memberStats({ ...m, armorIds: [] })
    const st = memberStats(m)
    expect(st.str - plain.str).toBe(10) // バーサーカーメイル STR+10
    expect(armorDefense(m)).toBe(52 + 6)
    expect(equipBonuses(m).slashResist).toBe(15) // アダマース 斬突壊 耐性15%
  })

  it('盾を付けるとパラディンのガードが行動に出る', () => {
    const base: Member = { ...newMember([], 'paladin'), level: 20, skills: { 'paladin-front-guard': 1 } }
    const ids = (m: Member) => memberActions(m).map((a) => a.id)
    expect(hasShield(base)).toBe(false)
    expect(ids(base)).not.toContain('paladin-front-guard')
    const shielded = { ...base, armorIds: [byName('タージェ').id, null, null] }
    expect(hasShield(shielded)).toBe(true)
    expect(gearAllows(['shield'], shielded)).toBe(true)
    expect(ids(shielded)).toContain('paladin-front-guard')
  })
})
