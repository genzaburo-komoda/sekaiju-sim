// ダメージ計算のテスト。期待値はすべて手計算（計算過程をコメントに書く）。
import { describe, expect, it } from 'vitest'
import { findEquipment, findJob, formulas, skillsByJob } from '../data/gameData'
import { attackOptions, buildAttackInput, masteryRate, skillValues, type TargetSpec } from './attack'
import { calcDamage, levelCorrection, type AttackInput } from './damage'
import { displayStats } from './stats'

const skills = skillsByJob['swordsman']
const job = findJob('swordsman')
const flat: TargetSpec['vuln'] = { slash: 100, bash: 100, pierce: 100, fire: 100, ice: 100, volt: 100 }

/** 補正なしの物理攻撃（テストごとに必要な所だけ変える） */
function input(over: Partial<AttackInput> & { str?: number; weaponAtk?: number; vit?: number; level?: number; enemyLevel?: number } = {}): AttackInput {
  const { str = 20, weaponAtk = 0, vit = 10, level = 10, enemyLevel = 10, ...rest } = over
  return {
    kind: 'str',
    attacker: { level, str, tec: 10, atkBoostRate: 100, weaponAtk, masteryRate: 100, backRow: false, bow: false },
    power: 100,
    vuln: 100,
    atkBuffRate: 100,
    defender: { level: enemyLevel, vit, armorDef: 0, defBuffRate: 100 },
    critical: false,
    boostedNormal: false,
    guarding: false,
    formulas,
    difficulty: 'expert',
    ...rest,
  }
}

describe('ダメージの分岐（仕様書 5.1）', () => {
  it('ATK − DEF が 100 以下：乱数 +0〜5', () => {
    // ATK = 20、DEF = 0.5 × 10 = 5 → 15。乱数で 15〜20、期待値 17.5
    const r = calcDamage(input())
    expect([r.min, r.max]).toEqual([15, 20])
    expect(r.expected).toBeCloseTo(17.5)
  })

  it('ATK < DEF × 1.1：ATK ÷ 100 × 8〜12', () => {
    // ATK = 30、DEF = 0.5 × 58 = 29（30 < 31.9）→ 0.3 × 8〜12 = 2.4〜3.6 → 2〜3。乱数 +0〜5 で 2〜8
    const r = calcDamage(input({ str: 30, vit: 58 }))
    expect([r.min, r.max]).toEqual([2, 8])
  })

  it('DEF ≧ ATK：1〜5 で確定', () => {
    const r = calcDamage(input({ str: 10, vit: 40 }))
    expect([r.min, r.max]).toEqual([1, 5])
    expect(r.expected).toBeCloseTo(3)
  })

  it('100 超：±5%（切り上げ）', () => {
    // ATK = 200、DEF = 0 → 200。200 × 0.95 = 190、200 × 1.05 = 210
    const r = calcDamage(input({ str: 200, vit: 0 }))
    expect([r.min, r.max]).toEqual([190, 210])
    expect(r.expected).toBeCloseTo(200)
  })

  it('クリティカルは DEF を 0 に、BOOST した通常攻撃は ×2', () => {
    // ATK = 20、DEF = 0 → 20〜25 → ×2 で 40〜50
    const r = calcDamage(input({ critical: true, boostedNormal: true }))
    expect([r.min, r.max]).toEqual([40, 50])
  })

  it('術式は DEF が 0.25 倍、乱数 +0〜10', () => {
    // ATK = 2 × TEC 10 = 20、DEF = 0.25 × 10 = 2.5 → 17.5 を切り捨てて 17。乱数で 17〜27
    const r = calcDamage(input({ kind: 'tec' }))
    expect([r.min, r.max]).toEqual([17, 27])
  })
})

describe('レベル差補正と難易度補正', () => {
  it('表の端より外は端の値', () => {
    expect(levelCorrection(formulas, 70, 1).rate).toBe(110)
    expect(levelCorrection(formulas, 1, 70).rate).toBe(44)
    expect(levelCorrection(formulas, 16, 10)).toEqual({ diff: 6, rate: 102 })
  })

  it('レベル差 −3（88%）', () => {
    // 15〜20 × 0.88 = 13.2〜17.6 → 13〜17
    const r = calcDamage(input({ level: 7, enemyLevel: 10 }))
    expect([r.min, r.max]).toEqual([13, 17])
  })

  it('PICNIC（与ダメージ 500%）', () => {
    // 15〜20 × 5 = 75〜100
    const r = calcDamage(input({ difficulty: 'picnic' }))
    expect([r.min, r.max]).toEqual([75, 100])
  })
})

