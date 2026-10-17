// 状態異常・回復の最適化のテスト。小さなケースは手計算の正解と比べる（仕様書 C3・C4 の受け入れ条件）
import { describe, expect, it } from 'vitest'
import { skillsByJob } from '../data/gameData'
import { newMember } from './party'
import { healAmount, inflictChance, optimizeAilment, optimizeHeal, optimizePartyAilment } from './support'

const hexer = (level: number) => ({ ...newMember([], 'hexer'), level })
const medic = (level: number) => ({ ...newMember([], 'medic'), level })

describe('状態異常の付与率（5.4）', () => {
  it('判定値 × 呪言マスタリー × 耐性 × 難易度。100% で頭打ち、耐性 0 は無効', () => {
    expect(inflictChance(50, 110, 100, 100)).toBeCloseTo(0.55)
    expect(inflictChance(50, 100, 25, 100)).toBeCloseTo(0.125)
    expect(inflictChance(70, 130, 200, 100)).toBe(1)
    expect(inflictChance(70, 130, 0, 100)).toBe(0)
  })
})

describe('状態異常の最適化（C3）', () => {
  it('カースメーカー Lv1（SP3）の盲目：呪言マスタリー2（前提）＋幻惑の呪言1 で 50% × 111% = 55.5%', () => {
    const r = optimizeAilment(hexer(1), 'treerat', 'blind', 'expert')
    expect(r[0].skillId).toBe('hexer-blind-curse')
    expect(r[0].alloc).toEqual({ 'hexer-curse-mastery': 2, 'hexer-blind-curse': 1 })
    expect(r[0].value).toBeCloseTo(0.555)
  })

  it('カースメーカー Lv5（SP7）：マスタリー2・幻惑5 の 111% × 59% = 65.49% が最善（手計算）', () => {
    // マスタリー m（2以上）と幻惑 b で m + b ≤ 7 の候補：
    // (2,5) 111×59 = 65.49 / (3,4) 112×53 = 59.36 / (4,3) 113×52 = 58.76 / (5,2) 119×51 = 60.69 / (6,1) 120×50 = 60.00
    const r = optimizeAilment(hexer(5), 'treerat', 'blind', 'expert')
    expect(r[0].alloc).toEqual({ 'hexer-curse-mastery': 2, 'hexer-blind-curse': 5 })
    expect(r[0].value).toBeCloseTo(0.6549)
  })

  it('FOE の耐性（狂える角鹿：状態異常 25%）と難易度（BASIC 120%）がかかる', () => {
    expect(optimizeAilment(hexer(5), 'ragelope', 'blind', 'expert')[0].value).toBeCloseTo(0.6549 * 0.25)
    expect(optimizeAilment(hexer(5), 'treerat', 'blind', 'basic')[0].value).toBeCloseTo(0.6549 * 1.2)
    expect(optimizeAilment(hexer(5), 'treerat', 'blind', 'picnic')[0].value).toBe(1)
  })

  it('即死が効かないボス（スノードリフト：即死 0%）には 0%', () => {
    const r = optimizeAilment(hexer(70), 'fenrir', 'death', 'expert')
    for (const c of r) expect(c.value).toBe(0)
  })

  it('武器が必要なスキルは、その武器を持っていないと候補に出ない（スタンスマッシュは斧）', () => {
    const sword = { ...newMember([], 'swordsman'), level: 30, weaponId: null }
    expect(optimizeAilment(sword, 'treerat', 'stun', 'expert').some((c) => c.skillId === 'stun-smash')).toBe(false)
  })

  it('パーティ：2人とも 65.49% なら 1 − (1 − 0.6549)² = 88.09%', () => {
    const party = optimizePartyAilment([hexer(5), hexer(5)], 'treerat', 'blind', 'expert')
    expect(party.chance).toBeCloseTo(1 - (1 - 0.6549) ** 2)
  })

  it('同じ入力なら同じ結果', () => {
    expect(optimizeAilment(hexer(30), 'ragelope', 'bind-head', 'expert')).toEqual(optimizeAilment(hexer(30), 'ragelope', 'bind-head', 'expert'))
  })
})

