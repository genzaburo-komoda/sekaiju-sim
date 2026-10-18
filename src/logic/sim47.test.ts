// パーティのスキルの対応を広げる（開発計画 4-7 の完了条件）：
// 攻撃の補正と被ダメージの軽減のスキルが、行動の計画で選べて計算に効く
import { describe, expect, it } from 'vitest'
import { findEnemy, skillsByJob } from '../data/gameData'
import { levelCorrection } from './damage'
import { formulas } from '../data/gameData'
import { newMember, type Member } from './party'
import { targetFromEnemy } from './predict'
import { initialState, partyActions, runTurn, seededRng, SimContext, type BattleSetup, type EnemyAction } from './sim'
import { setSkillLevel } from './skills'

function withSkills(jobId: string, level: number, skills: Record<string, number>, extra: Partial<Member> = {}): Member {
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(skillsByJob[jobId], alloc, id, lv)
  return { ...newMember([], jobId), level, skills: alloc, ...extra }
}
const wolf = findEnemy('wolf')! // 炎が弱点（150%）
const setupOf = (members: Member[], extra: Partial<BattleSetup> = {}): BattleSetup => ({ members, difficulty: 'expert', enemy: wolf, target: targetFromEnemy(wolf), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [], ...extra })
const HIT: EnemyAction = { name: '通常攻撃', attack: 'str', element: 'bash', power: 100, target: 'single', weight: 1, accuracy: 1000, normal: true }

describe('攻撃の補正（4-7）', () => {
  const sword = withSkills('swordsman', 40, { 'chase-fire': 5 }, { name: 'ソード', weaponId: 'sword-2' })
  const bard = withSkills('bard', 40, { 'bard-fire-overture': 1 }, { name: 'バード', row: 'back' })
  const s = setupOf([sword, bard])
  const ctx = new SimContext(s)

  it('序曲は対象の味方を選べる（行動 ID「スキル@メンバー」）', () => {
    const ids = partyActions([sword, bard]).get(bard.id)!.map((a) => a.id)
    expect(ids).toContain(`bard-fire-overture@${sword.id}`)
    expect(ids).toContain(`bard-fire-overture@${bard.id}`)
  })

  it('火劇の序曲をかけると、炎が弱点の敵への通常攻撃が強くなる', () => {
    const plain = runTurn(ctx, initialState(s), { rng: null, plan: { [sword.id]: 'normal', [bard.id]: 'defend' }, fallback: 'normal', log: true })
    const t1 = runTurn(ctx, initialState(s), { rng: null, plan: { [sword.id]: 'defend', [bard.id]: `bard-fire-overture@${sword.id}` }, fallback: 'normal', log: false }).state
    const imbued = runTurn(ctx, t1, { rng: null, plan: { [sword.id]: 'normal', [bard.id]: 'defend' }, fallback: 'normal', log: true })
    const dmg = (l: typeof plain) => l.log!.entries.find((e) => e.actor === 'ソード')!.damage!
    expect(dmg(imbued)).toBeGreaterThan(dmg(plain) * 1.5)
  })

  it('チェイスファイア：炎の序曲の付いた味方の通常攻撃に追撃する', () => {
    // バードが自分に序曲をかけ、次のターンにソードがチェイス、バードが通常攻撃
    const t1 = runTurn(ctx, initialState(s), { rng: null, plan: { [sword.id]: 'defend', [bard.id]: `bard-fire-overture@${bard.id}` }, fallback: 'normal', log: false }).state
    const r = runTurn(ctx, t1, { rng: null, plan: { [sword.id]: 'chase-fire', [bard.id]: 'normal' }, fallback: 'normal', log: true })
    const e = r.log!.entries.find((x) => x.actor === 'バード')!
    expect(e.note).toContain('チェイスファイア')
  })

  it('ペイントレード：(最大HP − 今の HP) × スキル倍率 × レベル補正', () => {
    const hexer = withSkills('hexer', 40, { 'hexer-pain-trade': 1 }, { name: 'カース' })
    const s2 = setupOf([hexer])
    const st = initialState(s2)
    st.members[0].hp = st.members[0].maxHp - 100
    const r = runTurn(new SimContext(s2), st, { rng: null, plan: { [hexer.id]: 'hexer-pain-trade' }, fallback: 'normal', log: true })
    const rate = levelCorrection(formulas, 40, wolf.level).rate
    expect(r.log!.entries[0].damage).toBe(Math.floor(100 * (rate / 100)))
  })
})

