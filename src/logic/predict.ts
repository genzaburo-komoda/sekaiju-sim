// 「このメンバーがこの設定で、この敵を攻撃したら何ダメージか」を1つの関数で出す。
// ダメージ計算欄（DamagePanel）と実測記録（measure.ts）の両方がこれを使い、同じ条件なら必ず同じ予測になるようにする。
import { findEnemy, findEquipment, findJob, formulas, rules, skillsByJob } from '../data/gameData'
import type { Enemy } from '../data/schema'
import { attackOptions, buildAttackInput, selfBuffOptions, type TargetSpec } from './attack'
import { calcDamage, type DamageResult, type ElementId } from './damage'
import type { DifficultyId, Member } from './party'
import { retireStatBonus } from './retire'
import { displayStats, type Stats } from './stats'

/** 攻撃側の設定（ダメージ計算欄の「攻撃」の欄） */
export interface AttackSettings {
  /** 'normal' か スキル ID */
  attackId: string
  boosted: boolean
  critical: boolean
  /** 自己強化のスキル ID（'' は無し） */
  buffId: string
  /** その他の攻撃強化（%） */
  otherBuff: number
}

/** 敵の設定。enemyId があれば敵データから、無ければ手入力の値を使う */
export interface TargetSettings extends TargetSpec {
  enemyId: string | null
}

export const DEFAULT_ATTACK: AttackSettings = { attackId: 'normal', boosted: false, critical: false, buffId: '', otherBuff: 100 }
export const DEFAULT_TARGET: TargetSettings = {
  enemyId: null,
  level: 10,
  vit: 10,
  vuln: { slash: 100, bash: 100, pierce: 100, fire: 100, ice: 100, volt: 100 },
  guarding: false,
}

/** 敵データから敵の設定を作る（防御中かどうかは引き継ぐ） */
export function targetFromEnemy(enemy: Enemy, guarding = false): TargetSettings {
  const r = enemy.resist
  return {
    enemyId: enemy.id,
    level: enemy.level,
    vit: enemy.vit,
    vuln: { slash: r.slash, bash: r.bash, pierce: r.pierce, fire: r.fire, ice: r.ice, volt: r.volt },
    guarding,
  }
}

/** 画面に出すステータス（引退・武器込み） */
export function memberStats(member: Member): Stats {
  const job = findJob(member.jobId)
  const skills = skillsByJob[member.jobId] ?? []
  const bonusStat = retireStatBonus(rules, member.retire, findJob)
  return displayStats(job, member.level, skills, member.skills, bonusStat, rules.statCap, findEquipment(member.weaponId)?.bonuses)
}

export interface Prediction {
  /** 実際に使った攻撃（選んだ攻撃が無ければ通常攻撃） */
  attackName: string
  element: ElementId
  elemElement?: ElementId
  /** 計算できない攻撃なら null */
  result: DamageResult | null
}

export function predict(member: Member, attack: AttackSettings, target: TargetSettings, difficulty: DifficultyId): Prediction {
  const skills = skillsByJob[member.jobId] ?? []
  const weapon = findEquipment(member.weaponId)
  const options = attackOptions(skills, member.skills, weapon)
  const option = options.find((o) => o.id === attack.attackId) ?? options[0]
  const buff = selfBuffOptions(skills, member.skills).find((b) => b.id === attack.buffId)
  // 敵データを選んでいれば、データの値を使う（データを直したときに記録の予測も追従させるため）
  const enemy = findEnemy(target.enemyId)
  const spec = enemy ? targetFromEnemy(enemy, target.guarding) : target
  const built = buildAttackInput({
    level: member.level,
    stats: memberStats(member),
    row: member.row,
    skills,
    alloc: member.skills,
    weapon,
    option,
    boosted: attack.boosted,
    critical: option.skill === null && attack.critical,
    atkBuffRate: ((buff?.rate ?? 100) * attack.otherBuff) / 100,
    target: spec,
    formulas,
    difficulty,
  })
  const name = option.skill ? `${option.name} Lv${option.level}` : option.name
  if (!built) return { attackName: name, element: 'bash', result: null }
  return { attackName: name, element: built.element, elemElement: built.elemElement, result: calcDamage(built.input) }
}