describe('回復量（5.4）', () => {
  const skills = skillsByJob.medic
  const cure = skills.find((s) => s.id === 'medic-cure')!

  it('キュア Lv10：マスタリー1 で 91、マスタリー10 で 157（資料の値）、マスタリー5 は倍率 134% で補間して 119', () => {
    expect(healAmount(skills, cure, 10, { 'medic-heal-mastery': 1, 'medic-cure': 10 }, 'expert')!.amount).toBe(91)
    expect(healAmount(skills, cure, 10, { 'medic-heal-mastery': 10, 'medic-cure': 10 }, 'expert')!.amount).toBe(157)
    // 91 + (157 − 91) × (134 − 102) ÷ (175 − 102) = 119.93 → 119
    expect(healAmount(skills, cure, 10, { 'medic-heal-mastery': 5, 'medic-cure': 10 }, 'expert')!.amount).toBe(119)
  })

  it('PICNIC は回復 300%', () => {
    expect(healAmount(skills, cure, 1, { 'medic-heal-mastery': 1, 'medic-cure': 1 }, 'picnic')!.amount).toBe(54)
  })
})

describe('回復の最適化（C4）', () => {
  // メディック Lv3（SP5）。マスタリー m とスキルの組み合わせ（m + スキル ≤ 5）：
  //   キュア（前提 m1。m1 で 18〜、m10 で 31〜）：(1,キュア4) 36 / (2,3) 30 + 22×5/73 = 31.5 → 31 / (3,2) 24 + 19×10/73 = 26.6 → 26 / (4,1) 18 + 13×15/73 = 20.7 → 20
  //   キュアII（前提 m3。倍率 112%〜175%）：(3,キュアII 2) 87・11TP / (3,1) 80・10TP / (4,1) 80 + 46×5/63 = 83.7 → 83・10TP
  it('1ターンの総回復量：マスタリー3・キュアII 2 の 87', () => {
    const r = optimizeHeal(medic(3), 1, 'expert', { criterion: 'total', damage: 0, targets: 1 })
    expect(r[0].alloc).toEqual({ 'medic-heal-mastery': 3, 'medic-cure-2': 2 })
    expect(r[0].value).toBe(87)
    // キュアだけで見ると マスタリー1・キュア4 の 36
    expect(r.find((c) => c.skillId === 'medic-cure')!.alloc).toEqual({ 'medic-heal-mastery': 1, 'medic-cure': 4 })
    expect(r.find((c) => c.skillId === 'medic-cure')!.value).toBe(36)
  })

  it('TP1 あたり：マスタリー4・キュアII 1 の 83 ÷ 10 = 8.3（87 ÷ 11 = 7.9、80 ÷ 10 = 8.0、キュアは 36 ÷ 5 = 7.2）', () => {
    const r = optimizeHeal(medic(3), 1, 'expert', { criterion: 'per-tp', damage: 0, targets: 1 })
    expect(r[0].alloc).toEqual({ 'medic-heal-mastery': 4, 'medic-cure-2': 1 })
    expect(r[0].value).toBeCloseTo(8.3)
  })

  it('100 を全快する最小 TP：キュア 36 を 3回 × 5TP = 15（キュアII は 2回 × 10TP = 20、マスタリー3・キュア2 は 4回 × 4TP = 16）', () => {
    const r = optimizeHeal(medic(3), 1, 'expert', { criterion: 'min-tp', damage: 100, targets: 1 })
    expect(r[0].alloc).toEqual({ 'medic-heal-mastery': 1, 'medic-cure': 4 })
    expect(-r[0].value).toBe(15)
    expect(-r.find((c) => c.skillId === 'medic-cure-2')!.value).toBe(20)
  })

  it('継続回復（リジェネレート）と蘇生（リザレクション）は候補に出ない', () => {
    const r = optimizeHeal(medic(70), 5, 'expert', { criterion: 'total', damage: 0, targets: 1 })
    expect(r.map((c) => c.skillId)).not.toContain('medic-regenerate')
    expect(r.map((c) => c.skillId)).not.toContain('medic-resurrection')
    // 全体回復は人数分。Lv70 なら全部振れるので、エリアキュアII（マスタリー10 で 378）× 5人 = 1890 が最大
    expect(r[0].skillId).toBe('medic-area-cure-2')
    expect(r[0].value).toBe(378 * 5)
  })
})
