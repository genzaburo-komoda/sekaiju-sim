// 最大ダメージ最適化のテスト。小さなケースは手計算の正解と比べる（仕様書 C2 の受け入れ条件）
import { describe, expect, it } from 'vitest'
import { optimizeMaxDamage } from './optimize'
import { newMember } from './party'
import { DEFAULT_TARGET } from './predict'

// ソードマン Lv1（SP3、素の STR 9）、ショートソード（攻15）、同じレベルの敵（Lv1・VIT14 → DEF 7）
const member = { ...newMember([], 'swordsman'), level: 1, weaponId: 'sword-4' }
const target = { ...DEFAULT_TARGET, level: 1, vit: 14 }
const opts = { enemyCount: 1, preBuffed: false }

describe('最大ダメージの最適化（C2）', () => {
  const result = optimizeMaxDamage(member, target, 'expert', opts)

  it('SP3 の最善は 剣マスタリーLv1 ＋ レイジングエッジLv2（手計算）', () => {
    // 候補を手計算（レベル差 0 で補正 100%、ダメージ 100 以下なので乱数は +0〜5、期待値は +2.5）
    // a) 剣マスタリー1・レイジングエッジ2：(9 + 15×1.10) × 1.45 = 36.975 − 7 → 29 → 期待値 31.5
    // b) 剣マスタリー2・レイジングエッジ1：(9 + 15×1.11) × 1.40 = 35.91 − 7 → 28 → 30.5
    // c) 剣マスタリー1・レイジングエッジ1・ATKブースト1：floor(9×1.1) = 9 で a と同じ式の 1.40 倍 → 28 → 30.5
    const top = result[0]
    expect(top.attackId).toBe('raging-edge')
    expect(top.alloc).toEqual({ 'sword-mastery': 1, 'raging-edge': 2 })
    expect(top.spUsed).toBe(3)
    expect(top.expected).toBeCloseTo(31.5)
  })

  it('通常攻撃の最善は期待値 20.85（クリティカル5%込み）', () => {
    // 剣マスタリー3：9 + 15×1.12 = 25.8 − 7 → 18 → 18〜23、期待値 20.5
    // クリティカル（DEF 0）：25.8 → 25 → 25〜30、期待値 27.5
    // 0.95 × 20.5 + 0.05 × 27.5 = 20.85
    // 剣マスタリー1 でも 9 + 16.5 = 25.5 − 7 → 18、クリティカル 25 で同じ値になるので、SP の少ない 1 を選ぶ
    const normal = result.find((c) => c.attackId === 'normal')!
    expect(normal.expected).toBeCloseTo(20.85)
    expect(normal.alloc).toEqual({ 'sword-mastery': 1 })
  })

  it('SP が足りないスキル（トルネードは剣マスタリーLv5 が前提）は候補に出ない', () => {
    expect(result.some((c) => c.attackId === 'tornado')).toBe(false)
  })

  it('同じ入力なら同じ結果', () => {
    expect(optimizeMaxDamage(member, target, 'expert', opts)).toEqual(result)
  })

  it('Lv70 では全スキルを振れるので、敵が3体ならトルネードの左右も数える', () => {
    const strong = { ...member, level: 70 }
    const one = optimizeMaxDamage(strong, { ...target, level: 70 }, 'expert', { enemyCount: 1, preBuffed: false })
    const three = optimizeMaxDamage(strong, { ...target, level: 70 }, 'expert', { enemyCount: 3, preBuffed: false })
    const t1 = one.find((c) => c.attackId === 'tornado')!
    const t3 = three.find((c) => c.attackId === 'tornado')!
    expect(t3.expected).toBeGreaterThan(t1.expected)
    // 振ったスキルは SP の上限を超えない（Lv70 は SP72）
    for (const c of three) expect(c.spUsed).toBeLessThanOrEqual(72)
  })

  it('自己強化を事前にかけた前提なら、ウォークライも振る', () => {
    const strong = { ...member, level: 30 }
    const r = optimizeMaxDamage(strong, { ...target, level: 30 }, 'expert', { enemyCount: 1, preBuffed: true })
    expect(r[0].buffId).not.toBe('')
  })

  it('ハヤブサ駆けは同じ敵に2回当たらない：敵1体なら1回分、敵5体なら Lv10 の対象数 3〜4 の平均 3.5 回分', () => {
    const strong = { ...member, level: 70 }
    const t = { ...target, level: 70 }
    const one = optimizeMaxDamage(strong, t, 'expert', { enemyCount: 1, preBuffed: false })
    const five = optimizeMaxDamage(strong, t, 'expert', { enemyCount: 5, preBuffed: false })
    const h1 = one.find((c) => c.attackId === 'hayabusa')!
    const h5 = five.find((c) => c.attackId === 'hayabusa')!
    // 倍率はレイジングエッジと同じ（Lv10 で 190%）なので、敵1体なら同じ期待値
    expect(h1.expected).toBeCloseTo(one.find((c) => c.attackId === 'raging-edge')!.expected)
    expect(h5.expected).toBeCloseTo(h1.expected * 3.5)
  })
})
