// 敵の技と行動パターン（ステップ4-5）の説明文。データは json/enemyBehaviors.json（生成スクリプト 資料/生成スクリプト/enemy_behaviors.js）
import type { AiRule, EnemyBehavior, EnemySkill, EnemySkillEffect } from '../data/schema'
import { ELEMENT_LABELS } from './attack'

const PART_LABELS = { head: '頭', arm: '腕', leg: '脚', none: '－' } as const
const AILMENT_LABELS: Record<string, string> = {
  poison: '毒', sleep: '睡眠', paralysis: '麻痺', confusion: '混乱', terror: 'テラー', blind: '盲目', curse: '呪い', petrify: '石化', death: '即死', stun: 'スタン',
  'bind-head': '頭封じ', 'bind-arm': '腕封じ', 'bind-leg': '脚封じ',
}
const STAT_LABELS = { physAtk: '攻撃力', physDef: '防御力', agi: '速さ', accuracy: '命中', damageTaken: '受けるダメージ', physTaken: '受ける物理ダメージ', elemTaken: '受ける属性ダメージ' } as const
const TARGET_LABELS = { single: '単体', splash: '単体＋左右', all: '全体', random: 'ランダム' } as const
export const AIM_LABELS = { front: '前列だけを狙う', back: '後列を優先して狙う', lowest: 'HP が最も低い味方を狙う', highest: 'HP が最も高い味方を狙う' } as const

type Inflict = { ailments: string[]; all?: boolean; chance: number; poisonDamage?: number; ignoreResist?: boolean }
const inflictText = (x: Inflict) =>
  `${x.ailments.map((a) => AILMENT_LABELS[a] ?? a).join(x.all ? '・' : 'か')}（${x.chance}%${x.poisonDamage ? `、毒ダメージ${x.poisonDamage}` : ''}${x.ignoreResist ? '、耐性無視' : ''}）`

type Mod = { stat: keyof typeof STAT_LABELS; value: number; elements?: string[] }
function modText(m: Mod, toParty: boolean): string {
  const els = m.elements ? `（${m.elements.map((e) => ELEMENT_LABELS[e as keyof typeof ELEMENT_LABELS]).join('・')}）` : ''
  // 受けるダメージなどは値そのものが倍率。攻撃力などは自分なら +値%、味方への弱体なら −値%
  if (m.stat === 'damageTaken' || m.stat === 'physTaken' || m.stat === 'elemTaken') return `${STAT_LABELS[m.stat]}${els}を ${m.value}% に`
  if (m.value === 0) return `${STAT_LABELS[m.stat]}（効果なし）`
  const v = toParty ? -m.value : m.value
  return `${STAT_LABELS[m.stat]}${els} ${v > 0 ? '+' : ''}${v}%`
}

/** 技の効果の説明（1行） */
export function effectText(e: EnemySkillEffect): string {
  switch (e.type) {
    case 'damage': {
      const el = e.element2 ? `${ELEMENT_LABELS[e.element]}${e.power}%＋${ELEMENT_LABELS[e.element2]}${e.power2}%` : `${ELEMENT_LABELS[e.element]} 威力${e.power}%`
      const hits = e.hits ? (e.hits[0] === e.hits[1] ? `${e.hits[0]}回` : `${e.hits[0]}〜${e.hits[1]}回`) : ''
      const extra = [e.distinct ? '同じ人に2回当たらない' : '', e.drain ? 'HP 吸収' : '', e.ignoreDefBuff ? '防御の強化を無視' : '', e.inflict ? `＋${inflictText(e.inflict)}` : ''].filter(Boolean)
      return `${TARGET_LABELS[e.target]}${hits}に${el}${extra.length ? `（${extra.join('、')}）` : ''}`
    }
    case 'inflict':
      return `${e.target === 'all' ? '全体' : '単体'}に${inflictText(e)}`
    case 'self-buff':
      return `${e.turns}ターン、自分の${e.mods.map((m) => modText(m, false)).join('・')}`
    case 'party-debuff':
      return `${e.turns}ターン、味方全体の${e.mods.map((m) => modText(m, true)).join('・')}${e.inflict ? `＋${inflictText(e.inflict)}` : ''}`
    case 'heal':
      return `HP を ${e.amount} 回復`
    case 'regen':
      return `${e.turns}ターン、毎ターン HP を ${e.amount} 回復${e.revive ? `（その間に倒すと HP ${e.revive} で起き上がる）` : ''}`
    case 'dispel':
      return '味方の強化をすべて消す'
    case 'cleanse':
      return '自分の封じを消す'
    case 'counter':
      return `このターン、物理攻撃に反撃（${ELEMENT_LABELS[e.element]} 威力${e.power}%）`
    case 'guard':
      return '防御'
    case 'summon':
      return '仲間を呼ぶ（1対1では何もしない）'
  }
}