describe('ソードマンの攻撃を組み立てる', () => {
  // Lv66（素の STR 73）、ドヴェルグの魔剣（攻200・STR+14）、ATKブーストLv10（130%）、剣マスタリーLv10（130%）、レイジングエッジLv10（190%）
  const alloc = { 'atk-boost': 10, 'sword-mastery': 10, 'axe-mastery': 5, 'double-attack': 1, 'raging-edge': 10 }
  const weapon = findEquipment('sword-19')!
  const stats = displayStats(job, 66, skills, alloc, null, 127, weapon.bonuses)
  const target: TargetSpec = { level: 60, vit: 50, vuln: flat, guarding: false }
  const ctx = (optionId: string, boosted = false) => {
    const option = attackOptions(skills, alloc, weapon).find((o) => o.id === optionId)!
    return buildAttackInput({ level: 66, stats, row: 'front', skills, alloc, weapon, option, boosted, critical: false, atkBuffRate: 100, target, formulas, difficulty: 'expert' })!
  }

  it('武器の STR 補正がステータスに入る', () => {
    expect(weapon.name).toBe('ドヴェルグの魔剣')
    expect(stats.str).toBe(87)
    expect(masteryRate(skills, alloc, weapon)).toBe(130)
  })

  it('レイジングエッジ Lv10 の手計算と一致する', () => {
    // 攻撃時 STR = floor(87 × 1.3) = 113
    // ATK = (113 + 200 × 1.3) × 1.9 = 373 × 1.9 = 708.7、DEF = 0.5 × 50 = 25 → 683.7 → 683
    // 乱数 ±5%：ceil(683 × 0.95) = 649、ceil(683 × 1.05) = 718
    // レベル差 +6 → 102%：floor(649 × 1.02) = 661、floor(718 × 1.02) = 732
    const r = calcDamage(ctx('raging-edge').input)
    expect([r.min, r.max]).toEqual([661, 732])
    expect(r.steps.map((s) => s.label)).toEqual(['攻撃時の STR', '攻撃値 ATK（物理）', '防御値 DEF', '基礎ダメージ', '乱数', 'レベル差補正'])
  })

  it('BOOST すると5レベル上の倍率（Lv15 相当 216%）を使う', () => {
    expect(skillValues(skills.find((s) => s.id === 'raging-edge')!, 10, true)!.dmg).toBe(216)
    expect(skillValues(skills.find((s) => s.id === 'raging-edge')!, 3, true)!.dmg).toBe(skillValues(skills.find((s) => s.id === 'raging-edge')!, 8, false)!.dmg)
    expect(ctx('raging-edge', true).input.power).toBe(216)
  })

  it('剣が必要なスキルは斧では使えない', () => {
    const axe = findEquipment('axe-1')!
    const opt = attackOptions(skills, alloc, axe).find((o) => o.id === 'raging-edge')!
    expect(opt.unusable).toBe('剣が必要')
  })

  it('属性付きの武器の通常攻撃は物理＋属性', () => {
    const axe = findEquipment('axe-18')! // 壊炎の戦斧（攻200・STR+9・炎）
    const option = attackOptions(skills, alloc, axe)[0]
    const built = buildAttackInput({ level: 66, stats, row: 'front', skills, alloc, weapon: axe, option, boosted: false, critical: false, atkBuffRate: 100, target, formulas, difficulty: 'expert' })!
    expect(built.input.kind).toBe('hybrid')
    expect(built.elemElement).toBe('fire')
  })

  it('後列から剣で攻撃すると攻撃値（STR＋武器）が半分', () => {
    // (STR 20 + 武器 0) ÷ 2 = 10、DEF 5 → 5。乱数で 5〜10
    const r = calcDamage(input({ attacker: { level: 10, str: 20, tec: 10, atkBoostRate: 100, weaponAtk: 0, masteryRate: 100, backRow: true, bow: false } }))
    expect([r.min, r.max]).toEqual([5, 10])
  })

  it('実測（2026-10-12）：後列のカースメーカーの杖攻撃がひっかきモグラに 39', () => {
    // (STR 10 + 幸運の杖 78) ÷ 2 = 44、DEF 0.5 × 15 = 7.5 → 36。乱数で 36〜41、レベル差 +5（101%）で 36〜41
    const r = calcDamage(input({ level: 8, enemyLevel: 3, vit: 15, attacker: { level: 8, str: 10, tec: 16, atkBoostRate: 100, weaponAtk: 78, masteryRate: 100, backRow: true, bow: false } }))
    expect([r.min, r.max]).toEqual([36, 41])
    expect(39).toBeGreaterThanOrEqual(r.min)
  })

  it('実測（2026-10-12）：後列の弓は半分にならない。狂える角鹿（斬突壊 75%）にクリティカル 52', () => {
    // (STR 11 + 弓 88) × 0.75 = 74.25、クリティカルで DEF 0 → 74。乱数で 74〜79、レベル差 −10（66%）で 48〜52
    const r = calcDamage(input({ level: 2, enemyLevel: 12, vit: 26, vuln: 75, critical: true, attacker: { level: 2, str: 11, tec: 12, atkBoostRate: 100, weaponAtk: 88, masteryRate: 100, backRow: true, bow: true } }))
    expect(52).toBeGreaterThanOrEqual(r.min)
    expect(52).toBeLessThanOrEqual(r.max)
  })
})
