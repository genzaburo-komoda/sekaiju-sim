// メンバー・武器・スキルから、ダメージ計算エンジン（damage.ts）への入力を組み立てる。
// 「どの攻撃が使えるか」「どのパッシブ・強化が効くか」をここで決める。
import type { Equipment, FormulaSet, Skill } from '../data/schema'
import type { AttackInput, ElementId } from './damage'
import type { DifficultyId } from './party'
import type { Allocation } from './skills'
import { passiveRate, type Stats } from './stats'

type WeaponTypeId = NonNullable<Equipment['weaponType']>

/**
 * 通常攻撃の属性（武器の種類ごと）。atwiki「システム」：斧は斬、杖は壊、弓は突。
 * 素手は壊と仮定（未確認）
 */
export const NORMAL_ATTACK_ELEMENT: Record<WeaponTypeId | 'none', ElementId> = {
  sword: 'slash', axe: 'slash', katana: 'slash', whip: 'slash', staff: 'bash', bow: 'pierce', shield: 'bash', none: 'bash',
}

export const ELEMENT_LABELS: Record<ElementId, string> = { slash: '斬', bash: '壊', pierce: '突', fire: '炎', ice: '氷', volt: '雷' }

/** 攻撃の候補（通常攻撃、または振り分け済みのダメージスキル） */
export interface AttackOption {
  /** 'normal' か スキル ID */
  id: string
  name: string
  skill: Skill | null
  /** 振り分けたスキルレベル（通常攻撃は 0） */
  level: number
  /** 使えない理由（使えれば null） */
  unusable: string | null
  /** 使う前に必要な状態（ブシドーの構え）。表示用 */
  requires?: string
}

/** スキルの数値。BOOST 時は5レベル分上の値を使う（Lv10 を超える分は boostLevels） */
export function skillValues(skill: Skill, level: number, boosted: boolean): Record<string, number> | null {
  if (!skill.levels || level < 1) return null
  const lv = boosted && skill.boostable ? level + 5 : level
  if (lv <= skill.levels.length) return skill.levels[lv - 1].values
  return skill.boostLevels?.[lv - skill.levels.length - 1]?.values ?? skill.levels[skill.levels.length - 1].values
}

export function attackOptions(skills: Skill[], alloc: Allocation, weapon: Equipment | undefined): AttackOption[] {
  const options: AttackOption[] = [{ id: 'normal', name: '通常攻撃', skill: null, level: 0, unusable: null }]
  for (const s of skills) {
    const lv = alloc[s.id] ?? 0
    if (lv === 0 || !s.effects.some((e) => e.type === 'damage')) continue
    const needs = s.weapons
    const ok = !needs || (weapon?.weaponType !== undefined && needs.includes(weapon.weaponType))
    options.push({
      id: s.id,
      name: s.name,
      skill: s,
      level: lv,
      unusable: ok ? null : `${needs!.map(weaponLabel).join('・')}が必要`,
      ...(s.stance ? { requires: `${STANCE_LABELS[s.stance]}中` } : {}),
    })
  }
  return options
}

const STANCE_LABELS = { jodan: '上段の構え', seigan: '青眼の構え', iai: '居合の構え' } as const

const WEAPON_LABELS: Record<WeaponTypeId, string> = { sword: '剣', axe: '斧', bow: '弓', whip: '鞭', staff: '杖', katana: '刀', shield: '盾' }
export const weaponLabel = (t: WeaponTypeId) => WEAPON_LABELS[t]

/** 装備している武器の種類に合うマスタリーの倍率（%） */
export function masteryRate(skills: Skill[], alloc: Allocation, weapon: Equipment | undefined): number {
  let rate = 100
  if (!weapon?.weaponType) return rate
  for (const s of skills) {
    const lv = alloc[s.id] ?? 0
    if (lv === 0 || !s.levels) continue
    for (const e of s.effects) {
      if (e.type === 'passive-stat' && e.stat === 'weaponAtk' && e.weapon === weapon.weaponType) rate = (rate * s.levels[lv - 1].values[e.param]) / 100
    }
  }
  return rate
}

