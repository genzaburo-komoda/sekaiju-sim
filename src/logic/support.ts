// 状態異常・封じの付与と回復の計算、それぞれの最適化（仕様書 C3・C4・5.4）。
//
// 状態異常・封じの付与率（EO Wiki「Ailment/Bind Infliction」、DS版・HD版共通。HD版で未検証）：
//   付与率 = 判定値 × 呪言マスタリー × 敵の耐性 × 難易度の「与状態異常」  （100% で頭打ち）
// - LUC は関係しない（EO Wiki に明記）
// - HD版の封じは失敗するたびに +25%（上限90%）だが、1ターン目の1回目は加算なしなので、ここでは使わない
// - 命中率は入れない（C2 と同じく、味方の基礎命中が分からないため。当たった場合の確率）
//
// 回復量（EO Wiki「Healing」）：ステータスに依存しない。メディックの回復マスタリーだけで伸びる。
//   回復量 = スキルの回復量（回復マスタリーのレベルで補間） × 難易度の「回復」
// - atwiki の表には「前提のマスタリーのレベルでの値」と「マスタリー10 での値」の2つしかない。
//   間のレベルは、マスタリーの倍率（102%〜175%）に比例するとして直線で補間する（Claude の推定。両端は資料の値と一致する）
// - 継続回復（癒しの子守唄・リジェネレート）と蘇生（リザレクション）は、1ターンの回復とは比べられないので対象外
import { findEnemy, formulas, rules, skillsByJob } from '../data/gameData'
import type { Enemy, Skill } from '../data/schema'
import { skillValues } from './attack'
import { gearAllows } from './equip'
import type { DifficultyId, Member } from './party'
import { retireSpBonus } from './retire'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'

// ---------------------------------------------------------------
// 状態異常・封じ
// ---------------------------------------------------------------

export type AilmentId = 'poison' | 'sleep' | 'paralysis' | 'confusion' | 'terror' | 'blind' | 'curse' | 'petrify' | 'death' | 'stun'
export type BindId = 'head' | 'arm' | 'leg'
/** 狙う状態異常（封じは 'bind-head' など） */
export type InflictId = AilmentId | `bind-${BindId}`

export const INFLICT_LABELS: Record<InflictId, string> = {
  poison: '毒', sleep: '睡眠', paralysis: '麻痺', confusion: '混乱', terror: 'テラー', blind: '盲目', curse: '呪い',
  petrify: '石化', death: '即死', stun: 'スタン', 'bind-head': '頭封じ', 'bind-arm': '腕封じ', 'bind-leg': '脚封じ',
}
export const INFLICT_IDS = Object.keys(INFLICT_LABELS) as InflictId[]

/**
 * 敵の耐性（%）。敵データ（DS版の解析値）の列：即死・状態異常（毒〜呪いをまとめた1列）・頭・腕・脚・スタン。
 * 石化の列は無いので、仮に「状態異常」の列を使う（未確認）。敵を選んでいない（手入力の）ときは 100%
 */
export function inflictVuln(enemy: Enemy | undefined, id: InflictId): number {
  if (!enemy) return 100
  const r = enemy.resist
  if (id === 'death') return r.death
  if (id === 'stun') return r.stun
  if (id === 'bind-head') return r.head
  if (id === 'bind-arm') return r.arm
  if (id === 'bind-leg') return r.leg
  return r.ailment
}

/** そのスキルが狙いの状態異常を付けるときの判定値（付けないなら null） */
function inflictParam(skill: Skill, id: InflictId): string | null {
  for (const e of skill.effects) {
    if (e.type === 'ailment' && e.ailment === id) return e.chanceParam
    if (e.type === 'bind' && `bind-${e.bind}` === id) return e.chanceParam
  }
  return null
}

/** 状態異常の付与率に効くパッシブ（呪言マスタリー）の倍率（%） */
function ailmentBoost(skills: Skill[], alloc: Allocation): number {
  let rate = 100
  for (const s of skills) {
    const lv = alloc[s.id] ?? 0
    if (lv === 0 || !s.levels) continue
    for (const e of s.effects) if (e.type === 'passive-stat' && e.stat === 'ailmentRate') rate = (rate * s.levels[lv - 1].values[e.param]) / 100
  }
  return rate
}