describe('被ダメージの軽減（4-7）', () => {
  it('パリング Lv5（成功率 100%）は、その日の自分への攻撃を無効にする', () => {
    const pal = withSkills('paladin', 40, { 'paladin-parry': 5 }, { name: 'パラ' })
    const s = setupOf([pal], { enemyActions: [HIT], enemyAi: false })
    const r = runTurn(new SimContext(s), initialState(s), { rng: seededRng(3), plan: { [pal.id]: 'paladin-parry' }, fallback: 'defend', log: true })
    expect(r.log!.entries.some((e) => e.note === 'パリングで無効')).toBe(true)
    expect(r.state.members[0].hp).toBe(r.state.members[0].maxHp)
  })

  it('一寸の見切りは刀と青眼の構えが要り、構え中は攻撃を1度だけ無効にする', () => {
    const bushi = withSkills('bushido', 40, { 'bushido-issun-no-mikiri': 1 }, { name: 'ブシ', weaponId: 'katana-2' })
    const s = setupOf([bushi], { enemyActions: [HIT], enemyAi: false })
    const ctx = new SimContext(s)
    // 構えなし → 代わりの行動（防御）
    const r0 = runTurn(ctx, initialState(s), { rng: seededRng(1), plan: { [bushi.id]: 'bushido-issun-no-mikiri' }, fallback: 'defend', log: true })
    expect(r0.log!.entries.find((e) => e.actor === 'ブシ')!.fallback).toContain('構えがない')
    const t1 = runTurn(ctx, initialState(s), { rng: seededRng(1), plan: { [bushi.id]: 'bushido-seigan' }, fallback: 'defend', log: false }).state
    t1.members[0].hp = t1.members[0].maxHp
    const r = runTurn(ctx, t1, { rng: seededRng(1), plan: { [bushi.id]: 'bushido-issun-no-mikiri' }, fallback: 'defend', log: true })
    expect(r.log!.entries.some((e) => e.note === '一寸の見切りで無効')).toBe(true)
  })

  it('医術防御II（Lv10、50%）：期待値の計算では倒れる攻撃を受けても HP1 で残る', () => {
    const medic = withSkills('medic', 60, { 'medic-medical-defense-2': 10 }, { name: 'メディ' })
    const big: EnemyAction = { ...HIT, power: 100000 }
    const s = setupOf([medic], { enemyActions: [big], enemyAi: false })
    const r = runTurn(new SimContext(s), initialState(s), { rng: null, plan: { [medic.id]: 'medic-medical-defense-2' }, fallback: 'defend', log: false })
    expect(r.state.members[0].alive).toBe(true)
    expect(r.state.members[0].hp).toBe(1)
  })
})

describe('治療・補助（4-7）', () => {
  const medic = withSkills('medic', 40, { 'medic-refresh': 1, 'medic-bind-recovery': 5 }, { name: 'メディ' })
  const sword = withSkills('swordsman', 40, {}, { name: 'ソード' })
  const s = setupOf([sword, medic])
  const ctx = new SimContext(s)

  it('リフレッシュは味方全員の状態異常を治し、バインドリカバリは選んだ味方の封じを治す', () => {
    const st = initialState(s)
    st.members[0].ailment = { id: 'poison', lastTurn: 9, poison: 10 }
    st.members[0].binds = { head: 9, arm: 9 }
    const r1 = runTurn(ctx, st, { rng: null, plan: { [sword.id]: 'defend', [medic.id]: 'medic-refresh' }, fallback: 'defend', log: false })
    expect(r1.state.members[0].ailment).toBeNull()
    const r2 = runTurn(ctx, st, { rng: null, plan: { [sword.id]: 'defend', [medic.id]: `medic-bind-recovery@${sword.id}` }, fallback: 'defend', log: false })
    expect(r2.state.members[0].binds).toEqual({})
  })

  it('アザーズステップ：選んだ味方が、使ったレンジャーのすぐ後に動く', () => {
    const ranger = withSkills('ranger', 40, { 'ranger-others-step': 1 }, { name: 'レン' })
    const slow = withSkills('medic', 10, {}, { name: 'おそい' })
    const s2 = setupOf([ranger, slow, sword])
    const r = runTurn(new SimContext(s2), initialState(s2), { rng: null, plan: { [ranger.id]: `ranger-others-step@${slow.id}`, [slow.id]: 'normal', [sword.id]: 'normal' }, fallback: 'normal', log: true })
    expect(r.log!.entries.slice(0, 2).map((e) => e.actor)).toEqual(['レン', 'おそい'])
  })
})
