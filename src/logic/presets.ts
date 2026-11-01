// おすすめパーティ（2026-10-28 本人の依頼）：Lv10〜60 の10レベルごとに、ワンクリックで読み込める5人の編成。
// ジョブと隊列は Claude が決めた例（前列：ソードマン・パラディン、後列：メディック・アルケミスト・バード）。
// スキルは編成の探索と同じ作り方（役割ごとの振り方の候補。役割は採点の基本の役割：火力・盾・回復・支援）。
// 役割の振り方で SP が余るときは、耐久の最適な振り方、ほかの役割の振り方、炎・氷・雷が弱点の敵への最大ダメージの振り方、
// 味方にかける強化のスキルの順に、余った SP で足す（Claude 決定。弱点を突く術式や守りの歌も持たせるため）。
// 装備は、そのレベルで手に入る物の中から選ぶ（Claude 決定。推定）：
// - 入手できる階層が「レベル ÷ 10」以下（ひとつ前の階層のボスの Lv 18・28・38・46・56 を目安にした）
// - 買値が PRICE_CAP 以下（一番深い階層の装備の価格の上位 10% の境目を目安。Lv10 は第1階層の品が安いので 1,000 en）
// - 売っていない物は使わない（宝箱で手に入る物は使う）。入手の階層が分からない物も使わない
import { rules, skillsByJob } from '../data/gameData'
import { equipAllowsAtLevel, type EquipFilter } from './equipByLevel'
import { newMember, type DifficultyId, type Member, type Row } from './party'
import { buildsFor, mergeGreedy, strongestArmor, type BuildKind } from './partysearch'
import { defaultRole, memberOptimum, standardTarget, type Role } from './score'
import { optimizeMaxDamage } from './optimize'
import type { BattleSetup } from './sim'
import { spTotal } from './skills'

export const PRESET_LEVELS = [10, 20, 30, 40, 50, 60] as const
export type PresetLevel = (typeof PRESET_LEVELS)[number]


const JOBS: [string, Row][] = [
  ['swordsman', 'front'],
  ['paladin', 'front'],
  ['medic', 'back'],
  ['alchemist', 'back'],
  ['bard', 'back'],
]
const KIND_FOR_ROLE: Record<Role, BuildKind> = { damage: 'damage', ailment: 'damage', heal: 'heal', endurance: 'guard', support: 'support' }

/** そのレベルで使ってよい装備か（決まりは equipByLevel.ts） */
export function presetAllows(level: PresetLevel): EquipFilter {
  return equipAllowsAtLevel(level)
}

export function presetParty(level: PresetLevel, difficulty: DifficultyId): Member[] {
  const members: Member[] = []
  for (const [jobId, row] of JOBS) members.push({ ...newMember(members, jobId), level, row })
  const setup: BattleSetup = { members, difficulty, enemy: null, target: standardTarget(level), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [] }
  const allow = presetAllows(level)
  return members.map((m) => {
    const builds = buildsFor(m, m.jobId, setup, [], allow)
    const b = builds.find((x) => x.kind === KIND_FOR_ROLE[defaultRole(m.jobId)]) ?? builds[0]
    const armorIds = strongestArmor(m.jobId, allow)
    const skills = skillsByJob[m.jobId] ?? []
    const total = spTotal(rules, level)
    const endure = memberOptimum({ ...m, weaponId: b.weaponId, armorIds }, 'endurance', { difficulty, target: null, partySize: JOBS.length }).alloc
    let alloc = mergeGreedy(skills, b.alloc, endure, total)
    for (const other of builds) if (other !== b) alloc = mergeGreedy(skills, alloc, other.alloc, total)
    const member: Member = { ...m, weaponId: b.weaponId, armorIds }
    for (const el of ['fire', 'ice', 'volt'] as const) {
      const weak = { ...setup.target, vuln: { ...setup.target.vuln, [el]: 150 } }
      const c = optimizeMaxDamage(member, weak, difficulty, { enemyCount: 1, preBuffed: true })[0]
      if (c) alloc = mergeGreedy(skills, alloc, c.alloc, total)
    }
    const partyBuffs = skills.filter((s) => s.effects.some((e) => e.type === 'buff' && e.target !== 'self'))
    alloc = mergeGreedy(skills, alloc, Object.fromEntries(partyBuffs.map((s) => [s.id, s.maxLevel])), total)
    return { ...m, skills: alloc, weaponId: b.weaponId, armorIds }
  })
}
