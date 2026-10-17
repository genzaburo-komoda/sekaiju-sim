// 戦闘シミュレーションのテスト（仕様書 B2・B3・B9、開発計画 4-1〜4-3 の完了条件）
// - 4-1：強化の持続と TP の消費が正しく追跡される
// - 4-2：同じシードで同じ分布
// - 4-3：敵の行動に対する生存ターン数が出る
import { describe, expect, it } from 'vitest'
import { skillsByJob } from '../data/gameData'
import { findMinTurns, policyAction, runPlan, simulateEndurance, simulateKill, type Plan } from './battle'
import { newMember, type Member } from './party'
import { memberStats, DEFAULT_TARGET } from './predict'
import { addEffect, initialState, SimContext, type ActiveEffect, type BattleSetup, type EnemyAction } from './sim'
import { setSkillLevel } from './skills'

function withSkills(jobId: string, level: number, skills: Record<string, number>, extra: Partial<Member> = {}): Member {
  const all = skillsByJob[jobId]
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(all, alloc, id, lv)
  return { ...newMember([], jobId), level, skills: alloc, ...extra }
}

const NORMAL: EnemyAction = { name: '通常攻撃', attack: 'str', element: 'bash', power: 100, target: 'single', weight: 1, accuracy: 90, normal: true }

function setup(members: Member[], hp: number, extra: Partial<BattleSetup> = {}): BattleSetup {
  return {
    members,
    difficulty: 'expert',
    enemy: null,
    target: { ...DEFAULT_TARGET, level: members[0].level, vit: 10 },
    manual: { hp, str: 0, tec: 0, agi: 0 },
    enemyActions: [],
    armor: {},
    ...extra,
  }
}

describe('強化の持続と TP（B2、4-1 の完了条件）', () => {
  const sword = withSkills('swordsman', 20, { 'war-cry': 1 })
  const id = sword.id
  const plan: Plan = [{ [id]: 'war-cry' }, ...Array.from({ length: 6 }, () => ({ [id]: 'normal' }))]
  const run = runPlan(setup([sword], 100000), plan)
  const maxTp = memberStats(sword).tp

  it('ウォークライ（TP 2）を使ったターンだけ TP が 2 減る', () => {
    expect(run.logs.map((l) => l.tp[id])).toEqual([maxTp - 2, maxTp - 2, maxTp - 2, maxTp - 2, maxTp - 2, maxTp - 2, maxTp - 2])
  })

  it('持続5ターン（使ったターンを含む）：1〜5ターン目に効いて、6ターン目には切れている', () => {
    expect(run.logs.map((l) => l.effects[id])).toEqual([
      ['ウォークライ Lv1（残り4）'],
      ['ウォークライ Lv1（残り3）'],
      ['ウォークライ Lv1（残り2）'],
      ['ウォークライ Lv1（残り1）'],
      [],
      [],
      [],
    ])
  })

  it('2〜5ターン目の通常攻撃は与ダメージ 110%、6ターン目からは強化なし', () => {
    const ctx = new SimContext(setup([sword], 100000))
    const buffed = ctx.attack(id, 'normal', 100, 110, 100, false)!.expected
    const plain = ctx.attack(id, 'normal', 100, 100, 100, false)!.expected
    expect(buffed).toBeGreaterThan(plain)
    const dmg = run.logs.map((l) => l.entries[0].damage)
    expect(dmg[0]).toBeUndefined()
    for (const t of [1, 2, 3, 4]) expect(dmg[t]).toBeCloseTo(buffed)
    for (const t of [5, 6]) expect(dmg[t]).toBeCloseTo(plain)
  })

  it('TP が足りなくなったら通常攻撃に変わる（レイジングエッジ TP 4 を続ける）', () => {
    const m = withSkills('swordsman', 20, { 'raging-edge': 1 }, { weaponId: 'sword-1' })
    const tp = memberStats(m).tp
    const uses = Math.floor(tp / 4)
    const r = runPlan(setup([m], 1e9), Array.from({ length: uses + 2 }, () => ({ [m.id]: 'raging-edge' })))
    expect(r.logs.map((l) => l.tp[m.id])).toEqual([...Array.from({ length: uses }, (_, i) => tp - 4 * (i + 1)), tp - 4 * uses, tp - 4 * uses])
    expect(r.logs[uses].entries[0].action).toBe('通常攻撃')
    expect(r.logs[uses].entries[0].fallback).toContain('TP 不足')
  })
})