/** 付与率（0〜1）。判定値・マスタリー・耐性・難易度はすべて %（100 が等倍） */
export function inflictChance(baseChance: number, boostRate: number, vuln: number, difficultyRate: number): number {
  if (vuln <= 0) return 0
  const p = (baseChance / 100) * (boostRate / 100) * (vuln / 100) * (difficultyRate / 100)
  return Math.max(0, Math.min(1, p))
}

/** 最適化の候補1件（状態異常・回復で共通） */
export interface SupportCandidate {
  skillId: string
  skillName: string
  /** スキルの振り方（使うスキル・マスタリーと、その前提スキルだけ） */
  alloc: Allocation
  spUsed: number
  /** 評価値（状態異常は付与率 0〜1、回復は基準ごとの値） */
  value: number
  /** 消費TP */
  tp: number
  /** 使う前に必要な状態（ブシドーの構えなど）。表示用 */
  requires?: string
  breakdown: string
}

const STANCE_LABELS = { jodan: '上段の構え', seigan: '青眼の構え', iai: '居合の構え' } as const

/** 武器が必要なスキルを、今の武器で使えるか */
function usableWithWeapon(skill: Skill, member: Member): boolean {
  return gearAllows(skill.weapons, member)
}

/**
 * 「使うスキルのレベル」×「伸ばすパッシブ（マスタリー）のレベル」を全部試し、SP に収まる振り方を visit に渡す。
 * 前提スキルは自動で取る（A3 と同じ手順）
 */
function eachAllocation(skills: Skill[], skill: Skill, booster: Skill | undefined, total: number, visit: (alloc: Allocation, lv: number) => void) {
  for (let lv = 1; lv <= skill.maxLevel; lv++) {
    const base = setSkillLevel(skills, {}, skill.id, lv)
    if (spUsed(base) > total) break
    const from = booster ? (base[booster.id] ?? 0) : 0
    for (let b = from; b <= (booster?.maxLevel ?? 0); b++) {
      const alloc = booster && b > from ? setSkillLevel(skills, base, booster.id, b) : base
      if (spUsed(alloc) > total) break
      visit(alloc, lv)
    }
  }
}

/** 評価値の大きい順（同じなら SP の少ない順）に並べる */
const byValue = (a: SupportCandidate, b: SupportCandidate) => b.value - a.value || a.spUsed - b.spUsed

/**
 * 状態異常の最適化（C3）：このメンバーが、選んだ敵に、狙いの状態異常を1回の行動で付ける確率が最大になる振り方を、スキルごとに探す。
 * enemyId が null（手入力の敵）なら耐性は 100%
 */
export function optimizeAilment(member: Member, enemyId: string | null, id: InflictId, difficulty: DifficultyId): SupportCandidate[] {
  const skills = skillsByJob[member.jobId] ?? []
  const total = spTotal(rules, member.level, retireSpBonus(rules, member.retire))
  const enemy = findEnemy(enemyId)
  const vuln = inflictVuln(enemy, id)
  const diff = formulas.difficulty[difficulty].ailmentInflict
  const booster = skills.find((s) => s.effects.some((e) => e.type === 'passive-stat' && e.stat === 'ailmentRate'))
  const out: SupportCandidate[] = []
  for (const skill of skills) {
    const param = inflictParam(skill, id)
    if (!param || !usableWithWeapon(skill, member)) continue
    let best: SupportCandidate | null = null
    eachAllocation(skills, skill, booster, total, (alloc, lv) => {
      const values = skillValues(skill, lv, false)!
      const boost = ailmentBoost(skills, alloc)
      const p = inflictChance(values[param], boost, vuln, diff)
      const c: SupportCandidate = {
        skillId: skill.id,
        skillName: `${skill.name} Lv${lv}`,
        alloc,
        spUsed: spUsed(alloc),
        value: p,
        tp: skill.levels![lv - 1].tp ?? 0,
        ...(skill.stance ? { requires: `${STANCE_LABELS[skill.stance]}中` } : {}),
        breakdown:
          `判定値 ${values[param]}%` +
          (boost !== 100 ? ` × 呪言マスタリー ${Math.round(boost * 10) / 10}%` : '') +
          ` × 耐性 ${vuln}%` +
          (diff !== 100 ? ` × 難易度 ${diff}%` : '') +
          (p >= 1 ? '（100% で頭打ち）' : ''),
      }
      if (!best || byValue(c, best) < 0) best = c
    })
    if (best) out.push(best)
  }
  return out.sort(byValue)
}

