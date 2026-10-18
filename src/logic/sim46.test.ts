// 敵が行動するターン数シミュレーション（開発計画 4-6 の完了条件）：
// 敵の行動の条件（ターン・HP の割合など）どおりに行動し、味方の状態異常・封じが行動に反映される
import { describe, expect, it } from 'vitest'
import { findEnemy, skillsByJob } from '../data/gameData'
import { simulateEndurance, simulateKill } from './battle'
import { newMember, type Member } from './party'
import { targetFromEnemy } from './predict'
import { chooseEnemyAction, initialState, runTurn, seededRng, SimContext, type BattleSetup, type BattleState } from './sim'
import { setSkillLevel } from './skills'

function withSkills(jobId: string, level: number, skills: Record<string, number>, extra: Partial<Member> = {}): Member {
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(skillsByJob[jobId], alloc, id, lv)
  return { ...newMember([], jobId), level, skills: alloc, ...extra }
}

function aiSetup(enemyId: string, members: Member[]): BattleSetup {
  const enemy = findEnemy(enemyId)!
  return { members, difficulty: 'expert', enemy, target: targetFromEnemy(enemy), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [], enemyAi: true }
}

const party = () => [withSkills('swordsman', 70, { 'war-cry': 1, 'hp-boost': 10 }), withSkills('medic', 70, {}, { row: 'back' })]
/** 期待値で選ばれる敵の技（t ターン目、状態を手で変えて） */
function pickAt(ctx: SimContext, s: BattleState, turn: number, patch: (s: BattleState) => void = () => {}) {
  const st: BattleState = { ...s, turn, enemy: { ...s.enemy, ailments: { ...s.enemy.ailments }, buffs: [...s.enemy.buffs] } }
  patch(st)
  const c = chooseEnemyAction(ctx, st, null)!
  return c.kind === 'skill' ? c.id : c.kind === 'skip' ? `skip:${c.id}` : 'manual'
}

describe('敵の行動パターン（4-6）', () => {
  it('偉大なる赤竜：1・5・9ターン目はファイアブレス、ほかのターンは使わない', () => {
    const s = aiSetup('wyrm', party())
    const ctx = new SimContext(s)
    const st = initialState(s)
    expect([1, 5, 9].map((t) => pickAt(ctx, st, t))).toEqual(['searing', 'searing', 'searing'])
    expect([2, 3, 4, 6].map((t) => pickAt(ctx, st, t))).not.toContain('searing')
  })

  it('イワオロペネレプ：HP 70%〜40% はサンダーウィング、40% 未満はデスブリンガーかフェザースピアー', () => {
    const s = aiSetup('iwaopeln', party())
    const ctx = new SimContext(s)
    const st = initialState(s)
    expect(pickAt(ctx, st, 3, (x) => (x.enemy.hp = x.enemy.maxHp * 0.6))).toBe('voltwing')
    expect(['rockbeak', 'feathers']).toContain(pickAt(ctx, st, 3, (x) => (x.enemy.hp = x.enemy.maxHp * 0.3)))
  })

  it('災いの巨神：力溜めの次のターンは猪突猛進', () => {
    const s = aiSetup('armoth', party())
    const ctx = new SimContext(s)
    expect(pickAt(ctx, initialState(s), 4, (x) => (x.enemy.prev = 'charge'))).toBe('bullrush')
  })

  it('封じ：ゴーレムは腕を封じられると腕の技を選んで何もしない。クイーンアントは使える技から選び直す', () => {
    const g = aiSetup('golem', party())
    expect(pickAt(new SimContext(g), initialState(g), 3, (x) => (x.enemy.ailments['bind-arm'] = 5))).toBe('skip:hammer')
    const q = aiSetup('royalant', party())
    const rng = seededRng(1)
    const st = initialState(q)
    const ctx = new SimContext(q)
    for (let i = 0; i < 50; i++) {
      const c = chooseEnemyAction(ctx, { ...st, turn: 3, enemy: { ...st.enemy, ailments: { 'bind-arm': 5 } } }, rng)!
      expect(c.kind === 'skill' && c.id).not.toBe('hammer')
    }
  })

  it('世界樹の王：味方の強化が合計5以上で王の威厳を使い、味方の強化がすべて消える', () => {
    const members = [0, 1, 2, 3, 4].map((i) => withSkills('swordsman', 70, { 'war-cry': 1 }, { row: i < 3 ? 'front' : 'back' }))
    const s = aiSetup('etreant', members)
    const ctx = new SimContext(s)
    let st = initialState(s)
    // 1ターン目：全員ウォークライ（5人で強化5）
    st = runTurn(ctx, st, { rng: null, plan: Object.fromEntries(members.map((m) => [m.id, 'war-cry'])), fallback: 'normal', log: false }).state
    expect(st.members.reduce((n, f) => n + f.buffs.length, 0)).toBe(5)
    const r = runTurn(ctx, st, { rng: null, plan: Object.fromEntries(members.map((m) => [m.id, 'defend'])), fallback: 'normal', log: true })
    expect(r.log!.entries.some((e) => e.action === '王の威厳')).toBe(true)
    expect(r.state.members.every((f) => f.buffs.length === 0)).toBe(true)
    // 王の威厳の次のターンはサイクロンルーツ
    expect(pickAt(ctx, r.state, 3)).toBe('cyclone')
  })
})

