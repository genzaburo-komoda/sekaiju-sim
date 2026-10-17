// 引退ボーナス（仕様書 A2）。値は rules.json（atwiki の DS版の記述、HD版では未確認）
import type { Job, ProgressionRules } from '../data/schema'
import type { StatKey } from './stats'

/** 引退の設定。null は引退なし */
export interface Retirement {
  /** 引退したときのレベル */
  level: number
  /** 引退したキャラのジョブ（ボーナスで上がるステータスを決める） */
  jobId: string
}

/** 画面で選べる引退レベル。ボーナスが変わる区切りのレベルだけ出す */
export const RETIRE_LEVEL_CHOICES = [30, 40, 50, 60, 70]

function rangeValue(table: ProgressionRules['retireSpBonus'], level: number): number {
  return table.find((r) => level >= r.minLevel && level <= r.maxLevel)?.value ?? 0
}

export function retireSpBonus(rules: ProgressionRules, retire: Retirement | null): number {
  return retire ? rangeValue(rules.retireSpBonus, retire.level) : 0
}

/** 引退ボーナスで上がるステータスと量。引退なしなら null */
export function retireStatBonus(
  rules: ProgressionRules,
  retire: Retirement | null,
  findJob: (id: string) => Job,
): { stat: StatKey; value: number } | null {
  if (!retire) return null
  const value = rangeValue(rules.retireStatBonus, retire.level)
  if (value === 0) return null
  return { stat: findJob(retire.jobId).retireBonusStat, value }
}