/**
 * パーティ全員がそれぞれ最善のスキルを1回ずつ使ったとき、少なくとも1回付く確率。
 * 1 − (1 − p1)(1 − p2)…（それぞれ独立で、全員が同じ敵を狙い、付いた後の行動も数えると仮定）
 */
export function optimizePartyAilment(members: Member[], enemyId: string | null, id: InflictId, difficulty: DifficultyId) {
  const perMember = members.map((m) => ({ member: m, best: optimizeAilment(m, enemyId, id, difficulty)[0] ?? null }))
  const miss = perMember.reduce((q, x) => q * (1 - (x.best?.value ?? 0)), 1)
  return { perMember, chance: 1 - miss }
}

// ---------------------------------------------------------------
// 回復
// ---------------------------------------------------------------

/** 回復の評価基準（仕様書 C4） */
export type HealCriterion = 'total' | 'per-tp' | 'min-tp'

export const HEAL_CRITERION_LABELS: Record<HealCriterion, string> = {
  total: '1ターンの総回復量',
  'per-tp': 'TP1 あたりの回復量',
  'min-tp': '指定したダメージを全快できる最小 TP',
}

export interface HealOptions {
  criterion: HealCriterion
  /** min-tp：回復したいダメージ（1人あたり） */
  damage: number
  /** min-tp：何人分を回復するか（1 か パーティの人数） */
  targets: number
}

/**
 * 回復スキル1回の回復量（1人分）。メディックの回復スキルは回復マスタリーで補間する
 */
export function healAmount(skills: Skill[], skill: Skill, level: number, alloc: Allocation, difficulty: DifficultyId): { amount: number; note: string } | null {
  const effect = skill.effects.find((e) => e.type === 'heal')
  const values = skillValues(skill, level, false)
  if (!effect || effect.type !== 'heal' || !values) return null
  let amount = values[effect.amountParam]
  let note = `回復量 ${amount}`
  if (effect.maxMasteryParam) {
    const mastery = skills.find((s) => s.effects.some((e) => e.type === 'passive-stat' && e.stat === 'healing'))
    const rateParam = mastery?.effects.find((e) => e.type === 'passive-stat')
    if (mastery?.levels && rateParam?.type === 'passive-stat') {
      const rate = (lv: number) => mastery.levels![lv - 1].values[rateParam.param]
      // 表の左の列は「前提スキルのマスタリーのレベル」での値
      const lo = skill.prerequisites.find((p) => p.skillId === mastery.id)?.level ?? 1
      const hi = mastery.maxLevel
      const m = Math.max(lo, Math.min(hi, alloc[mastery.id] ?? 0))
      const max = values[effect.maxMasteryParam]
      amount = Math.floor(amount + ((max - amount) * (rate(m) - rate(lo))) / (rate(hi) - rate(lo)))
      note =
        m === lo
          ? `回復量 ${amount}（回復マスタリー Lv${m} の値）`
          : m === hi
            ? `回復量 ${amount}（回復マスタリー Lv${m} の値）`
            : `回復量 ${amount}（回復マスタリー Lv${m}：Lv${lo} の ${values[effect.amountParam]} と Lv${hi} の ${max} の間を、マスタリーの倍率 ${rate(m)}% で補間。推定）`
    }
  }
  const diff = formulas.difficulty[difficulty].healing
  if (diff !== 100) {
    amount = Math.floor((amount * diff) / 100)
    note += ` × 難易度 ${diff}% → ${amount}`
  }
  return { amount, note }
}

/** 1ターンで比べられる回復スキルか（継続回復・蘇生・割合回復は除く） */
function isInstantHeal(skill: Skill): boolean {
  return skill.effects.some((e) => e.type === 'heal' && e.scaling === 'fixed' && e.timing !== 'per-turn' && !e.revive)
}

const TARGET_LABELS = { self: '自分', 'ally-single': '味方1人', 'ally-row': '味方1列', 'ally-all': '味方全員' } as const

/**
 * 回復の最適化（C4）：選んだ基準で最も良いスキルの振り方を、回復スキルごとに探す。
 * partySize は「味方全員」に回復するスキルの人数。
 * min-tp は「同じスキルを繰り返し使う」として数える（スキルを混ぜた組み合わせは考えない）。値は小さいほど良いので、符号を反転して並べる
 */