describe('味方の状態異常・封じ（4-6）', () => {
  const s = aiSetup('wolf', [withSkills('swordsman', 30, { 'raging-edge': 1, 'war-cry': 1 })])
  const ctx = new SimContext(s)
  const id = s.members[0].id

  it('睡眠中は行動できない', () => {
    const st = initialState(s)
    st.members[0].ailment = { id: 'sleep', lastTurn: 5 }
    const r = runTurn(ctx, st, { rng: seededRng(2), plan: { [id]: 'war-cry' }, fallback: 'normal', log: true })
    const mine = r.log!.entries.filter((e) => e.actor === st.members[0].name)
    expect(mine[0].action).toBe('行動できない')
  })

  it('頭封じではウォークライ（頭）が使えず通常攻撃になる', () => {
    const st = initialState(s)
    st.members[0].binds.head = 5
    const r = runTurn(ctx, st, { rng: null, plan: { [id]: 'war-cry' }, fallback: 'normal', log: true })
    const mine = r.log!.entries.find((e) => e.actor === st.members[0].name)!
    expect(mine.action).toBe('通常攻撃')
    expect(mine.fallback).toContain('頭封じ')
  })

  it('毒はターンの終わりに決まったダメージ', () => {
    const st = initialState(s)
    st.members[0].ailment = { id: 'poison', lastTurn: 5, poison: 37 }
    const solo: BattleSetup = { ...s, enemyAi: false }
    const r = runTurn(new SimContext(solo), st, { rng: null, plan: { [id]: 'defend' }, fallback: 'defend', log: true })
    expect(st.members[0].hp - r.state.members[0].hp).toBe(37)
  })

  it('フォレスト・セルのネクローシス（即死 90%）で倒れる人が出る。同じシードなら同じ結果', () => {
    const members = party()
    const s2 = aiSetup('primevil', members)
    const policies = Object.fromEntries(members.map((m) => [m.id, 'defend']))
    const a = simulateEndurance(s2, policies, 6, 300, 7)
    expect(a).toEqual(simulateEndurance(s2, policies, 6, 300, 7))
    expect(a.wipeBy[5]).toBeGreaterThan(0.5)
  })

  it('敵が行動しても確率分布（B3）は同じシードで同じ結果', () => {
    const members = party()
    const s3 = aiSetup('wyvern', members)
    const plan = [Object.fromEntries(members.map((m) => [m.id, 'normal']))]
    expect(simulateKill(s3, plan, 300, 3)).toEqual(simulateKill(s3, plan, 300, 3))
  })
})
