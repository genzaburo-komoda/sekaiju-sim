// 2026-10-18 の Web 調査で直した計算（EO Wiki の HD版の記述、atwiki、DS版のスキルデータ）
import { describe, expect, it } from 'vitest'
import { findEnemy, formulas, skillsByJob } from '../data/gameData'
import { buildAttackInput, attackOptions } from './attack'
import { calcDamage } from './damage'
import { newMember, type Member } from './party'
import { memberStats, targetFromEnemy } from './predict'
import { initialState, runTurn, SimContext, targetDistribution, type BattleSetup, type EnemyAction } from './sim'
import { setSkillLevel } from './skills'

function withSkills(jobId: string, level: number, skills: Record<string, number>, extra: Partial<Member> = {}): Member {
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(skillsByJob[jobId], alloc, id, lv)
  return { ...newMember([], jobId), level, skills: alloc, ...extra }
}

describe('術式の攻撃値（EO Wiki の式と atwiki の「TEC×」の倍率）', () => {
  it('ATK =（2 × TEC + 術式攻撃力 × 属性マスタリー）× 倍率 ÷ 2。武器は使わない', () => {
    const alc = withSkills('alchemist', 70, { 'alchemist-inferno': 10, 'alchemist-fire-mastery': 5 }, { weaponId: 'staff-1' })
    const skills = skillsByJob.alchemist
    const option = attackOptions(skills, alc.skills, undefined).find((o) => o.id === 'alchemist-inferno')!
    const st = memberStats(alc)
    const built = buildAttackInput({ level: 70, stats: st, row: 'back', skills, alloc: alc.skills, weapon: undefined, option, boosted: false, critical: false, atkBuffRate: 100, target: { level: 70, vit: 0, vuln: { slash: 100, bash: 100, pierce: 100, fire: 100, ice: 100, volt: 100 }, guarding: false }, formulas, difficulty: 'expert' })!
    expect(built.input.attacker.weaponAtk).toBe(6) // 大爆炎 Lv10 の術式攻撃力（DS版）
    expect(built.input.attacker.masteryRate).toBe(119) // 炎マスタリー Lv5
    const r = calcDamage(built.input)
    // 2 × TEC + 6 × 1.19 に 560% ÷ 2 = 280% をかけ、DEF 0
    const atk = (2 * st.tec + 6 * 1.19) * 2.8
    expect(r.min).toBeGreaterThanOrEqual(Math.floor(atk * 0.9) - 1)
    expect(r.max).toBeLessThanOrEqual(Math.ceil(atk * 1.1) + 1)
  })
})

describe('シャドウエントリ（EO Wiki の HD版：その率で狙いの候補から外れる）', () => {
  it('Lv10（外れる率 80%）を使った味方は、狙われる確率が下がる', () => {
    const ranger = withSkills('ranger', 40, { 'ranger-shadow-entry': 10 }, { name: 'レン' })
    const sword = withSkills('swordsman', 40, {}, { name: 'ソード' })
    const wolf = findEnemy('wolf')!
    const s: BattleSetup = { members: [ranger, sword], difficulty: 'expert', enemy: wolf, target: targetFromEnemy(wolf), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [], enemyAi: false }
    const ctx = new SimContext(s)
    const st = initialState(s)
    const before = targetDistribution(ctx, st).get(ranger.id)!
    const after = runTurn(ctx, st, { rng: null, plan: { [ranger.id]: 'ranger-shadow-entry', [sword.id]: 'defend' }, fallback: 'defend', log: false }).state
    const p = targetDistribution(ctx, after).get(ranger.id)!
    expect(p).toBeCloseTo(before * 0.2)
  })
})

describe('回避できない状態（睡眠・脚封じ）', () => {
  it('眠っている味方には、敵の攻撃が必ず当たる', () => {
    const m = withSkills('medic', 10, {}, { name: 'メディ' })
    const NORMAL: EnemyAction = { name: '通常攻撃', attack: 'str', element: 'bash', power: 100, target: 'single', weight: 1, accuracy: 1, normal: true }
    const s: BattleSetup = { members: [m], difficulty: 'expert', enemy: null, target: { level: 10, vit: 10, vuln: { slash: 100, bash: 100, pierce: 100, fire: 100, ice: 100, volt: 100 }, guarding: false, enemyId: null }, manual: { hp: 1, str: 30, tec: 0, agi: 1 }, enemyActions: [NORMAL] }
    const ctx = new SimContext(s)
    const st = initialState(s)
    st.members[0].ailment = { id: 'sleep', lastTurn: 9 }
    expect(ctx).toBeDefined()
    const r = runTurn(ctx, st, { rng: () => 0.999, plan: { [m.id]: 'defend' }, fallback: 'defend', log: true, endless: true })
    expect(r.log!.entries.some((e) => e.actor === '敵' && e.damage !== undefined && e.damage > 0)).toBe(true)
  })
})

describe('最大HP の強化（2026-10-18 の実測）', () => {
  it('蛮族の行進曲で最大HP は上がるが、今の HP は増えない', () => {
    const bard = withSkills('bard', 40, { 'bard-hp-song': 10 }, { name: 'バード' })
    const wolf = findEnemy('wolf')!
    const s: BattleSetup = { members: [bard], difficulty: 'expert', enemy: wolf, target: targetFromEnemy(wolf), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [], enemyAi: false }
    const ctx = new SimContext(s)
    const st = initialState(s)
    const hp = st.members[0].hp
    const max = st.members[0].maxHp
    const after = runTurn(ctx, st, { rng: null, plan: { [bard.id]: 'bard-hp-song' }, fallback: 'defend', log: false }).state
    expect(after.members[0].maxHp).toBe(Math.floor((max * 150) / 100))
    expect(after.members[0].hp).toBe(hp)
  })
})
