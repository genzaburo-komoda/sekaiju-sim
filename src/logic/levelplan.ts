// レベル進行プラン（仕様書 B7）：Lv1 から目標のレベルまで、どの順でスキルを振るか。
//
// 考え方（2026-10-18、Claude 決定）：
// - スキルは上げるだけで下げない。こうすると途中で振り直しが要らない（仕様書「振り直し不要な順序を優先」）
// - 評価値は採点と同じ（火力・状態異常・回復・耐久のどれか。敵は各レベルの標準敵）
// - 各レベルで、SP 1 あたりの評価値の伸びが最も大きい振り方を選ぶ（前提スキルも含めた SP で比べる。貪欲法の近似解）
// - 今の SP で届く「伸びる振り方」が無く、もっと SP があれば伸びる振り方があるときは、SP を残しておく（ゲームでは SP を貯められる）
// - 2つのやり方：
//   - 目標なし：その軸に効くスキルの中から自由に選ぶ（各レベルの評価値の合計を大きくする。最後の振り方は決めない）
//   - 目標あり：各レベルの振り方を目標の振り方（今の振り方など）の一部にする。評価値に効かないスキル（探索スキルなど）は、効くスキルを振り終えてから振る
import { rules, skillsByJob } from '../data/gameData'
import type { Member } from './party'
import { retireSpBonus } from './retire'
import { memberValue, relevantSkills, type MemberAxis, type ScoreSettings } from './score'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'

export interface PlanStep {
  level: number
  /** このレベルで持っている SP の合計 */
  spTotal: number
  /** このレベルで振ったスキル（前提スキルの自動取得を含む） */
  raised: { skillId: string; name: string; from: number; to: number }[]
  /** このレベルの終わりの振り方 */
  alloc: Allocation
  /** 使わずに残している SP */
  banked: number
  /** 評価値（このレベル・この振り方・このレベルの標準敵） */
  value: number
}

export interface LevelPlan {
  steps: PlanStep[]
  /** 目標の振り方（目標なしなら null） */
  target: Allocation | null
  /** 目標の振り方の SP がそのレベルの SP を超えているなど、計画できないときの理由 */
  error: string | null
}

const within = (alloc: Allocation, target: Allocation) => Object.entries(alloc).every(([id, lv]) => lv <= (target[id] ?? 0))

/** Lv1 から toLevel まで、目標の振り方 target（null は目標なし）に向かう振り順 */
export function levelPlan(member: Member, axis: MemberAxis, target: Allocation | null, toLevel: number, s: ScoreSettings): LevelPlan {
  const skills = skillsByJob[member.jobId] ?? []
  const bonus = retireSpBonus(rules, member.retire)
  const need = target ? spUsed(target) : 0
  if (need > spTotal(rules, toLevel, bonus)) return { steps: [], target, error: `目標の振り方は SP ${need} が必要で、Lv${toLevel} の SP（${spTotal(rules, toLevel, bonus)}）では足りません` }
  // 目標なしなら、その軸に効くスキルを最大レベルまで上げてよい
  const limit: Allocation = target ?? Object.fromEntries(relevantSkills(member, axis).map((x) => [x.id, x.maxLevel]))
  const allowed = (alloc: Allocation) => (target ? within(alloc, target) : true)
  const names = new Map(skills.map((x) => [x.id, x.name]))
  const value = (alloc: Allocation, level: number) => memberValue({ ...member, level, skills: alloc }, axis, s)

  let alloc: Allocation = {}
  const steps: PlanStep[] = []
  for (let level = 1; level <= toLevel; level++) {
    const total = spTotal(rules, level, bonus)
    const before = alloc
    // 同じレベルの中で振り方が変わるたびに評価し直す
    for (;;) {
      const bank = total - spUsed(alloc)
      if (bank <= 0) break
      const now = value(alloc, level)
      let best: { alloc: Allocation; gain: number; cost: number } | null = null
      let wantsMore = false
      for (const id of Object.keys(limit)) {
        for (let lv = (alloc[id] ?? 0) + 1; lv <= limit[id]; lv++) {
          const next = setSkillLevel(skills, alloc, id, lv)
          if (!allowed(next)) break
          const cost = spUsed(next) - spUsed(alloc)
          const gain = value(next, level) - now
          if (cost > bank) {
            if (gain > 1e-9) wantsMore = true
            break
          }
          if (gain <= 1e-9) continue
          const better = !best || gain / cost > best.gain / best.cost + 1e-12 || (Math.abs(gain / cost - best.gain / best.cost) <= 1e-12 && cost < best.cost)
          if (better) best = { alloc: next, gain, cost }
        }
      }
      if (best) {
        alloc = best.alloc
        continue
      }
      if (wantsMore || !target) break
      // 評価値に効くものが残っていない：残りの目標のスキルを振る
      const rest = Object.keys(target).find((id) => {
        if ((alloc[id] ?? 0) >= target[id]) return false
        const next = setSkillLevel(skills, alloc, id, (alloc[id] ?? 0) + 1)
        return within(next, target) && spUsed(next) - spUsed(alloc) <= bank
      })
      if (!rest) break
      alloc = setSkillLevel(skills, alloc, rest, (alloc[rest] ?? 0) + 1)
    }
    const raised = Object.keys(alloc)
      .filter((id) => (alloc[id] ?? 0) > (before[id] ?? 0))
      .map((id) => ({ skillId: id, name: names.get(id) ?? id, from: before[id] ?? 0, to: alloc[id] }))
    steps.push({ level, spTotal: total, raised, alloc, banked: total - spUsed(alloc), value: value(alloc, level) })
  }
  return { steps, target, error: null }
}

/** 振り順をテキストにする（「Lv3：キュア 1→2」の形） */
export function planText(jobName: string, plan: LevelPlan): string {
  const lines = [`${jobName}のレベル進行プラン`]
  for (const st of plan.steps) {
    if (st.raised.length === 0) continue
    lines.push(`Lv${st.level}：${st.raised.map((r) => `${r.name} ${r.from}→${r.to}`).join('、')}`)
  }
  return lines.join('\n')
}