describe('強化の枠（atwiki「システム」）', () => {
  const e = (skillId: string, lastTurn = 5): ActiveEffect => ({ skillId, name: skillId, mods: [], lastTurn, oneShot: false })
  it('3つまで。4つ目は古いものから消える', () => {
    let list: ActiveEffect[] = []
    for (const id of ['a', 'b', 'c', 'd']) list = addEffect(list, e(id))
    expect(list.map((x) => x.skillId)).toEqual(['b', 'c', 'd'])
  })
  it('同じスキルをかけ直すと置きかわり、持続が新しくなる', () => {
    const list = addEffect(addEffect([e('a', 3), e('b', 4)], e('a', 9)), e('c'))
    expect(list.map((x) => `${x.skillId}@${x.lastTurn}`)).toEqual(['b@4', 'a@9', 'c@5'])
  })
})

describe('行動順（5.4）', () => {
  it('遅い弱体（軟身の呪言、速度 ×0.5）は、そのターンの速い味方の攻撃には効かず、次のターンから効く', () => {
    const sword = withSkills('swordsman', 20, {}, { name: 'ソードマン' })
    const hexer = withSkills('hexer', 20, { 'hexer-soften-curse': 1 }, { name: 'カースメーカー' })
    const r = runPlan(setup([sword, hexer], 1e9), [
      { [sword.id]: 'normal', [hexer.id]: 'hexer-soften-curse' },
      { [sword.id]: 'normal', [hexer.id]: 'defend' },
    ])
    // 1ターン目：防御 → ソードマン → カースメーカー（呪言）の順
    expect(r.logs[0].entries.map((x) => x.actor)).toEqual([sword.name, hexer.name])
    const d1 = r.logs[0].entries[0].damage!
    const d2 = r.logs[1].entries.find((x) => x.actor === sword.name)!.damage!
    expect(d2).toBeGreaterThanOrEqual(d1)
    expect(r.logs[0].effects.enemy).toEqual(['軟身の呪言 Lv1（残り4）'])
  })
})

describe('撃破までの最小ターン数（B2）', () => {
  it('1人なら、全部の計画を試した最小ターン数と一致する（ソードマン Lv30：通常攻撃・レイジングエッジ・ヘルズクライ）', () => {
    const m = withSkills('swordsman', 30, { 'raging-edge': 5, 'hells-cry': 1 }, { weaponId: 'sword-1' })
    const actions = ['normal', 'raging-edge', 'hells-cry']
    const ctx = new SimContext(setup([m], 1))
    const e0 = ctx.attack(m.id, 'raging-edge', 100, 100, 100, false)!.expected
    const hp = Math.round(e0 * 5.5)
    const s = setup([m], hp)
    const maxTurns = 7
    // 全部の計画（3^7 通り）を期待値で実行し、最も早く倒せるターン
    let best = Infinity
    const walk = (plan: Plan) => {
      if (plan.length === maxTurns) {
        const r = runPlan(s, plan)
        if (r.killTurn !== null) best = Math.min(best, r.killTurn)
        return
      }
      for (const a of actions) walk([...plan, { [m.id]: a }])
    }
    walk([])
    const found = findMinTurns(s, maxTurns)
    expect(found.killTurn).toBe(best)
    expect(runPlan(s, found.plan).killTurn).toBe(best)
  })

  it('倒せないときは null', () => {
    const m = withSkills('swordsman', 1, {})
    expect(findMinTurns(setup([m], 1e9), 3).killTurn).toBeNull()
  })
})