export function skillText(s: EnemySkill): { name: string; part: string; effect: string; detail: string } {
  const detail = [s.accuracy ? `命中${s.accuracy}%` : '', `速度${s.speed ?? 100}%`, s.aim ? AIM_LABELS[s.aim] : '', s.nameConfidence === 'estimated' ? '日本語名は推定' : s.nameConfidence === 'unknown' ? '日本語名は不明' : '']
  return { name: s.name, part: PART_LABELS[s.part], effect: s.effects.map(effectText).join('。') || '－', detail: detail.filter(Boolean).join('・') }
}

/** 行動の条件の説明 */
export function conditionText(w: AiRule['when'], skillName: (id: string) => string): string {
  const parts: string[] = []
  if (w.turn) parts.push(`${w.turn}ターン目`)
  if (w.turnFrom) parts.push(`${w.turnFrom}ターン目以降`)
  if (w.turnMod) parts.push(w.turnMod[1] === 1 ? `1・${1 + w.turnMod[0]}・${1 + 2 * w.turnMod[0]}…ターン目（${w.turnMod[0]}n+1）` : `${w.turnMod[0]}n+${w.turnMod[1]}ターン目`)
  if (w.hpBelow) parts.push(`HP ${w.hpBelow}% 未満`)
  if (w.hpAtLeast) parts.push(`HP ${w.hpAtLeast}% 以上`)
  if (w.prev) parts.push(`前のターンに${skillName(w.prev)}`)
  if (w.notPrev) parts.push(`前のターンに${skillName(w.notPrev)}を使っていない`)
  if (w.boundExactly) parts.push(`封じが${w.boundExactly.map((b) => PART_LABELS[b]).join('と')}だけ`)
  if (w.bound) parts.push(`${w.bound.map((b) => PART_LABELS[b]).join('と')}を封じられている`)
  if (w.notBound) parts.push(`${w.notBound.map((b) => PART_LABELS[b]).join('と')}を封じられていない`)
  if (w.boundCountAtLeast) parts.push(`封じが${w.boundCountAtLeast}か所以上`)
  if (w.partyBuffsAtLeast) parts.push(`味方の強化が${w.partyBuffsAtLeast}つ以上（メンバーごとに数える）`)
  if (w.selfBuff) parts.push(`${skillName(w.selfBuff)}がかかっている`)
  if (w.noSelfBuff) parts.push(`${skillName(w.noSelfBuff)}がかかっていない`)
  if (w.partyElemResist !== undefined) parts.push(w.partyElemResist ? '味方に属性の耐性がある' : '味方のだれも属性の耐性を持たない')
  if (w.chance) parts.push(`${w.chance}% の確率`)
  return parts.join('・') || 'いつも'
}

/** 表の説明（「通常攻撃 50%・シルバーファング 50%」） */
export function choiceText(use: AiRule['use'], skillName: (id: string) => string): string {
  const total = use.reduce((s, c) => s + c.weight, 0)
  return use.map((c) => `${skillName(c.skill)} ${Math.round((c.weight / total) * 100)}%`).join('・')
}

export function skillNamer(b: EnemyBehavior): (id: string) => string {
  return (id) => (id === 'normal' ? '通常攻撃' : (b.skills.find((s) => s.id === id)?.name ?? id))
}

export const ON_BOUND_LABELS = { normal: '通常攻撃にする', reroll: '使える技から選び直す', skip: '何もしない' } as const
