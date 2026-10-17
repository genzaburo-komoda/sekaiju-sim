// 採点・改善案・次に振るスキル・役割バランスのテスト（仕様書 C5・C6・B6・B8）
import { describe, expect, it } from 'vitest'
import { enemies } from '../data/gameData'
import { newMember, type Member } from './party'
import {
  exploreChecklist,
  improvements,
  memberOptimum,
  nextSkills,
  scoreMember,
  scoreParty,
  standardTarget,
  WEIGHT_PRESETS,
  type MemberAxis,
} from './score'

const boss = WEIGHT_PRESETS.find((p) => p.id === 'boss')!.weights
const make = (jobId: string, level: number, extra: Partial<Member> = {}): Member => ({ ...newMember([], jobId), level, ...extra })
const settings = (partySize: number) => ({ difficulty: 'expert' as const, target: null, partySize })

/** その軸の最適な振り方にしたメンバー */
function optimized(m: Member, axis: MemberAxis, partySize: number): Member {
  return { ...m, skills: memberOptimum(m, axis, settings(partySize)).alloc }
}

describe('標準敵', () => {
  it('同じレベル・耐性は等倍・VIT はレベル ±5 以内の敵の中央値', () => {
    const t = standardTarget(20)
    expect(t.level).toBe(20)
    expect(Object.values(t.vuln).every((v) => v === 100)).toBe(true)
    const vits = enemies.filter((e) => Math.abs(e.level - 20) <= 5).map((e) => e.vit).sort((a, b) => a - b)
    expect(t.vit).toBe(vits[Math.floor((vits.length - 1) / 2)])
  })
})

describe('採点（C5）', () => {
  const sword = make('swordsman', 20, { weaponId: 'sword-4' })
  const medic = make('medic', 20)
  const hexer = make('hexer', 20)

  it('役割の最適構築を入力すると、メンバーも総合も 100 点（受け入れ条件）', () => {
    const members = [optimized(sword, 'damage', 3), optimized(medic, 'heal', 3), optimized(hexer, 'ailment', 3)]
    const r = scoreParty(members, {}, boss, settings(3))
    for (const x of r.members) expect(x.roleScore).toBeCloseTo(100)
    expect(r.axes.damage).toBeCloseTo(100)
    expect(r.axes.heal).toBeCloseTo(100)
    expect(r.axes.ailment).toBeCloseTo(100)
    expect(r.total).toBeCloseTo(100)
  })

  it('何も振っていないソードマンの火力は、通常攻撃 ÷ 最適値 × 100', () => {
    const x = scoreMember(sword, 'damage', settings(1))
    expect(x.roleScore).toBeGreaterThan(0)
    expect(x.roleScore).toBeLessThan(100)
    expect(x.roleScore).toBeCloseTo((x.axes.damage.current / x.axes.damage.optimum.value) * 100)
  })

  it('その行動ができないジョブの軸は点数を出さない（ソードマンは回復スキルがない）', () => {
    expect(scoreMember(sword, 'damage', settings(1)).axes.heal.score).toBeNull()
  })

  it('探索重視では探索のチェックリストも入る：レンジャーの採掘・伐採・採取・警戒歩行で 100 点', () => {
    const ranger = make('ranger', 20, {
      skills: { 'ranger-mining': 1, 'ranger-logging': 1, 'ranger-gathering': 1, 'ranger-preemptive-boost': 3, 'ranger-cautious-walk': 1 },
    })
    expect(exploreChecklist([ranger]).every((e) => e.have === ranger.name)).toBe(true)
    const r = scoreParty([ranger], {}, WEIGHT_PRESETS.find((p) => p.id === 'explore')!.weights, settings(1))
    expect(r.axes.explore).toBe(100)
  })

  it('耐久・支援の役割は採点に入れず、理由を出す', () => {
    const r = scoreParty([make('paladin', 20)], {}, boss, settings(1))
    expect(r.total).toBeNull()
    expect(r.reasons.some((t) => t.includes('採点に入れていません'))).toBe(true)
  })
})

describe('改善案（C6）', () => {
  it('改善案を当てはめると、実際に点数が上がる（受け入れ条件）', () => {
    // ソードマン Lv20：わざと火力に効かないスキル（HPブースト）に振っておく
    const m = make('swordsman', 20, { weaponId: 'sword-4', skills: { 'hp-boost': 10, 'sword-mastery': 1 } })
    const s = settings(1)
    const opt = memberOptimum(m, 'damage', s).value
    const before = scoreMember(m, 'damage', s).roleScore!
    const ideas = improvements(m, 'damage', s, opt)
    expect(ideas.length).toBeGreaterThan(0)
    for (const idea of ideas) {
      const after = scoreMember({ ...m, skills: idea.alloc }, 'damage', s).roleScore!
      expect(after).toBeGreaterThan(before)
      expect(after).toBeCloseTo(idea.after)
    }
  })

  it('最適構築なら改善案は出ない', () => {
    const m = optimized(make('hexer', 20), 'ailment', 1)
    expect(improvements(m, 'ailment', settings(1), memberOptimum(m, 'ailment', settings(1)).value)).toEqual([])
  })
})

describe('次に振るスキル（B6）', () => {
  it('前提スキルを含めた SP で評価し、残りの SP で振れないものは出さない', () => {
    // メディック Lv1（SP3）、何も振っていない：キュアは回復マスタリー1 が前提なので 2SP
    const m = make('medic', 1)
    const s = settings(1)
    const optima = { damage: memberOptimum(m, 'damage', s).value, ailment: 0, heal: memberOptimum(m, 'heal', s).value }
    const list = nextSkills(m, s, optima)
    const cure = list.find((x) => x.skillId === 'medic-cure')!
    expect(cure.cost).toBe(2)
    expect(cure.gains.heal).toBeGreaterThan(0)
    // キュアII は回復マスタリー3 が前提で 4SP 必要（SP3 では振れない）
    expect(list.some((x) => x.skillId === 'medic-cure-2')).toBe(false)
  })
})

describe('役割バランス（B8）', () => {
  it('軸ごとにメンバーの最高点。耐久は未実装', () => {
    const r = scoreParty([optimized(make('medic', 20), 'heal', 1)], {}, boss, settings(1))
    expect(r.balance.heal).toBeCloseTo(100)
    expect(r.balance.endurance).toBeNull()
  })
})
