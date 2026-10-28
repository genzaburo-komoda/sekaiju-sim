// 最初の画面の「サンプルの編成」（開発計画 U11）。
// ジョブと隊列は Claude が決めた例（前列：ソードマン・パラディン、後列：メディック・アルケミスト・バード）。
// Lv70 で、武器・防具・スキルは編成の探索と同じ作り方（そのジョブが持てる最も強い装備と、役割ごとの振り方の候補）にする。
// 役割は採点の基本の役割（火力・耐久→盾・回復・支援）
import { buildsFor, strongestArmor, type BuildKind } from './partysearch'
import { newMember, type DifficultyId, type Member, type Row } from './party'
import { defaultRole, standardTarget, type Role } from './score'
import type { BattleSetup } from './sim'

const SAMPLE: [string, Row][] = [
  ['swordsman', 'front'],
  ['paladin', 'front'],
  ['medic', 'back'],
  ['alchemist', 'back'],
  ['bard', 'back'],
]
const SAMPLE_LEVEL = 70
const KIND_FOR_ROLE: Record<Role, BuildKind> = { damage: 'damage', ailment: 'damage', heal: 'heal', endurance: 'guard', support: 'support' }

export function sampleParty(difficulty: DifficultyId): Member[] {
  const members: Member[] = []
  for (const [jobId, row] of SAMPLE) {
    const slot: Member = { ...newMember(members, jobId), level: SAMPLE_LEVEL, row }
    members.push(slot)
  }
  const setup: BattleSetup = { members, difficulty, enemy: null, target: standardTarget(SAMPLE_LEVEL), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [] }
  return members.map((m) => {
    const builds = buildsFor(m, m.jobId, setup, [])
    const b = builds.find((x) => x.kind === KIND_FOR_ROLE[defaultRole(m.jobId)]) ?? builds[0]
    return { ...m, skills: b.alloc, weaponId: b.weaponId, armorIds: strongestArmor(m.jobId) }
  })
}
