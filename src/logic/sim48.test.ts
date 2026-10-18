// 全滅率の上限つきの最短ターンの探索（開発計画 4-8 の完了条件）：
// 全滅率が上限以下の計画のうち、撃破ターンの期待値が最短のものが出る
import { describe, expect, it } from 'vitest'
import { findEnemy, skillsByJob, weaponsFor } from '../data/gameData'
import { checkPlan, findSafeMinTurns } from './battle'
import { newMember, type Member } from './party'
import { strongestArmor } from './partysearch'
import { targetFromEnemy } from './predict'
import type { BattleSetup } from './sim'
import { setSkillLevel } from './skills'

const mk = (jobId: string, row: 'front' | 'back', skills: Record<string, number>): Member => {
  let alloc = {}
  for (const [id, lv] of Object.entries(skills)) alloc = setSkillLevel(skillsByJob[jobId], alloc, id, lv)
  const weapon = [...weaponsFor(jobId)].sort((a, b) => (b.atk ?? 0) - (a.atk ?? 0))[0]
  return { ...newMember([], jobId), name: jobId, level: 60, row, skills: alloc, weaponId: weapon?.id ?? null, armorIds: strongestArmor(jobId) }
}

const iwao = findEnemy('iwaopeln')!
const party = [
  mk('paladin', 'front', { 'paladin-front-guard': 5, 'paladin-defense-formation': 5 }),
  mk('swordsman', 'front', { 'raging-edge': 10, 'war-cry': 5, 'sword-mastery': 10, 'atk-boost': 10 }),
  mk('medic', 'back', { 'medic-cure': 5, 'medic-area-cure': 3, 'medic-medical-defense': 3 }),
  mk('alchemist', 'back', { 'alchemist-ice': 10, 'alchemist-ice-mastery': 10 }),
  mk('bard', 'back', { 'bard-attack-song': 5, 'bard-defense-song': 5 }),
]
const setup: BattleSetup = { members: party, difficulty: 'expert', enemy: iwao, target: targetFromEnemy(iwao), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [], enemyAi: true }

describe('全滅率の上限つきの最短（4-8）', () => {
  const o = { maxTurns: 20, wipeLimit: 0.05, trials: 300, seed: 1 }
  const r = findSafeMinTurns(setup, o)

  it('選んだ計画は全滅率が上限以下で、上限以下の候補の中で倒すまでの期待値が最短', () => {
    expect(r.satisfied).toBe(true)
    const best = r.candidates[r.best]
    expect(best.check.wipeRate).toBeLessThanOrEqual(o.wipeLimit)
    for (const c of r.candidates) if (c.check.wipeRate <= o.wipeLimit && c.check.killRate > 0) expect(best.check.expectedTurns).toBeLessThanOrEqual(c.check.expectedTurns + 1e-9)
  })

  it('同じシードなら同じ結果', () => {
    expect(findSafeMinTurns(setup, o)).toEqual(r)
  })

  it('上限を 0% にして満たせなければ、全滅率が最も低い計画を選び、満たせなかったと返す', () => {
    const r0 = findSafeMinTurns(setup, { ...o, wipeLimit: -1 })
    expect(r0.satisfied).toBe(false)
    const min = Math.min(...r0.candidates.map((c) => c.check.wipeRate))
    expect(r0.candidates[r0.best].check.wipeRate).toBe(min)
  })

  it('敵が行動しなければ全滅しない', () => {
    const plain = { ...setup, enemyAi: false }
    const c = checkPlan(plain, [Object.fromEntries(party.map((m) => [m.id, 'normal']))], 30, 100, 1)
    expect(c.wipeRate).toBe(0)
    expect(c.killRate).toBe(1)
  })
})
