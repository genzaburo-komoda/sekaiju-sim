// 強化・弱体・封じ・状態異常の決まり（2026-10-18、本人の説明と LP Archive Part 47）
import { describe, expect, it } from 'vitest'
import { findEnemy, skillsByJob } from '../data/gameData'
import { newMember, type Member } from './party'
import { targetFromEnemy } from './predict'
import { AILMENT_PRIORITY, ailmentReplaces, applyEffect, initialState, runTurn, seededRng, SimContext, type ActiveEffect, type BattleSetup } from './sim'
import { setSkillLevel } from './skills'

const eff = (skillId: string, stat: string, value: number, extra: Partial<ActiveEffect> = {}): ActiveEffect => ({ skillId, name: skillId, mods: [{ stat, value }], lastTurn: 9, oneShot: false, ...extra })

describe('強化と弱体の打ち消し（本人の説明）', () => {
  it('攻撃力UP がかかっているときに攻撃力DOWN を受けると、両方なくなる', () => {
    const [debuffs, buffs, canceled] = applyEffect([], [eff('song', 'physAtk', 20)], eff('sap', 'physAtk', 25))
    expect(canceled).toBe(true)
    expect(buffs).toEqual([])
    expect(debuffs).toEqual([])
  })
  it('逆の順番でも同じ。能力値が違えば打ち消さない', () => {
    expect(applyEffect([], [eff('sap', 'physAtk', 25)], eff('song', 'physAtk', 20))[2]).toBe(true)
    const [buffs, debuffs, canceled] = applyEffect([], [eff('slow', 'agi', 50)], eff('song', 'physAtk', 20))
    expect(canceled).toBe(false)
    expect(buffs).toHaveLength(1)
    expect(debuffs).toHaveLength(1)
  })
  it('打ち消せない強化（火竜の猛攻）は残る', () => {
    expect(applyEffect([], [eff('sap', 'physAtk', 25)], eff('strike', 'physAtk', 50, { special: true }))[2]).toBe(false)
  })
})

describe('状態異常の優先順位（Part 47。暫定）', () => {
  it('並びは 石化＞テラー＞呪い＞毒＞睡眠＞混乱＞麻痺＞盲目', () => {
    expect([...AILMENT_PRIORITY]).toEqual(['petrify', 'terror', 'curse', 'poison', 'sleep', 'confusion', 'paralysis', 'blind'])
  })
  it('毒に盲目はかからず、呪い・石化はかかる（英語 Wiki の例）', () => {
    expect(ailmentReplaces('poison', 'blind')).toBe(false)
    expect(ailmentReplaces('poison', 'curse')).toBe(true)
    expect(ailmentReplaces('poison', 'petrify')).toBe(true)
    expect(ailmentReplaces(null, 'blind')).toBe(true)
  })
})

function withSkills(jobId: string, level: number, skills: Record<string, number>, extra: Partial<Member> = {}): Member {
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(skillsByJob[jobId], alloc, id, lv)
  return { ...newMember([], jobId), level, skills: alloc, ...extra }
}

describe('封じ・睡眠・スタン（Part 47）', () => {
  const m = withSkills('swordsman', 30, { 'war-cry': 1 })
  const enemy = findEnemy('treerat')!
  const s: BattleSetup = { members: [m], difficulty: 'expert', enemy, target: targetFromEnemy(enemy), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [] }
  const ctx = new SimContext(s)

  it('腕封じは物理の攻撃のダメージを ×0.7 にする（STR −30% の近似）', () => {
    const a = initialState(s)
    const b = initialState(s)
    b.members[0].binds.arm = 5
    const plan = { [m.id]: 'normal' }
    const da = runTurn(ctx, a, { rng: null, plan, fallback: 'normal', log: true }).log!.entries[0].damage!
    const db = runTurn(ctx, b, { rng: null, plan, fallback: 'normal', log: true }).log!.entries[0].damage!
    expect(db).toBeLessThan(da)
  })

  it('スタンはそのターンだけ、起きたターンは行動できない', () => {
    const st = initialState(s)
    st.members[0].stunTurn = 1
    const r = runTurn(ctx, st, { rng: seededRng(1), plan: { [m.id]: 'normal' }, fallback: 'normal', log: true })
    expect(r.log!.entries[0].action).toBe('行動できない')
    const r2 = runTurn(ctx, r.state, { rng: seededRng(1), plan: { [m.id]: 'normal' }, fallback: 'normal', log: true })
    expect(r2.log!.entries[0].action).toBe('通常攻撃')
  })
})
