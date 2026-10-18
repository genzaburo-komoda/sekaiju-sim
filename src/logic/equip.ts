// 装備の枠（2026-10-18、本人がゲームの画面で確かめた決まり）。全部で4枠：
// - 1枠目：武器（Member.weaponId）
// - 2枠目：服・盾・兜・小手・靴
// - 3枠目：服・兜・小手・靴
// - 4枠目：アクセサリ（楽器を含む）・服・盾・兜・小手・靴
// 2〜4枠目は Member.armorIds の 0〜2 番目。同じ種類を2つの枠に付けられるかは未確認なので、枠の決まりだけで制限する
import { equipment, findEquipment } from '../data/gameData'
import type { Equipment } from '../data/schema'
import type { ElementId } from './damage'
import type { Member } from './party'

type ArmorSlot = Equipment['slot']

/** 2〜4枠目に付けられる種類 */
export const ARMOR_SLOT_RULES: ArmorSlot[][] = [
  ['armor', 'shield', 'helmet', 'gloves', 'boots'],
  ['armor', 'helmet', 'gloves', 'boots'],
  ['accessory', 'armor', 'shield', 'helmet', 'gloves', 'boots'],
]

export const SLOT_LABELS: Record<ArmorSlot, string> = { weapon: '武器', armor: '服', shield: '盾', helmet: '兜', gloves: '小手', boots: '靴', accessory: 'アクセサリ' }

/** i 番目の防具の枠（0〜2）に、そのジョブが付けられる防具 */
export function armorChoices(index: number, jobId: string): Equipment[] {
  const kinds = ARMOR_SLOT_RULES[index]
  return equipment.filter((e) => kinds.includes(e.slot) && e.jobs.includes(jobId))
}

/** 付けている防具（空の枠は除く） */
export function armorItems(member: Member): Equipment[] {
  return (member.armorIds ?? []).map((id) => findEquipment(id)).filter((e): e is Equipment => !!e)
}

/** 枠の決まりとジョブに合わない防具を外す（ジョブを変えたとき・古いデータを読んだとき） */
export function validArmorIds(armorIds: (string | null)[] | undefined, jobId: string): (string | null)[] {
  return ARMOR_SLOT_RULES.map((_, i) => {
    const id = armorIds?.[i] ?? null
    return id && armorChoices(i, jobId).some((e) => e.id === id) ? id : null
  })
}

/** 武器と防具の能力補正の合計（STR・HP など。耐性も含む） */
export function equipBonuses(member: Member): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of [findEquipment(member.weaponId), ...armorItems(member)]) {
    for (const [k, v] of Object.entries(e?.bonuses ?? {})) out[k] = (out[k] ?? 0) + v
  }
  return out
}

/** 防具の防御力の合計 */
export const armorDefense = (member: Member) => armorItems(member).reduce((sum, e) => sum + (e.def ?? 0), 0)

/** 盾を付けているか（盾が要るスキル） */
export const hasShield = (member: Member) => armorItems(member).some((e) => e.slot === 'shield')

/** 防具の属性の耐性（%）の合計。被ダメージの属性倍率から引く（未検証） */
export const armorResist = (member: Member, element: ElementId) => equipBonuses(member)[`${element}Resist`] ?? 0

/** スキルに必要な武器・盾を持っているか */
export function gearAllows(weapons: string[] | undefined, member: Member): boolean {
  if (!weapons) return true
  const t = findEquipment(member.weaponId)?.weaponType
  return (t !== undefined && weapons.includes(t)) || (weapons.includes('shield') && hasShield(member))
}