export function optimizeHeal(member: Member, partySize: number, difficulty: DifficultyId, opts: HealOptions): SupportCandidate[] {
  const skills = skillsByJob[member.jobId] ?? []
  const total = spTotal(rules, member.level, retireSpBonus(rules, member.retire))
  const mastery = skills.find((s) => s.effects.some((e) => e.type === 'passive-stat' && e.stat === 'healing'))
  const out: SupportCandidate[] = []
  for (const skill of skills) {
    if (!isInstantHeal(skill) || !usableWithWeapon(skill, member)) continue
    const effect = skill.effects.find((e) => e.type === 'heal')!
    if (effect.type !== 'heal') continue
    const allTargets = effect.target === 'ally-all'
    const booster = effect.maxMasteryParam ? mastery : undefined
    let best: SupportCandidate | null = null
    eachAllocation(skills, skill, booster, total, (alloc, lv) => {
      const healed = healAmount(skills, skill, lv, alloc, difficulty)
      if (!healed || healed.amount <= 0) return
      const tp = skill.levels![lv - 1].tp ?? 0
      const people = allTargets ? partySize : 1
      let value: number
      let breakdown: string
      if (opts.criterion === 'total') {
        value = healed.amount * people
        breakdown = `${healed.note}${people > 1 ? ` × ${people}人` : ''}（${TARGET_LABELS[effect.target as keyof typeof TARGET_LABELS] ?? ''}）`
      } else if (opts.criterion === 'per-tp') {
        value = tp > 0 ? (healed.amount * people) / tp : healed.amount * people
        breakdown = `${healed.note}${people > 1 ? ` × ${people}人` : ''} ÷ 消費TP ${tp}`
      } else {
        // 自分しか回復できないスキルは、2人以上を回復できない
        if (effect.target === 'self' && opts.targets > 1) return
        const casts = Math.ceil(opts.damage / healed.amount)
        const times = allTargets ? casts : casts * opts.targets
        value = -(times * tp)
        breakdown = `${healed.note}：${opts.damage} を回復するのに ${casts} 回${!allTargets && opts.targets > 1 ? ` × ${opts.targets}人` : ''} × 消費TP ${tp}`
      }
      const c: SupportCandidate = { skillId: skill.id, skillName: `${skill.name} Lv${lv}`, alloc, spUsed: spUsed(alloc), value, tp, breakdown }
      if (!best || byValue(c, best) < 0) best = c
    })
    if (best) out.push(best)
  }
  return out.sort(byValue)
}

/** パーティ全員の回復スキルの合計（1ターンの総回復量のときだけ意味がある） */
export function optimizePartyHeal(members: Member[], difficulty: DifficultyId, opts: HealOptions) {
  const perMember = members.map((m) => ({ member: m, best: optimizeHeal(m, members.length, difficulty, opts)[0] ?? null }))
  return { perMember, total: perMember.reduce((sum, x) => sum + (x.best?.value ?? 0), 0) }
}

// ---------------------------------------------------------------
// 今の振り方での値（採点 C5 の「今の値」）
// ---------------------------------------------------------------

/** 今の振り方で、狙いの状態異常を1回の行動で付ける確率の最大（0〜1） */
export function currentAilment(member: Member, enemyId: string | null, id: InflictId, difficulty: DifficultyId): number {
  const skills = skillsByJob[member.jobId] ?? []
  const vuln = inflictVuln(findEnemy(enemyId), id)
  const diff = formulas.difficulty[difficulty].ailmentInflict
  const boost = ailmentBoost(skills, member.skills)
  let best = 0
  for (const skill of skills) {
    const lv = member.skills[skill.id] ?? 0
    const param = inflictParam(skill, id)
    if (lv === 0 || !param || !usableWithWeapon(skill, member)) continue
    best = Math.max(best, inflictChance(skillValues(skill, lv, false)![param], boost, vuln, diff))
  }
  return best
}

/** 今の振り方で、回復スキル1回の総回復量の最大（味方全員に回復するスキルは partySize 人分） */
export function currentHeal(member: Member, partySize: number, difficulty: DifficultyId): number {
  const skills = skillsByJob[member.jobId] ?? []
  let best = 0
  for (const skill of skills) {
    const lv = member.skills[skill.id] ?? 0
    if (lv === 0 || !isInstantHeal(skill) || !usableWithWeapon(skill, member)) continue
    const effect = skill.effects.find((e) => e.type === 'heal')!
    const healed = healAmount(skills, skill, lv, member.skills, difficulty)
    if (healed && effect.type === 'heal') best = Math.max(best, healed.amount * (effect.target === 'ally-all' ? partySize : 1))
  }
  return best
}
