// スキル振り分けの計算（画面から切り離した純粋な関数）。
// 仕様書 A1（SP カウンター）・A3（前提スキルの自動取得）に対応。
import type { ProgressionRules, Skill } from '../data/schema'

/** スキル ID → 振ったレベル（0 または未登録は未取得） */
export type Allocation = Record<string, number>

/** そのレベルで持っている SP の合計（Lv1 で初期SP、以後1レベルごとに増える）。retireBonus は引退ボーナスの SP */
export function spTotal(rules: ProgressionRules, level: number, retireBonus = 0): number {
  return rules.initialSp + (level - 1) * rules.spPerLevel + retireBonus
}

/** 振った SP の合計（スキル1レベルにつき SP1） */
export function spUsed(alloc: Allocation): number {
  return Object.values(alloc).reduce((sum, lv) => sum + lv, 0)
}

function byId(skills: Skill[]): Map<string, Skill> {
  return new Map(skills.map((s) => [s.id, s]))
}

/** 前提スキルをすべて満たしているか */
export function prerequisitesMet(skill: Skill, alloc: Allocation): boolean {
  return skill.prerequisites.every((p) => (alloc[p.skillId] ?? 0) >= p.level)
}

/** 前提を満たさなくなったスキルを 0 に戻す（前提を下げたときの連鎖。0 になったスキルを前提にするものも続けて戻す） */
function dropUnmet(skills: Skill[], alloc: Allocation): Allocation {
  const next = { ...alloc }
  let changed = true
  while (changed) {
    changed = false
    for (const s of skills) {
      if ((next[s.id] ?? 0) > 0 && !prerequisitesMet(s, next)) {
        next[s.id] = 0
        changed = true
      }
    }
  }
  return next
}

/**
 * スキルを指定レベルにしたあとの振り分けを返す（元の振り分けは変えない）。
 * - 上げるとき：足りない前提スキルを必要レベルまで自動で上げる（前提の前提も同様）
 * - 下げるとき：前提を満たさなくなった上位スキルを 0 に戻す
 */
export function setSkillLevel(skills: Skill[], alloc: Allocation, skillId: string, target: number): Allocation {
  const map = byId(skills)
  const skill = map.get(skillId)
  if (!skill) throw new Error(`スキル「${skillId}」がありません`)
  const level = Math.max(0, Math.min(skill.maxLevel, Math.round(target)))
  const current = alloc[skillId] ?? 0
  let next: Allocation = { ...alloc }

  if (level > current) {
    // 前提を満たすまで再帰的に上げる
    const ensure = (id: string, need: number, seen: Set<string>) => {
      if (seen.has(id)) return // データの循環は検査で弾いているが、念のため
      seen.add(id)
      const s = map.get(id)
      if (!s) return
      for (const p of s.prerequisites) ensure(p.skillId, p.level, new Set(seen))
      if ((next[id] ?? 0) < need) next[id] = need
    }
    for (const p of skill.prerequisites) ensure(p.skillId, p.level, new Set([skillId]))
    next[skillId] = level
  } else {
    next[skillId] = level
    next = dropUnmet(skills, next)
  }
  // 0 のものは消して見通しをよくする
  for (const id of Object.keys(next)) if (next[id] === 0) delete next[id]
  return next
}

/** 指定レベルにしたとき、SP がいくつ増減するか（前提スキルの自動取得分を含む） */
export function spCost(skills: Skill[], alloc: Allocation, skillId: string, target: number): number {
  return spUsed(setSkillLevel(skills, alloc, skillId, target)) - spUsed(alloc)
}
