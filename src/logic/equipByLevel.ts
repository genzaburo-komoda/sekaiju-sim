// レベルに応じて使ってよい装備（2026-10-28 におすすめの編成のために決め、2026-11-01 に編成の探索でも使えるよう任意のレベルに広げた）。
// 決め方（Claude 決定。入手の階層は推定）：
// - 入手できる階層が「レベル ÷ 10」以下（Lv1〜9 は第1階層まで）。目安はひとつ前の階層のボスの Lv（18・28・38・46・56）
// - 買値がレベルごとの上限以下（10 の位で切り捨てたレベルの上限。Lv10 未満は Lv10、Lv60 以上は Lv60 の上限）
// - 売っていない物は使わない（宝箱で手に入る物は使う）。入手の階層が分からない物も使わない
import { equipmentAvailability } from '../data/gameData'

/** 装備を候補にしてよいか */
export type EquipFilter = (id: string) => boolean

/** 10 の位ごとの買値の上限（en）。一番深い階層の装備の価格の上位 10% の境目を目安。Lv10 は第1階層の品が安いので 1,000 en */
export const PRICE_CAP: Record<number, number> = { 10: 1000, 20: 2000, 30: 4000, 40: 8000, 50: 25000, 60: 200000 }

/** そのレベルで使ってよい装備か */
export function equipAllowsAtLevel(level: number): EquipFilter {
  const maxStratum = Math.max(1, level / 10)
  const cap = PRICE_CAP[Math.min(60, Math.max(10, Math.floor(level / 10) * 10))]
  return (id) => {
    const a = equipmentAvailability[id]
    if (!a || a.stratum === null || a.stratum > maxStratum) return false
    if (a.price === null) return a.basis === 'chest'
    return a.price <= cap
  }
}