describe('確率分布（B3、4-2 の完了条件）', () => {
  const m = withSkills('swordsman', 20, { 'war-cry': 1 })
  const plan: Plan = [{ [m.id]: 'war-cry' }, { [m.id]: 'normal' }, { [m.id]: 'normal' }, { [m.id]: 'normal' }]
  const ctx = new SimContext(setup([m], 1))
  const buffed = ctx.attack(m.id, 'normal', 100, 110, 100, false)!.expected

  it('同じシードなら同じ分布、違うシードなら違う分布', () => {
    const s = setup([m], Math.round(buffed * 2.5))
    expect(simulateKill(s, plan, 2000, 7)).toEqual(simulateKill(s, plan, 2000, 7))
    expect(simulateKill(s, plan, 2000, 7)).not.toEqual(simulateKill(s, plan, 2000, 8))
  })

  it('総ダメージの平均は期待値に近く、倒せる確率はターンとともに増える', () => {
    const s = setup([m], Math.round(buffed * 2.5))
    const r = simulateKill(s, plan, 10000, 1)
    expect(Math.abs(r.mean - buffed * 3) / (buffed * 3)).toBeLessThan(0.01)
    for (let i = 1; i < r.killBy.length; i++) expect(r.killBy[i]).toBeGreaterThanOrEqual(r.killBy[i - 1])
    expect(r.killBy[0]).toBe(0)
    expect(r.histogram.reduce((a, b) => a + b.p, 0)).toBeCloseTo(1)
  })
})

describe('耐久（B9、4-3 の完了条件）', () => {
  it('必ず一撃で倒れる攻撃なら、n ターン生き残る確率は (1 − 命中率)^n', () => {
    const m = withSkills('medic', 10, {})
    const s = setup([m], 1, { manual: { hp: 1, str: 9999, tec: 0, agi: 30 }, enemyActions: [NORMAL] })
    const ctx = new SimContext(s)
    const st = memberStats(m)
    // 命中率 = (敵AGI + 敵Lv + 500) ÷ (味方AGI + 味方Lv + 500) × 90%
    const p = ((30 + 10 + 500) / (st.agi + 10 + 500)) * 0.9
    const r = simulateEndurance(s, { [m.id]: 'defend' }, 4, 20000, 3)
    for (let n = 0; n < 4; n++) expect(r.members[0].aliveBy[n]).toBeCloseTo((1 - Math.min(1, p)) ** (n + 1), 1)
    expect(r.wipeBy[3]).toBeCloseTo(1 - r.members[0].survive)
    expect(ctx.es.str).toBe(9999)
  })

  it('同じシードなら同じ結果。防御すると生存ターンが延びる', () => {
    const members = [withSkills('paladin', 20, {}), withSkills('medic', 20, {}, { row: 'back' })]
    const s = setup(members, 1, { manual: { hp: 1, str: 60, tec: 0, agi: 20 }, enemyActions: [NORMAL] })
    const atk = Object.fromEntries(members.map((x) => [x.id, 'normal']))
    const def = Object.fromEntries(members.map((x) => [x.id, 'defend']))
    expect(simulateEndurance(s, def, 15, 500, 1)).toEqual(simulateEndurance(s, def, 15, 500, 1))
    const a = simulateEndurance(s, atk, 15, 3000, 1)
    const d = simulateEndurance(s, def, 15, 3000, 1)
    expect(d.members[0].meanTurns).toBeGreaterThan(a.members[0].meanTurns)
  })

  it('防御中は被ダメージ ×0.7（切り捨て）、後列は物理に強い', () => {
    const front = withSkills('paladin', 20, {})
    const back = { ...front, id: 'back', row: 'back' as const }
    const s = setup([front, back], 1, { manual: { hp: 1, str: 200, tec: 0, agi: 20 }, enemyActions: [NORMAL] })
    const ctx = new SimContext(s)
    const normal = ctx.enemyHit(NORMAL, front.id, 100, 100, 100, false, false).expected
    const guard = ctx.enemyHit(NORMAL, front.id, 100, 100, 100, true, false).expected
    expect(guard).toBeLessThan(normal * 0.71)
    expect(guard).toBeGreaterThan(normal * 0.69 - 1)
    expect(ctx.enemyHit(NORMAL, 'back', 100, 100, 100, false, false).expected).toBeLessThan(normal)
  })

  it('回復スキルは HP が 70% を下回る味方がいるときだけ使い、それ以外は防御', () => {
    const medic = withSkills('medic', 10, { 'medic-cure': 3 })
    const s = setup([medic], 1, { enemyActions: [NORMAL] })
    const ctx = new SimContext(s)
    const st = initialState(s)
    expect(policyAction(ctx, st, st.members[0], 'medic-cure')).toBe('defend')
    st.members[0].hp = Math.floor(st.members[0].maxHp * 0.5)
    expect(policyAction(ctx, st, st.members[0], 'medic-cure')).toBe('medic-cure')
  })
})