/** 自分にかける攻撃強化（ウォークライなど）の候補 */
export function selfBuffOptions(skills: Skill[], alloc: Allocation): { id: string; name: string; level: number; rate: number }[] {
  const out = []
  for (const s of skills) {
    const lv = alloc[s.id] ?? 0
    if (lv === 0 || !s.levels) continue
    for (const e of s.effects) {
      if (e.type !== 'buff' || e.target !== 'self') continue
      const mod = e.modifiers.find((m) => m.stat === 'damageDealt')
      if (mod) out.push({ id: s.id, name: s.name, level: lv, rate: s.levels[lv - 1].values[mod.param] })
    }
  }
  return out
}

/** 攻撃対象（手入力の敵。敵データはステップ2-4 で追加） */
export interface TargetSpec {
  level: number
  vit: number
  /** 属性ごとの倍率（%） */
  vuln: Record<ElementId, number>
  guarding: boolean
}

export interface AttackContext {
  level: number
  /** 画面のステータス（装備・引退込み） */
  stats: Stats
  row: 'front' | 'back'
  skills: Skill[]
  alloc: Allocation
  weapon: Equipment | undefined
  option: AttackOption
  /** BOOST して使うか */
  boosted: boolean
  critical: boolean
  /** 攻撃強化の倍率（%）。自己強化とその他を掛け合わせた値 */
  atkBuffRate: number
  target: TargetSpec
  formulas: FormulaSet
  difficulty: DifficultyId
}

/** 攻撃の入力を組み立てる。使えない攻撃なら null */
export function buildAttackInput(c: AttackContext): { input: AttackInput; element: ElementId; elemElement?: ElementId } | null {
  if (c.option.unusable) return null
  const weaponType = c.weapon?.weaponType ?? 'none'
  const base = {
    attacker: {
      level: c.level,
      str: c.stats.str,
      tec: c.stats.tec,
      atkBoostRate: passiveRate(c.skills, c.alloc, 'str'),
      weaponAtk: c.weapon?.atk ?? 0,
      masteryRate: masteryRate(c.skills, c.alloc, c.weapon),
      backRow: c.row === 'back',
      bow: weaponType === 'bow',
    },
    atkBuffRate: c.atkBuffRate,
    defender: { level: c.target.level, vit: c.target.vit, armorDef: 0, defBuffRate: 100 },
    guarding: c.target.guarding,
    formulas: c.formulas,
    difficulty: c.difficulty,
  }

  if (!c.option.skill) {
    // 通常攻撃：クリティカルと BOOST（×2）がある。属性付きの武器は物理＋属性の複合
    const element = NORMAL_ATTACK_ELEMENT[weaponType]
    const elem = c.weapon?.element
    return {
      element,
      elemElement: elem,
      input: {
        ...base,
        kind: elem ? 'hybrid' : 'str',
        power: 100,
        elemPower: elem ? 100 : undefined,
        vuln: c.target.vuln[element],
        elemVuln: elem ? c.target.vuln[elem] : undefined,
        critical: c.critical,
        boostedNormal: c.boosted,
      },
    }
  }

  const skill = c.option.skill
  const effect = skill.effects.find((e) => e.type === 'damage')
  const values = skillValues(skill, c.option.level, c.boosted)
  if (!effect || effect.type !== 'damage' || !values) return null
  return {
    element: effect.element,
    elemElement: effect.hybridElement,
    input: {
      ...base,
      kind: effect.attack,
      power: values[effect.powerParam],
      elemPower: effect.hybridElement ? values[effect.hybridPowerParam ?? effect.powerParam] : undefined,
      vuln: c.target.vuln[effect.element],
      elemVuln: effect.hybridElement ? c.target.vuln[effect.hybridElement] : undefined,
      // クリティカルは通常攻撃のみ（仕様書 5.4）
      critical: false,
      boostedNormal: false,
    },
  }
}
