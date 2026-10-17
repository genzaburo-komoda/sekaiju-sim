// ステータスの計算（画面から切り離した純粋な関数）。
// レベルの間の値は、分かっている2点を直線補間して切り捨てる。
// HP・TP ブーストは「素の値 × 倍率」を切り捨てる。どちらも Lv66 の実機値で一致を確認済み（2026-09-30）。
import type { Job, Skill } from '../data/schema'
import type { Allocation } from './skills'

export type StatKey = 'hp' | 'tp' | 'str' | 'vit' | 'agi' | 'luc' | 'tec'
export const STAT_KEYS: StatKey[] = ['hp', 'tp', 'str', 'vit', 'agi', 'luc', 'tec']
export type Stats = Record<StatKey, number>

/** 素のステータス（装備・スキルの補正なし） */
export function baseStats(job: Job, level: number): Stats {
  const rows = [...job.stats].sort((a, b) => a.lv - b.lv)
  if (rows.length === 0) throw new Error(`ジョブ ${job.id} のステータスがありません`)
  const pick = (row: (typeof rows)[number]) => Object.fromEntries(STAT_KEYS.map((k) => [k, row[k]])) as Stats
  if (level <= rows[0].lv) return pick(rows[0])
  const last = rows[rows.length - 1]
  if (level >= last.lv) return pick(last)
  const hiIndex = rows.findIndex((r) => r.lv >= level)
  const hi = rows[hiIndex]
  if (hi.lv === level) return pick(hi)
  const lo = rows[hiIndex - 1]
  const t = (level - lo.lv) / (hi.lv - lo.lv)
  return Object.fromEntries(STAT_KEYS.map((k) => [k, Math.floor(lo[k] + (hi[k] - lo[k]) * t)])) as Stats
}

/** 振り分けたパッシブスキルで、指定した能力値にかかる倍率（%）。該当なしは 100 */
export function passiveRate(skills: Skill[], alloc: Allocation, stat: 'maxHp' | 'maxTp' | 'agi' | 'str'): number {
  let rate = 100
  for (const skill of skills) {
    const lv = alloc[skill.id] ?? 0
    if (lv === 0 || !skill.levels) continue
    for (const e of skill.effects) {
      if (e.type === 'passive-stat' && e.stat === stat) rate = (rate * skill.levels[lv - 1].values[e.param]) / 100
    }
  }
  return rate
}

/**
 * 画面に出すステータス（ゲームのステータス画面と同じ値）。
 * - HP・TP・AGI はブーストをかける（ソードマン Lv66、レンジャー Lv17 の実機値で確認）
 * - ATKブースト（攻撃時の STR）は画面の STR に出ない（ソードマン Lv66 で確認）ので、素の値のまま
 * - 引退ボーナス（retireBonus）は素の値に足してからブーストをかける（順番はゲーム内で未確認）。statCap を超えない
 * - 装備の補正（equipBonus）も素の値に足してからブーストをかける（順番はゲーム内で未確認）
 */
export function displayStats(
  job: Job,
  level: number,
  skills: Skill[],
  alloc: Allocation,
  retireBonus: { stat: StatKey; value: number } | null = null,
  statCap = Infinity,
  equipBonus: Partial<Record<string, number>> = {},
): Stats {
  const base = baseStats(job, level)
  if (retireBonus) base[retireBonus.stat] = Math.min(statCap, base[retireBonus.stat] + retireBonus.value)
  for (const k of STAT_KEYS) base[k] = Math.max(0, base[k] + (equipBonus[k] ?? 0))
  const boosted = (value: number, stat: 'maxHp' | 'maxTp' | 'agi') => Math.floor((value * passiveRate(skills, alloc, stat)) / 100)
  return {
    ...base,
    hp: boosted(base.hp, 'maxHp'),
    tp: boosted(base.tp, 'maxTp'),
    agi: boosted(base.agi, 'agi'),
  }
}
