// 振り分け・ステータス計算のテスト。実際のソードマンのデータを使う。
import { describe, expect, it } from 'vitest'
import { findJob, rules, skillsByJob } from '../data/gameData'
import { defaultRow, formationError, newMember, removeError, rowChangeError, type Member, type Row } from './party'
import { setSkillLevel, spCost, spTotal, spUsed, type Allocation } from './skills'
import { baseStats, displayStats } from './stats'

const skills = skillsByJob['swordsman']
const job = findJob('swordsman')

describe('SP', () => {
  it('Lv1 で 3、Lv70 で 72（引退なし）', () => {
    expect(spTotal(rules, 1)).toBe(3)
    expect(spTotal(rules, 70)).toBe(72)
  })
})

describe('前提スキルの自動取得（A3）', () => {
  it('ハヤブサ駆けを取ると、ダブルアタックLv3 とその前提（剣・斧マスタリーLv5）も自動で取る', () => {
    const alloc = setSkillLevel(skills, {}, 'hayabusa', 1)
    expect(alloc).toEqual({ 'sword-mastery': 5, 'axe-mastery': 5, 'double-attack': 3, hayabusa: 1 })
    expect(spUsed(alloc)).toBe(14)
    expect(spCost(skills, {}, 'hayabusa', 1)).toBe(14)
  })

  it('すでに前提を満たしていれば、前提のレベルは変えない', () => {
    const alloc = setSkillLevel(skills, { 'sword-mastery': 10, 'tp-boost': 5 }, 'chase-fire', 2)
    expect(alloc).toEqual({ 'sword-mastery': 10, 'tp-boost': 5, 'chase-fire': 2 })
  })

  it('前提を下げると、満たさなくなった上位スキルは連鎖して 0 に戻る', () => {
    const full = setSkillLevel(skills, {}, 'hayabusa', 5)
    const lowered = setSkillLevel(skills, full, 'sword-mastery', 4)
    // ダブルアタックが外れ、それを前提にするハヤブサ駆けも外れる。斧マスタリーは残る
    expect(lowered).toEqual({ 'sword-mastery': 4, 'axe-mastery': 5 })
  })

  it('0 と最大レベルの範囲に収める', () => {
    expect(setSkillLevel(skills, {}, 'hp-boost', 15)).toEqual({ 'hp-boost': 10 })
    expect(setSkillLevel(skills, { 'hp-boost': 3 }, 'hp-boost', -1)).toEqual({})
  })
})

describe('ステータス', () => {
  it('分かっているレベルはそのままの値', () => {
    expect(baseStats(job, 1)).toEqual({ hp: 26, tp: 7, str: 9, vit: 9, agi: 7, luc: 9, tec: 6 })
    expect(baseStats(job, 70).hp).toBe(504)
  })

  it('間のレベルは直線補間して切り捨て（Lv25：Lv20 と Lv30 の中間）', () => {
    // HP は 131 と 200 の中間 165.5 → 165
    expect(baseStats(job, 25).hp).toBe(165)
  })

  it('Lv66・HP/TP ブーストLv10 で、ゲーム内の表示値（2026-09-30 確認）と一致する', () => {
    const alloc: Allocation = { 'hp-boost': 10, 'tp-boost': 10, 'atk-boost': 10, 'def-boost': 10 }
    expect(displayStats(job, 66, skills, alloc)).toEqual({ hp: 614, tp: 147, str: 73, vit: 73, agi: 58, luc: 73, tec: 51 })
  })
})

describe('隊列の決まり（前列1〜3人・後列0〜3人・パーティ1〜5人）', () => {
  /** 隊列だけ指定してパーティを作る */
  const party = (...rows: Row[]): Member[] =>
    rows.reduce<Member[]>((ms, row) => [...ms, { ...newMember(ms, 'swordsman'), row }], [])

  it('決まりを満たす編成はエラーなし', () => {
    expect(formationError(party('front'))).toBeNull()
    expect(formationError(party('front', 'front', 'front', 'back', 'back'))).toBeNull()
    expect(formationError(party('front', 'back', 'back', 'back'))).toBeNull()
  })

  it('前列0人・前列4人・後列4人はエラー', () => {
    expect(formationError(party('back'))).toContain('前列は1人以上')
    expect(formationError(party('front', 'front', 'front', 'front'))).toContain('前列は3人まで')
    expect(formationError(party('front', 'back', 'back', 'back', 'back'))).toContain('後列は3人まで')
  })

  it('前列が1人だけのとき、その人を後列に移したり外したりできない', () => {
    const ms = party('front', 'back')
    expect(rowChangeError(ms, ms[0].id, 'back')).toContain('前列は1人以上')
    expect(removeError(ms, ms[0].id)).toContain('前列は1人以上')
    expect(removeError(ms, ms[1].id)).toBeNull()
  })

  it('最後の1人は外せない', () => {
    const ms = party('front')
    expect(removeError(ms, ms[0].id)).toContain('1人以上')
  })

  it('新しいメンバーは前列に空きがあれば前列、なければ後列', () => {
    expect(defaultRow(party('front', 'front'))).toBe('front')
    expect(defaultRow(party('front', 'front', 'front'))).toBe('back')
  })
})

describe('ブーストの画面表示', () => {
  it('AGIブーストは画面の AGI に反映される（レンジャー Lv17・AGIブーストLv3 の実機値 AGI29 を再現）', () => {
    // レンジャーのデータはまだないので、Lv17 の素の値（Fandom の表）と AGIブーストの倍率（atwiki）で試す
    const ranger = { ...job, id: 'ranger-test', stats: [{ lv: 17, hp: 102, tp: 39, str: 23, vit: 20, agi: 26, luc: 28, tec: 23, confidence: 'confirmed' as const }] }
    const agiBoost = {
      ...skills.find((s) => s.id === 'atk-boost')!,
      id: 'agi-boost',
      effects: [{ type: 'passive-stat' as const, stat: 'agi' as const, param: 'rate' }],
      levels: [110, 111, 112, 113, 119, 120, 121, 122, 123, 130].map((rate, i) => ({ lv: i + 1, values: { rate } })),
    }
    expect(displayStats(ranger, 17, [agiBoost], { 'agi-boost': 3 })).toEqual({ hp: 102, tp: 39, str: 23, vit: 20, agi: 29, luc: 28, tec: 23 })
  })

  it('ATKブーストは画面の STR に反映されない（ソードマン Lv66 で確認）', () => {
    expect(displayStats(job, 66, skills, { 'atk-boost': 10 }).str).toBe(73)
  })
})

describe('ステータス表（全レベル）', () => {
  it('70レベル分そろっていて、Lv66 はゲーム内の値（HP473・TP98 は素の値）と一致', () => {
    expect(job.stats).toHaveLength(70)
    expect(baseStats(job, 66)).toEqual({ hp: 473, tp: 98, str: 73, vit: 73, agi: 58, luc: 73, tec: 51 })
  })
})
