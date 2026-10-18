// 戦闘シミュレーション（仕様書 B2・B3・B9、5.4・5.6）の共通部分：行動順、強化・弱体の持続、TP、1ターンの進め方。
//
// 1ターンの進め方（EO Wiki「Activation Speed」、atwiki「システム」「スキル速度」。DS版の資料。HD版で未検証）：
// 1. ターンの初めに、全員の行動順を決める：実効 AGI ＝ AGI × 速度の強化・弱体 × 行動の速度補正（味方は難易度の行動速度も）。
//    実効 AGI ÷ 5 を四捨五入して大きい順。同じ値は乱数（期待値で計算するときは、味方の並び順 → 敵の順とする）。
//    防御と「最速行動」のスキル（フロントガードなど）は先に動く。ターンの途中でかけた速度の強化は、そのターンの順番には効かない
// 2. 順番に行動する。TP はそのときに減らし、足りなければ代わりの行動（B2 は通常攻撃、B9 は防御）をする
// 3. ターンの終わりに継続回復をし、持続が切れた強化・弱体を消す
//
// 強化・弱体（atwiki「システム」「カースメーカー」「バード」）：
// - 持続ターン数は使ったターンを含めて数える（5ターンなら、使ったターンから5ターン目の終わりまで）
// - バードの歌は戦闘終了まで続く。持続の書いていないもの（フロントガードなど）は使ったターンだけ
// - 1人が持てる強化・弱体はそれぞれ3つまで。4つ目は古いものから消える。同じスキルをかけ直すと持続が最初からになる（新しいレベルが優先）
// - ブシドーの構えは同時に1つだけと仮定した（未確認）
// - 同じ能力値の強化と弱体は打ち消し合い、両方なくなる（本人の説明、2026-10-18。applyEffect）
//
// 状態異常・封じ（本人の説明と LP Archive Part 47「Disablement Hierarchy」（DS版）。HD版で未検証）：
// - 強化・弱体・封じ・状態異常は別々に持つ。封じ以外の状態異常は同時に1つ（石化は別。戦闘不能と同じに扱う）
// - 上書きは優先順位方式（暫定、本人決定）：石化＞テラー＞呪い＞毒＞睡眠＞混乱＞麻痺＞盲目。上位は下位を置き換え、下位は上位を置き換えない
// - 封じ：頭は命中 −30%、腕は STR −30%、脚は AGI −30%。付与率の上限は封じ 90%・状態異常 100%。敵は入るたびに耐性 ×0.75、外れると ×1.25
//
// 敵の行動（ステップ4-6）：setup.enemyAi が true で、敵に行動パターンのデータ（json/enemyBehaviors.json）があれば、
// ターンの初めにその条件で技を選ぶ（なければ setup.enemyActions の表から重みで選ぶ）。味方の状態異常・封じは atwiki「システム」の説明による
import { findBehavior, findEquipment, formulas, skillsByJob } from '../data/gameData'
import type { Enemy, EnemyBehavior, EnemySkill, EnemySkillEffect, Equipment, Skill, SkillEffect } from '../data/schema'
import { attackOptions, buildAttackInput, skillValues, type AttackOption } from './attack'
import { calcDamage, levelCorrection, type AttackInput, type ElementId } from './damage'
import { armorDefense, armorResist, gearAllows, hasShield } from './equip'
import type { DifficultyId, Member } from './party'
import { doubleAttackChance } from './optimize'
import { memberStats, targetFromEnemy, type TargetSettings } from './predict'
import { healAmount, inflictChance, inflictVuln, INFLICT_LABELS, type InflictId } from './support'

// ---------------------------------------------------------------
// 乱数（シード固定。仕様書 5.6「同じ入力で同じ結果」）
// ---------------------------------------------------------------

export type Rng = () => number

/** シードから 0 以上 1 未満の乱数を作る（mulberry32） */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 重み付きで1つ選ぶ */
export function pickWeighted<T>(items: T[], weight: (x: T) => number, rng: Rng): T {
  const total = items.reduce((s, x) => s + Math.max(0, weight(x)), 0)
  let r = rng() * total
  for (const x of items) {
    r -= Math.max(0, weight(x))
    if (r < 0) return x
  }
  return items[items.length - 1]
}

// ---------------------------------------------------------------
// 行動
// ---------------------------------------------------------------

export type ActionKind = 'attack' | 'buff' | 'debuff' | 'heal' | 'ailment' | 'defend' | 'cure' | 'step'

/**
 * 効果が「その他」などで、個別に計算するスキル（ステップ4-7。atwiki の各ジョブのページ）。
 * target: 'ally' は対象の味方を選ぶ（行動 ID は「スキル ID@メンバー ID」）
 */
export type Special =
  | 'imbue' | 'dispel' | 'tp-regen' | 'evade-once' | 'parry' | 'endure' | 'refresh' | 'bind-recovery' | 'arm-recovery' | 'others-step' | 'chase' | 'trapping'
  | 'pain-trade' | 'the-end' | 'recovery' | 'relapse' | 'cloak'
const SPECIAL: Record<string, { kind: ActionKind; special: Special; ally?: boolean; element?: ElementId }> = {
  'bard-fire-overture': { kind: 'buff', special: 'imbue', ally: true, element: 'fire' },
  'bard-ice-overture': { kind: 'buff', special: 'imbue', ally: true, element: 'ice' },
  'bard-volt-overture': { kind: 'buff', special: 'imbue', ally: true, element: 'volt' },
  'bard-dispel-song': { kind: 'debuff', special: 'dispel' },
  'bard-tp-lullaby': { kind: 'buff', special: 'tp-regen' },
  'bushido-issun-no-mikiri': { kind: 'buff', special: 'evade-once' },
  'paladin-parry': { kind: 'buff', special: 'parry' },
  'medic-medical-defense-2': { kind: 'buff', special: 'endure' },
  'medic-refresh': { kind: 'cure', special: 'refresh' },
  'medic-bind-recovery': { kind: 'cure', special: 'bind-recovery', ally: true },
  'arm-recovery': { kind: 'cure', special: 'arm-recovery' },
  'ranger-others-step': { kind: 'step', special: 'others-step', ally: true },
  'chase-fire': { kind: 'buff', special: 'chase', element: 'fire' },
  'chase-freeze': { kind: 'buff', special: 'chase', element: 'ice' },
  'chase-shock': { kind: 'buff', special: 'chase', element: 'volt' },
  'dark-hunter-trapping': { kind: 'buff', special: 'trapping' },
  'hexer-pain-trade': { kind: 'attack', special: 'pain-trade' },
  'bard-recovery-song': { kind: 'buff', special: 'recovery' },
  'hexer-burden-curse': { kind: 'debuff', special: 'relapse' },
  'ranger-shadow-entry': { kind: 'buff', special: 'cloak' },
  'dark-hunter-shadow-entry': { kind: 'buff', special: 'cloak' },
  'dark-hunter-the-end': { kind: 'attack', special: 'the-end' },
}

/** メンバーが選べる行動 */
export interface SimAction {
  /** 'normal'・'defend' かスキル ID */
  id: string
  name: string
  kind: ActionKind
  skill: Skill | null
  level: number
  tp: number
  /** 行動の速度補正（AGI に掛ける）。priority なら速度に関係なく先に動く */
  speed: number
  priority: boolean
  /** 必要な構え（ブシドー）のスキル ID */
  needsStance?: string
  /** 個別に計算するスキル（SPECIAL） */
  special?: Special
  /** 対象の味方（序曲・バインドリカバリ・アザーズステップ） */
  targetId?: string
}

const ACTION_DEFEND: SimAction = { id: 'defend', name: '防御', kind: 'defend', skill: null, level: 0, tp: 0, speed: 1, priority: true }

function speedOf(skill: Skill, level: number): { speed: number; priority: boolean } {
  const sp = skill.speed
  if (sp.kind === 'fastest') return { speed: 1, priority: true }
  if (sp.kind === 'agi') return { speed: sp.factor, priority: false }
  if (sp.kind === 'agi-by-level') return { speed: skill.levels?.[level - 1]?.values[sp.paramId] ?? 1, priority: false }
  return { speed: 1, priority: false }
}

function kindOf(skill: Skill): ActionKind | null {
  const types = skill.effects.map((e) => e.type)
  if (types.includes('damage')) return 'attack'
  if (skill.effects.some((e) => e.type === 'heal' && !e.revive)) return 'heal'
  if (types.includes('buff')) return 'buff'
  if (types.includes('debuff')) return 'debuff'
  if (types.includes('ailment') || types.includes('bind')) return 'ailment'
  return null
}

/** メンバーが今の振り方・武器で選べる行動（通常攻撃・防御と、振ってある戦闘用スキル） */
export function memberActions(member: Member): SimAction[] {
  const skills = skillsByJob[member.jobId] ?? []
  const weapon = findEquipment(member.weaponId)
  const out: SimAction[] = [{ id: 'normal', name: '通常攻撃', kind: 'attack', skill: null, level: 0, tp: 0, speed: 1, priority: false }, ACTION_DEFEND]
  const usable = new Set(attackOptions(skills, member.skills, weapon, hasShield(member)).filter((o) => o.unusable === null).map((o) => o.id))
  for (const s of skills) {
    const lv = member.skills[s.id] ?? 0
    if (lv === 0 || s.category !== 'active' || !s.levels) continue
    const sp = SPECIAL[s.id]
    const kind = sp?.kind ?? kindOf(s)
    if (!kind) continue
    if (kind === 'attack' && !sp && !usable.has(s.id)) continue
    if ((kind !== 'attack' || sp) && !gearAllows(s.weapons, member)) continue
    out.push({
      id: s.id,
      name: `${s.name} Lv${lv}`,
      kind,
      skill: s,
      level: lv,
      tp: s.levels[lv - 1].tp ?? 0,
      ...speedOf(s, lv),
      // 構えのスキル自身（上段・青眼・居合の構え）は構えが要らない
      ...(s.stance && `bushido-${s.stance}` !== s.id ? { needsStance: `bushido-${s.stance}` } : {}),
      ...(sp ? { special: sp.special } : {}),
    })
  }
  return out
}

/** パーティ全員の行動。味方を選ぶスキル（序曲など）は、対象ごとの行動（ID「スキル ID@メンバー ID」）に分ける */
export function partyActions(members: Member[]): Map<string, SimAction[]> {
  return new Map(
    members.map((m) => [
      m.id,
      memberActions(m).flatMap((a) =>
        a.skill && SPECIAL[a.skill.id]?.ally ? members.map((t) => ({ ...a, id: `${a.id}@${t.id}`, name: `${a.name}→${t.name}`, targetId: t.id })) : [a],
      ),
    ]),
  )
}

/** スキルの属性（序曲・チェイス） */
export const specialElement = (skillId: string) => SPECIAL[skillId]?.element

// ---------------------------------------------------------------
// 状態
// ---------------------------------------------------------------

/** かかっている強化・弱体1つ */
export interface ActiveEffect {
  skillId: string
  name: string
  /** この値の効果（％の値。ウォークライの与ダメージ 110 など、スキルの数値そのまま） */
  mods: { stat: string; value: number; appliesTo?: 'defense' | 'resistance'; elements?: ElementId[] }[]
  /** このターンの終わりまで有効（Infinity は戦闘終了まで） */
  lastTurn: number
  oneShot: boolean
  /** 継続回復（ターン終了時）。max-hp-ratio なら最大HPの％ */
  regen?: { amount: number; ratio: boolean }
  /** 逆向きの強化・弱体と打ち消し合わない（火竜の猛攻） */
  special?: boolean
}

export interface Fighter {
  id: string
  name: string
  hp: number
  maxHp: number
  /** 強化・弱体のない最大HP */
  baseMaxHp: number
  tp: number
  alive: boolean
  buffs: ActiveEffect[]
  debuffs: ActiveEffect[]
  /** このターン防御しているか */
  guarding: boolean
  /** 戦闘不能になったターン（null は倒れていない）。石化も戦闘不能と同じに扱う */
  downTurn: number | null
  /** 状態異常（毒・睡眠など。封じ以外は同時に1つだけ、後からかかったものが前のものを消す） */
  ailment: { id: PartyAilment; lastTurn: number; poison?: number } | null
  /** 封じ（部位 → このターンの終わりまで） */
  binds: Partial<Record<'head' | 'arm' | 'leg', number>>
  /** このターンもう行動したか（スタン） */
  acted: boolean
  /** スタンしたターン（そのターンの残りだけ行動できない） */
  stunTurn: number
  /** 睡眠から起きたターン（起きたターンは行動できない） */
  wokeTurn: number
  /** このターンだけの構え（強化の枠を使わない）：パリング・一寸の見切り・チェイス・トラッピング */
  turnFx: TurnFx
}

export interface TurnFx {
  /** パリング：最初の成功率と、2回目以降の成功率（%）。成功した回数 */
  parry?: { first: number; repeat: number; succeeded: number }
  /** 一寸の見切り：攻撃を1度だけ無効にする */
  evade?: boolean
  /** チェイス：属性と威力（%）、スキル。1ターンに1度だけ追撃 */
  chase?: { element: ElementId; skill: Skill; level: number; used: boolean }[]
  /** トラッピング：自分・左右が直接攻撃を受けたときの反撃の威力（%） */
  trap?: { skill: Skill; level: number }
}

/** 味方がかかる状態異常（即死・石化はかかったときに戦闘不能にする） */
export type PartyAilment = 'poison' | 'sleep' | 'paralysis' | 'confusion' | 'terror' | 'blind' | 'curse'

export interface EnemyState {
  hp: number
  maxHp: number
  debuffs: ActiveEffect[]
  /** かかっている状態異常（ID → このターンの終わりまで） */
  ailments: Partial<Record<InflictId, number>>
  /** 自分にかけた強化（行動パターンの技） */
  buffs: ActiveEffect[]
  /** 前のターンに使った技（行動パターンの技 ID。'normal' は通常攻撃） */
  prev: string | null
  /** 継続回復（このターンの終わりまで、倒れたときに起き上がる HP） */
  regen: { amount: number; lastTurn: number; revive?: number } | null
  /** 起き上がりを使ったか */
  revived: boolean
  /** このターンの反撃（クロスカウンター） */
  counter: { element: ElementId; power: number; accuracy: number } | null
  /** このターン防御しているか */
  guarding: boolean
  /** 状態異常・封じが入るたびに変わる耐性の倍率（グループ → 倍率。Part 47：入ると ×0.75、外れると ×1.25） */
  resistMul: Record<string, number>
  /** 睡眠から起きたターン（起きたターンは行動できない） */
  wokeTurn: number
}

export interface BattleState {
  turn: number
  members: Fighter[]
  enemy: EnemyState
}

const MAX_EFFECTS = 3

/** 強化・弱体を足す（同じスキルは置きかえ、4つ目は古いものを消す） */
export function addEffect(list: ActiveEffect[], e: ActiveEffect): ActiveEffect[] {
  let next = list.filter((x) => x.skillId !== e.skillId)
  // ブシドーの構えは1つだけ（仮定）
  if (e.skillId.startsWith('bushido-') && ['bushido-jodan', 'bushido-seigan', 'bushido-iai'].includes(e.skillId))
    next = next.filter((x) => !['bushido-jodan', 'bushido-seigan', 'bushido-iai'].includes(x.skillId))
  next.push(e)
  while (next.length > MAX_EFFECTS) next = next.slice(1)
  return next
}

/** 打ち消し合う能力値（攻撃力・防御力・速さ・命中）。防御の強化のうち耐性にかかるもの（防御陣形など）は別に扱う */
const cancelKey = (m: ActiveEffect['mods'][number]) =>
  m.stat === 'physAtk' || m.stat === 'agi' || m.stat === 'accuracy' ? m.stat : m.stat === 'physDef' ? (m.appliesTo === 'resistance' ? null : 'physDef') : null

/**
 * 強化（または弱体）をかける。逆向き（弱体／強化）に同じ能力値のものがあれば、それを消し、新しいほうもかけない（本人の説明：両方なくなる）。
 * 返り値：[同じ向きの一覧, 逆向きの一覧, 打ち消したか]
 */
export function applyEffect(same: ActiveEffect[], opposite: ActiveEffect[], e: ActiveEffect): [ActiveEffect[], ActiveEffect[], boolean] {
  const keys = new Set(e.mods.map(cancelKey).filter(Boolean))
  const hit = e.special ? undefined : opposite.find((x) => !x.special && x.mods.some((m) => keys.has(cancelKey(m))))
  if (hit) return [same, opposite.filter((x) => x !== hit), true]
  return [addEffect(same, e), opposite, false]
}

// ---------------------------------------------------------------
// 状態異常の優先順位（LP Archive Part 47。説明の並びの逆が優先順位）
// ---------------------------------------------------------------

/** 上ほど強い。石化は戦闘不能と同じに扱うので、この表では一番上に置くだけ */
export const AILMENT_PRIORITY = ['petrify', 'terror', 'curse', 'poison', 'sleep', 'confusion', 'paralysis', 'blind'] as const
/** 上書きの決まり。'priority'＝優先順位方式（暫定、2026-10-18 本人決定）、'latest'＝新しいほうで上書き（本人の当初の理解） */
export const AILMENT_OVERRIDE: 'priority' | 'latest' = 'priority'

/** 今の状態異常 current に next がかかるか（同じ順位はかけ直し＝持続を引き直すとした。未確認） */
export function ailmentReplaces(current: string | null | undefined, next: string): boolean {
  if (!current || AILMENT_OVERRIDE === 'latest') return true
  const rank = (id: string) => AILMENT_PRIORITY.indexOf(id as (typeof AILMENT_PRIORITY)[number])
  return rank(next) <= rank(current)
}

/** 強化・弱体の倍率を掛け合わせる（増える方向は 100+値、減る方向は 100−値。スキルの数値が倍率そのもののものはそのまま） */
function product(list: ActiveEffect[], f: (m: ActiveEffect['mods'][number]) => number | null): number {
  let rate = 100
  for (const e of list) for (const m of e.mods) {
    const r = f(m)
    if (r !== null) rate = (rate * r) / 100
  }
  return rate
}

// ---------------------------------------------------------------
// 戦闘の設定
// ---------------------------------------------------------------

/** 敵の行動（B9。敵のスキルの数値は資料にほとんどないので、本人が入れる） */
export interface EnemyAction {
  name: string
  /** str=物理（STR）、tec=属性（TEC） */
  attack: 'str' | 'tec'
  element: ElementId
  /** ダメージ倍率（%）。通常攻撃は 100 */
  power: number
  target: 'single' | 'row' | 'all'
  /** 選ばれる重み */
  weight: number
  /** 基礎命中（%） */
  accuracy: number
  /** 通常攻撃か（クリティカル 3% がある） */
  normal: boolean
}

export interface BattleSetup {
  members: Member[]
  difficulty: DifficultyId
  /** 敵（敵データ）。null なら target の手入力の値 */
  enemy: Enemy | null
  target: TargetSettings
  /** 手入力の敵の HP・STR・TEC・AGI（敵データを選んでいないとき。レベル・VIT・属性倍率は target） */
  manual: { hp: number; str: number; tec: number; agi: number }
  /** 敵の行動（B9。空なら敵は行動しない） */
  enemyActions: EnemyAction[]
  /** 敵に行動パターンのデータがあれば、それで行動する（enemyActions より優先） */
  enemyAi?: boolean
}

/** 敵の数値（敵データ、または手入力の値） */
export interface EnemyStats {
  level: number
  hp: number
  str: number
  tec: number
  vit: number
  agi: number
}

export function enemyStats(setup: BattleSetup): EnemyStats {
  const e = setup.enemy
  if (e) return { level: e.level, hp: e.hp, str: e.str, tec: e.tec, vit: e.vit, agi: e.agi }
  return { level: setup.target.level, hp: setup.manual.hp, str: setup.manual.str, tec: setup.manual.tec, vit: setup.target.vit, agi: setup.manual.agi }
}

export function initialState(setup: BattleSetup): BattleState {
  const es = enemyStats(setup)
  return {
    turn: 0,
    members: setup.members.map((m) => {
      const st = memberStats(m)
      return { id: m.id, name: m.name, hp: st.hp, maxHp: st.hp, baseMaxHp: st.hp, tp: st.tp, alive: true, buffs: [], debuffs: [], guarding: false, downTurn: null, ailment: null, binds: {}, acted: false, stunTurn: 0, wokeTurn: 0, turnFx: {} }
    }),
    enemy: { hp: es.hp, maxHp: es.hp, debuffs: [], ailments: {}, buffs: [], prev: null, regen: null, revived: false, counter: null, guarding: false, resistMul: {}, wokeTurn: 0 },
  }
}

const cloneState = (s: BattleState): BattleState => ({
  turn: s.turn,
  members: s.members.map((m) => ({ ...m, buffs: [...m.buffs], debuffs: [...m.debuffs], binds: { ...m.binds }, turnFx: {} })),
  enemy: { ...s.enemy, debuffs: [...s.enemy.debuffs], ailments: { ...s.enemy.ailments }, buffs: [...s.enemy.buffs], resistMul: { ...s.enemy.resistMul } },
})

// ---------------------------------------------------------------
// 味方の攻撃のダメージ（同じ条件の計算は覚えておく）
// ---------------------------------------------------------------

/** 1回の攻撃のダメージの分布（累積確率つき。乱数で引くため） */
interface HitDist {
  expected: number
  values: number[]
  cum: number[]
}

const toHitDist = (dist: Map<number, number>, expected: number): HitDist => {
  const values = [...dist.keys()].sort((a, b) => a - b)
  const cum: number[] = []
  let c = 0
  for (const v of values) cum.push((c += dist.get(v)!))
  return { expected, values, cum }
}

const sampleHit = (d: HitDist, rng: Rng) => {
  const r = rng() * d.cum[d.cum.length - 1]
  const i = d.cum.findIndex((c) => r < c)
  return d.values[i < 0 ? d.values.length - 1 : i]
}

/** 味方のクリティカル率（仕様書 5.4）、敵のクリティカル率 */
const PARTY_CRIT = 0.05
const ENEMY_CRIT = 0.03

export interface AttackProfile {
  /** 1回の攻撃のダメージ */
  hit: HitDist
  /** クリティカル（通常攻撃のみ） */
  crit: HitDist | null
  /** 攻撃回数（最小・最大。等確率） */
  hitsMin: number
  hitsMax: number
  /** ダブルアタックの発動率 */
  doubleChance: number
  /** 付ける状態異常（判定値つき） */
  inflicts: { id: InflictId; chance: number }[]
  /** 期待値（1回の行動の合計） */
  expected: number
  /** 攻撃の属性（複合なら2つ）。チェイスの判定に使う */
  elements: ElementId[]
}

/** 戦闘の計算で使う覚え書き（同じ設定の間は使い回す） */
export class SimContext {
  readonly setup: BattleSetup
  readonly actions: Map<string, SimAction[]>
  readonly stats: Map<string, ReturnType<typeof memberStats>>
  readonly spec: TargetSettings
  readonly es: EnemyStats
  /** 敵の行動パターン（setup.enemyAi でデータがあるとき） */
  readonly behavior: EnemyBehavior | undefined
  private cache = new Map<string, AttackProfile | null>()
  private enemyCache = new Map<string, HitDist>()

  constructor(setup: BattleSetup) {
    this.setup = setup
    this.actions = partyActions(setup.members)
    this.stats = new Map(setup.members.map((m) => [m.id, memberStats(m)]))
    this.spec = setup.enemy ? targetFromEnemy(setup.enemy, false) : { ...setup.target, guarding: false }
    this.es = enemyStats(setup)
    this.behavior = setup.enemyAi && setup.enemy ? findBehavior(setup.enemy.id) : undefined
  }

  /** 敵が行動するか（行動パターンか、敵の行動の表がある） */
  get enemyActs(): boolean {
    return !!this.behavior || this.setup.enemyActions.length > 0
  }

  member(id: string): Member {
    return this.setup.members.find((m) => m.id === id)!
  }

  action(memberId: string, actionId: string): SimAction | undefined {
    return this.actions.get(memberId)?.find((a) => a.id === actionId)
  }

  /**
   * 攻撃の分布。atk＝攻撃の強化（物理）の倍率、dealt＝与ダメージの倍率、def＝敵の防御の倍率、sleep＝敵が睡眠中、
   * taken＝敵の強化による属性ごとの受けるダメージの倍率（%）、guarding＝敵が防御中
   */
  attack(memberId: string, actionId: string, atk: number, dealt: number, def: number, sleep: boolean, taken: Partial<Record<ElementId, number>> = {}, guarding = false, imbue?: ElementId): AttackProfile | null {
    const key = `${memberId}|${actionId}|${atk}|${dealt}|${def}|${sleep}|${JSON.stringify(taken)}|${guarding}|${imbue ?? ''}`
    if (this.cache.has(key)) return this.cache.get(key)!
    const r = this.buildAttack(memberId, actionId, atk, dealt, def, sleep, taken, guarding, imbue)
    this.cache.set(key, r)
    return r
  }

  /** チェイス・トラッピングの1発（STR の単体攻撃。element の属性だけ、威力 power%）。期待値と分布 */
  extraHit(memberId: string, skill: Skill, level: number, element: ElementId, powerParam: string, atk: number, dealt: number, def: number, sleep: boolean, taken: Partial<Record<ElementId, number>>, guarding: boolean): AttackProfile | null {
    const fake: Skill = { ...skill, weapons: undefined, stance: undefined, effects: [{ type: 'damage', attack: 'str', element, target: 'enemy-single', powerParam }] }
    const key = `extra|${memberId}|${skill.id}|${powerParam}|${element}|${atk}|${dealt}|${def}|${sleep}|${JSON.stringify(taken)}|${guarding}`
    if (this.cache.has(key)) return this.cache.get(key)!
    const option = { id: skill.id, name: skill.name, skill: fake, level, unusable: null }
    const r = this.buildAttack(memberId, skill.id, atk, dealt, def, sleep, taken, guarding, undefined, option)
    this.cache.set(key, r)
    return r
  }

  private buildAttack(
    memberId: string, actionId: string, atk: number, dealt: number, def: number, sleep: boolean, taken: Partial<Record<ElementId, number>>, guarding: boolean,
    imbue?: ElementId, forced?: AttackOption,
  ): AttackProfile | null {
    const m = this.member(memberId)
    const skills = skillsByJob[m.jobId] ?? []
    // 序曲：通常攻撃を物理100%＋属性100%の複合属性にする（atwiki バード）。素手でも属性を付ける
    const real = findEquipment(m.weaponId)
    const weapon = imbue && actionId === 'normal' ? ({ ...(real ?? { id: 'fist', name: '素手', slot: 'weapon', atk: 0, jobs: [], sources: [] }), element: imbue } as Equipment) : real
    const option = forced ?? attackOptions(skills, m.skills, real, hasShield(m)).find((o) => o.id === actionId)
    if (!option) return null
    const effect = option.skill?.effects.find((e) => e.type === 'damage')
    // 攻撃の強化（攻撃力上昇）は物理だけ、与ダメージ（ウォークライ）はすべてに効くとした
    const tec = effect?.type === 'damage' && effect.attack === 'tec'
    // 睡眠中の敵は攻撃を 1.5倍受ける（Part 47：物理も属性も。EO Wiki は物理だけ。Part 47 を使う）
    const vulnMul = sleep ? 1.5 : 1
    const target = {
      ...this.spec,
      guarding,
      vuln: Object.fromEntries(Object.entries(this.spec.vuln).map(([k, v]) => [k, (v * vulnMul * (taken[k as ElementId] ?? 100)) / 100])) as TargetSettings['vuln'],
    }
    const built = buildAttackInput({
      level: m.level,
      stats: this.stats.get(memberId)!,
      row: m.row,
      skills,
      alloc: m.skills,
      weapon,
      option,
      boosted: false,
      critical: false,
      atkBuffRate: ((tec ? 100 : atk) * dealt) / 100,
      target,
      formulas,
      difficulty: this.setup.difficulty,
      defBuffRate: def,
    })
    if (!built) return null
    const elements = [built.element, ...(built.elemElement ? [built.elemElement] : [])]
    const r = calcDamage(built.input)
    const hit = toHitDist(r.distribution, r.expected)
    const inflicts = this.inflicts(m, option.skill)
    if (!option.skill) {
      const c = calcDamage({ ...built.input, critical: true } as AttackInput)
      const crit = toHitDist(c.distribution, c.expected)
      const doubleChance = doubleAttackChance(skills, m.skills)
      const per = (1 - PARTY_CRIT) * hit.expected + PARTY_CRIT * crit.expected
      return { hit, crit, hitsMin: 1, hitsMax: 1, doubleChance, inflicts, expected: per * (1 + doubleChance), elements }
    }
    if (!effect || effect.type !== 'damage') return null
    const values = skillValues(option.skill, option.level, false)!
    let lo = effect.hits ?? (effect.hitsParam ? values[effect.hitsParam] : 1)
    let hi = lo
    if (effect.minHitsParam && effect.maxHitsParam) {
      lo = values[effect.minHitsParam]
      hi = values[effect.maxHitsParam]
    }
    // 敵は1体なので、対象が複数のスキル（全体・ランダム・左右）も1体に1回分だけ当たる
    return { hit, crit: null, hitsMin: lo, hitsMax: hi, doubleChance: 0, inflicts, expected: (hit.expected * (lo + hi)) / 2, elements }
  }

  /** スキルが付ける状態異常と付与率（0〜1） */
  inflicts(m: Member, skill: Skill | null): { id: InflictId; chance: number }[] {
    if (!skill) return []
    const skills = skillsByJob[m.jobId] ?? []
    const lv = m.skills[skill.id] ?? 0
    const values = skillValues(skill, lv, false)
    if (!values) return []
    let boost = 100
    for (const s of skills) {
      const l = m.skills[s.id] ?? 0
      if (l === 0 || !s.levels) continue
      for (const e of s.effects) if (e.type === 'passive-stat' && e.stat === 'ailmentRate') boost = (boost * s.levels[l - 1].values[e.param]) / 100
    }
    const diff = formulas.difficulty[this.setup.difficulty].ailmentInflict
    const out: { id: InflictId; chance: number }[] = []
    for (const e of skill.effects) {
      const id: InflictId | null = e.type === 'ailment' ? e.ailment : e.type === 'bind' ? `bind-${e.bind}` : null
      if (!id || e.type === 'damage') continue
      const chanceParam = (e as Extract<SkillEffect, { type: 'ailment' | 'bind' }>).chanceParam
      out.push({ id, chance: inflictChance(values[chanceParam], boost, inflictVuln(this.setup.enemy ?? undefined, id), diff) })
    }
    return out
  }

  /** 敵の攻撃1回のダメージの分布 */
  enemyHit(action: EnemyAction, memberId: string, vulnRate: number, defRate: number, atkRate: number, guarding: boolean, critical: boolean): HitDist {
    const key = `${action.attack}|${action.element}|${action.power}|${memberId}|${vulnRate}|${defRate}|${atkRate}|${guarding}|${critical}`
    const hit = this.enemyCache.get(key)
    if (hit) return hit
    const m = this.member(memberId)
    const st = this.stats.get(memberId)!
    const back = m.row === 'back' && action.attack === 'str'
    const armor = armorDefense(m)
    const input: AttackInput = {
      kind: action.attack,
      attacker: { level: this.es.level, str: this.es.str, tec: this.es.tec, atkBoostRate: 100, weaponAtk: 0, masteryRate: 100, backRow: false, bow: false },
      power: action.power,
      vuln: vulnRate,
      atkBuffRate: atkRate,
      // 後列の味方は物理攻撃に対して (VIT + 防具) が2倍（EO Wiki）
      defender: { level: m.level, vit: st.vit * (back ? 2 : 1), armorDef: armor * (back ? 2 : 1), defBuffRate: defRate },
      critical,
      boostedNormal: false,
      guarding,
      formulas,
      difficulty: this.setup.difficulty,
      direction: 'enemy',
    }
    const r = calcDamage(input)
    const d = toHitDist(r.distribution, r.expected)
    this.enemyCache.set(key, d)
    return d
  }
}

/** 状態異常の持続ターン数の確率（EO Wiki「Ailment/Bind Recovery」。付けたターンを1ターン目と数える） */
const AILMENT_DURATION: { ids: InflictId[]; table: [number, number][] }[] = [
  { ids: ['sleep', 'paralysis', 'terror', 'poison'], table: [[4, 10], [5, 40], [6, 30], [7, 20]] },
  { ids: ['bind-head', 'bind-arm', 'bind-leg'], table: [[4, 20], [5, 50], [6, 30]] },
  { ids: ['confusion', 'blind', 'curse'], table: [[3, 15], [4, 55], [5, 30]] },
]

function ailmentDuration(id: InflictId, rng: Rng): number {
  const row = AILMENT_DURATION.find((r) => r.ids.includes(id))
  if (!row) return 1
  return pickWeighted(row.table, (x) => x[1], rng)[0]
}

// ---------------------------------------------------------------
// 1ターン
// ---------------------------------------------------------------

/** ターンの記録（画面に出す） */
export interface TurnLog {
  turn: number
  /** 行動した順 */
  entries: {
    actor: string
    /** 実際にした行動 */
    action: string
    /** 予定と違う行動になった理由 */
    fallback?: string
    /** 与えたダメージ（B2・B3）または受けたダメージ（B9） */
    damage?: number
    /** 回復した量 */
    healed?: number
    target?: string
    note?: string
  }[]
  enemyHp: number
  /** メンバー ID → ターン終了時の TP・HP */
  tp: Record<string, number>
  hp: Record<string, number>
  /** メンバー ID → かかっている強化（名前と残りターン）。'enemy' は敵の弱体 */
  effects: Record<string, string[]>
}

/** 敵が倒れたか */
export const enemyDown = (s: BattleState) => s.enemy.hp <= 0

/** 状態に合わせて実際にする行動（TP 不足・構えなし・封じ → 代わりの行動） */
function resolveAction(ctx: SimContext, f: Fighter, actionId: string, fallbackId: 'normal' | 'defend', turn: number): { action: SimAction; fallback?: string } {
  const a = ctx.action(f.id, actionId) ?? ctx.action(f.id, fallbackId)!
  const fb = ctx.action(f.id, fallbackId)!
  if (a.tp > f.tp) return { action: fb, fallback: `TP 不足（${a.name}）` }
  if (a.needsStance && !f.buffs.some((b) => b.skillId === a.needsStance)) return { action: fb, fallback: `構えがない（${a.name}）` }
  // 封じ：その部位を使うスキルは使えない（atwiki「システム」。頭＝術式・歌など、腕＝武器のスキル、脚＝ステップなど）
  const part = a.skill?.bodyPart
  if (part && part !== 'none' && (f.binds[part] ?? 0) >= turn) return { action: fb, fallback: `${{ head: '頭', arm: '腕', leg: '脚' }[part]}封じ（${a.name}）` }
  return { action: a }
}

/** 行動の速度（ターンの初めの状態で決める）。味方の弱体（敵の技で下がった速さ）も入れる */
function speedKey(ctx: SimContext, f: Fighter, a: SimAction, turn: number): number {
  const agiBuff = memberAgiRate(f, turn)
  const party = formulas.difficulty[ctx.setup.difficulty].partySpeed
  return Math.round((ctx.stats.get(f.id)!.agi * (agiBuff / 100) * a.speed * (party / 100)) / 5)
}

export interface TurnOptions {
  /** 乱数（null なら期待値で計算する） */
  rng: Rng | null
  /** メンバー ID → 予定の行動 ID */
  plan: Record<string, string>
  /** 予定の行動ができないときの代わり */
  fallback: 'normal' | 'defend'
  /** 記録を残すか（探索中は残さない） */
  log: boolean
  /** 敵の HP が 0 になっても敵が行動し続ける（耐久 B9：倒すかどうかに関係なく、何ターン耐えるかを見る） */
  endless?: boolean
}

/**
 * 状態異常で予定の行動ができないか（Part 47）。'confused' は混乱で予定の行動ができず、50% で敵に通常攻撃（残り 50% は味方を攻撃するが入れていない）。
 * 睡眠・スタン・起きたターンは行動できない。麻痺・テラーは 50% で行動できない
 */
function ailmentBlocks(f: Fighter, turn: number, rng: Rng | null): string | 'confused' | null {
  if (f.stunTurn === turn) return 'スタン'
  if (f.wokeTurn === turn) return '睡眠（起きたターン）'
  const a = f.ailment
  if (!a || a.lastTurn < turn) return null
  if (a.id === 'sleep') return INFLICT_NOTE.sleep
  if (a.id === 'confusion') return 'confused'
  if ((a.id === 'paralysis' || a.id === 'terror') && rng && rng() < 0.5) return INFLICT_NOTE[a.id]
  return null
}

/** 1ターン進める（元の状態は変えない） */
export function runTurn(ctx: SimContext, prev: BattleState, opts: TurnOptions): { state: BattleState; log: TurnLog | null } {
  const s = cloneState(prev)
  s.turn += 1
  const t = s.turn
  const rng = opts.rng
  const entries: TurnLog['entries'] = []
  for (const f of s.members) {
    f.guarding = false
    f.acted = false
  }
  s.enemy.counter = null
  s.enemy.guarding = false

  // ---- 敵の行動を決める（ターンの初め） ----
  const alive = () => opts.endless || !enemyDown(s)
  // 行動できないか（麻痺・テラーの判定はここで1回だけ）。混乱は 50% で通常攻撃に変わる
  const disabled = enemyDisabled(s.enemy, t, rng)
  let choice = ctx.enemyActs && !disabled && alive() ? chooseEnemyAction(ctx, s, rng) : null
  if (choice && rng && (s.enemy.ailments.confusion ?? 0) >= t && ctx.setup.enemy) {
    // 混乱：50% で味方のだれかに通常攻撃、残りは仲間（自分の側）を攻撃する（1対1なので何もしない）
    choice = rng() < 0.5 ? (ctx.behavior ? { kind: 'skill', id: 'normal', skill: null, note: '混乱' } : choice) : { kind: 'skip', id: 'confused', name: '行動できない', note: '混乱' }
  }

  // ---- 行動順 ----
  type Slot = { kind: 'member'; f: Fighter; action: SimAction; fallback?: string; key: number; tie: number; index: number } | { kind: 'enemy'; key: number; tie: number; index: number }
  const slots: Slot[] = []
  s.members.forEach((f, i) => {
    if (!f.alive) return
    const r = resolveAction(ctx, f, opts.plan[f.id] ?? opts.fallback, opts.fallback, t)
    slots.push({ kind: 'member', f, action: r.action, fallback: r.fallback, key: r.action.priority ? Infinity : speedKey(ctx, f, r.action, t), tie: rng ? rng() : 0, index: i })
  })
  if (choice) {
    const agiRate = ((product(s.enemy.debuffs, (m) => (m.stat === 'agi' ? 100 - m.value : null)) * product(s.enemy.buffs, (m) => (m.stat === 'agi' ? 100 + m.value : null))) / 100) * ((s.enemy.ailments['bind-leg'] ?? 0) >= t ? 0.7 : 1)
    slots.push({ kind: 'enemy', key: Math.round((ctx.es.agi * (agiRate / 100) * (enemyChoiceSpeed(choice) / 100)) / 5), tie: rng ? rng() : 0, index: s.members.length })
  }
  // アザーズステップ：選んだ味方を、ターンの最初（使ったレンジャーのすぐ後）に動けるようにする（atwiki レンジャー）
  for (const sl of slots) {
    if (sl.kind !== 'member' || sl.action.special !== 'others-step' || !sl.action.targetId) continue
    const target = slots.find((x) => x.kind === 'member' && x.f.id === sl.action.targetId && x !== sl)
    if (target && target.key !== Infinity) target.key = Number.MAX_SAFE_INTEGER
  }
  slots.sort((a, b) => b.key - a.key || (rng ? a.tie - b.tie : a.index - b.index))

  for (const slot of slots) {
    if (slot.kind === 'enemy') {
      // 行動の前に起こされた・スタンしたら行動できない
      if (alive() && s.enemy.wokeTurn !== t && (s.enemy.ailments.stun ?? 0) !== t && (s.enemy.ailments.sleep ?? 0) < t) enemyTurn(ctx, s, choice!, rng, entries)
      continue
    }
    const f = slot.f
    if (!f.alive) continue
    f.acted = true
    const blocked = ailmentBlocks(f, t, rng)
    if (blocked === 'confused') {
      // 混乱：50% で敵に通常攻撃、残りは味方を攻撃する（味方へのダメージは入れていない）
      if (!rng || rng() < 0.5) {
        const entry: TurnLog['entries'][number] = { actor: f.name, action: '通常攻撃', note: '混乱' }
        memberAttack(ctx, s, f, ctx.action(f.id, 'normal')!, rng, entry, !rng ? 0.5 : 1)
        entries.push(entry)
      } else entries.push({ actor: f.name, action: '行動できない', note: '混乱（味方を攻撃。ダメージは入れていない）' })
      continue
    }
    if (blocked) {
      entries.push({ actor: f.name, action: '行動できない', note: blocked })
      continue
    }
    const a = slot.action
    f.tp -= a.tp
    const entry: TurnLog['entries'][number] = { actor: f.name, action: a.name, ...(slot.fallback ? { fallback: slot.fallback } : {}) }
    if (a.kind === 'defend') f.guarding = true
    else if (a.special && a.kind !== 'attack') castSpecial(s, f, a, entry)
    else if (a.kind === 'attack' || a.kind === 'ailment') memberAttack(ctx, s, f, a, rng, entry)
    else if (a.kind === 'buff' || a.kind === 'debuff') castEffect(ctx, s, f, a, entry)
    else if (a.kind === 'heal') castHeal(ctx, s, f, a, entry)
    entries.push(entry)
    // 敵の反撃（クロスカウンター）：物理攻撃に反撃する
    if (s.enemy.counter && !enemyDown(s) && a.kind === 'attack' && isPhysical(a)) counterAttack(ctx, s, f, rng, entries)
  }

  // ---- ターンの終わり：継続回復・毒、持続の切れた強化・弱体と状態異常を消す ----
  const healRate = formulas.difficulty[ctx.setup.difficulty].healing
  for (const f of s.members) {
    if (!f.alive) continue
    for (const b of f.buffs) {
      if (!b.regen) continue
      const amount = b.regen.ratio ? Math.floor((f.maxHp * b.regen.amount) / 100) : b.regen.amount
      f.hp = Math.min(f.maxHp, f.hp + Math.floor((amount * healRate) / 100))
    }
    // 安らぎの子守唄：ターンの終わりに最大TP の一定割合を回復（atwiki バード）
    for (const b of f.buffs) for (const m of b.mods) if (m.stat === 'tpRegen') f.tp = Math.min(ctx.stats.get(f.id)!.tp, f.tp + Math.floor((ctx.stats.get(f.id)!.tp * m.value) / 100))
    // 毒：ターンの終わりに決まったダメージ（atwiki「システム」）
    if (f.ailment?.id === 'poison' && f.ailment.lastTurn >= t && f.ailment.poison) {
      f.hp -= f.ailment.poison
      entries.push({ actor: f.name, action: '毒', damage: f.ailment.poison })
      if (f.hp <= 0) downOrEndure(f, t, rng)
    }
  }
  if (s.enemy.regen && s.enemy.regen.lastTurn >= t && !enemyDown(s)) s.enemy.hp = Math.min(s.enemy.maxHp, s.enemy.hp + s.enemy.regen.amount)
  for (const f of s.members) {
    const before = f.buffs
    f.buffs = f.buffs.filter((b) => b.lastTurn > t)
    f.debuffs = f.debuffs.filter((b) => b.lastTurn > t)
    if (before.length !== f.buffs.length) refreshMaxHp(f)
    if (f.ailment && f.ailment.lastTurn <= t) f.ailment = null
    for (const p of PARTS) if ((f.binds[p] ?? Infinity) <= t) delete f.binds[p]
  }
  s.enemy.debuffs = s.enemy.debuffs.filter((b) => b.lastTurn > t)
  s.enemy.buffs = s.enemy.buffs.filter((b) => b.lastTurn > t)
  if (s.enemy.regen && s.enemy.regen.lastTurn <= t) s.enemy.regen = null
  for (const [id, last] of Object.entries(s.enemy.ailments)) if (last! <= t) delete s.enemy.ailments[id as InflictId]
  s.enemy.prev = choice ? (choice.kind === 'manual' ? choice.action.name : choice.id) : null

  if (!opts.log) return { state: s, log: null }
  const remain = (b: ActiveEffect) => `${b.name}${b.lastTurn === Infinity ? '' : `（残り${b.lastTurn - t}）`}`
  const memberEffects = (f: Fighter) => [
    ...f.buffs.map(remain),
    ...f.debuffs.map((b) => `弱体：${remain(b)}`),
    ...(f.ailment ? [`${INFLICT_NOTE[f.ailment.id]}（残り${f.ailment.lastTurn - t}）`] : []),
    ...PARTS.filter((p) => f.binds[p] !== undefined).map((p) => `${INFLICT_NOTE[`bind-${p}`]}（残り${f.binds[p]! - t}）`),
  ]
  const log: TurnLog = {
    turn: t,
    entries,
    enemyHp: Math.max(0, s.enemy.hp),
    tp: Object.fromEntries(s.members.map((f) => [f.id, f.tp])),
    hp: Object.fromEntries(s.members.map((f) => [f.id, Math.max(0, f.hp)])),
    effects: {
      ...Object.fromEntries(s.members.map((f) => [f.id, memberEffects(f)])),
      enemy: [...s.enemy.debuffs.map(remain), ...s.enemy.buffs.map((b) => `強化：${remain(b)}`), ...Object.keys(s.enemy.ailments)],
    },
  }
  return { state: s, log }
}

/** 物理の攻撃か（通常攻撃か、STR の攻撃スキル） */
function isPhysical(a: SimAction): boolean {
  if (!a.skill) return true
  return a.skill.effects.some((e) => e.type === 'damage' && e.attack !== 'tec')
}

/** クロスカウンター：攻撃した人に反撃する */
function counterAttack(ctx: SimContext, s: BattleState, f: Fighter, rng: Rng | null, entries: TurnLog['entries']) {
  const c = s.enemy.counter!
  enemyStrike(ctx, s, f, { element: c.element, power: c.power }, null, { accuracy: c.accuracy, normal: false, ignoreDef: false, weight: 1 }, rng, entries, '反撃')
}

/** 敵が行動できない状態異常（睡眠・麻痺・石化・スタン）。麻痺は毎ターン確実に止まるとした（未確認） */
function enemyDisabled(e: EnemyState, t: number, rng: Rng | null = null): boolean {
  if (e.wokeTurn === t || (e.ailments.stun ?? 0) === t || (e.ailments.sleep ?? 0) >= t) return true
  // 麻痺・テラー：50% で行動できない（Part 47）。期待値の計算では行動するとした（期待値では状態異常が付かない）
  return rng !== null && (['paralysis', 'terror'] as InflictId[]).some((id) => (e.ailments[id] ?? 0) >= t) && rng() < 0.5
}

/** 最大HPの強化（蛮族の行進曲・ヘルズクライ）を反映する */
function refreshMaxHp(f: Fighter) {
  const rate = product(f.buffs, (m) => (m.stat === 'maxHp' ? m.value : null))
  const next = Math.floor((f.baseMaxHp * rate) / 100)
  // 上がっても今の HP は増えない（2026-10-18 の実測：蛮族の行進曲で HP の数値はそのまま、バーだけ短くなった）。下がったら今の HP を最大HP に合わせる
  f.maxHp = next
  f.hp = Math.min(f.hp, f.maxHp)
}

/** 敵の防御の倍率（味方の弱体と敵の自己強化）と、敵の強化による属性ごとの受けるダメージの倍率（%） */
export function enemyDefense(s: BattleState): { def: number; taken: Partial<Record<ElementId, number>> } {
  const def = (product(s.enemy.debuffs, (m) => (m.stat === 'physDef' && m.appliesTo === 'defense' ? 100 - m.value : null)) * product(s.enemy.buffs, (m) => (m.stat === 'physDef' ? 100 + m.value : null))) / 100
  const taken: Partial<Record<ElementId, number>> = {}
  const all: ElementId[] = ['slash', 'bash', 'pierce', 'fire', 'ice', 'volt']
  for (const b of s.enemy.buffs) for (const m of b.mods) {
    const els = m.stat === 'damageTaken' ? (m.elements ?? all) : m.stat === 'physTaken' ? PHYSICAL : m.stat === 'elemTaken' ? (['fire', 'ice', 'volt'] as ElementId[]) : []
    for (const e of els) taken[e] = ((taken[e] ?? 100) * m.value) / 100
  }
  return { def, taken }
}

/** 味方の攻撃の倍率（強化と、敵の技による弱体。腕封じは STR −30%（Part 47）を物理の攻撃の倍率 ×0.7 として近似） */
export function memberAtkRates(f: Fighter, turn: number): { atk: number; dealt: number } {
  const arm = (f.binds.arm ?? 0) >= turn ? 0.7 : 1
  return {
    atk: ((product(f.buffs, (m) => (m.stat === 'physAtk' ? 100 + m.value : null)) * product(f.debuffs, (m) => (m.stat === 'physAtk' ? 100 - m.value : null))) / 100) * arm,
    dealt: product(f.buffs, (m) => (m.stat === 'damageDealt' ? m.value : null)),
  }
}

/** 味方の速さの倍率（%）：強化・弱体と脚封じ（AGI −30%、Part 47） */
export function memberAgiRate(f: Fighter, turn: number): number {
  const leg = (f.binds.leg ?? 0) >= turn ? 0.7 : 1
  return ((product(f.buffs, (m) => (m.stat === 'agi' ? 100 + m.value : null)) * product(f.debuffs, (m) => (m.stat === 'agi' ? 100 - m.value : null))) / 100) * leg
}

/** 敵に与えるダメージを反映する（ゴーレムのリジェネ中の起き上がり） */
function hitEnemy(s: BattleState, dmg: number) {
  s.enemy.hp -= dmg
  if (s.enemy.hp <= 0 && s.enemy.regen?.revive && !s.enemy.revived && s.enemy.regen.lastTurn >= s.turn) {
    s.enemy.hp = s.enemy.regen.revive
    s.enemy.revived = true
  }
}

/** 敵に与えるダメージ（マンティコアの半減・既に倒れている）を反映して、与えた量を返す */
function dealToEnemy(ctx: SimContext, s: BattleState, dmg: number, rng: Rng | null): number {
  const halve = ctx.behavior?.halveDamageChance
  if (halve) dmg = rng ? (rng() * 100 < halve ? Math.floor(dmg / 2) : dmg) : dmg * (1 - halve / 200)
  if (enemyDown(s)) return 0
  hitEnemy(s, dmg)
  return dmg
}

/** 攻撃1回分のダメージ（乱数なら引く、期待値なら期待値 × scale） */
function rollAttack(p: AttackProfile, rng: Rng | null, scale: number): number {
  if (!rng) return p.expected * scale
  const one = () => (p.crit && rng() < PARTY_CRIT ? sampleHit(p.crit, rng) : sampleHit(p.hit, rng))
  const n = p.hitsMin + Math.floor(rng() * (p.hitsMax - p.hitsMin + 1))
  let dmg = 0
  for (let i = 0; i < n; i++) dmg += one()
  if (p.doubleChance > 0 && rng() < p.doubleChance) dmg += one()
  return dmg
}

/** 呪い：攻撃すると与えたダメージの半分が自分に返る（atwiki「システム」） */
function curseBacklash(s: BattleState, f: Fighter, dmg: number, rng: Rng | null, entry: TurnLog['entries'][number]) {
  if (f.ailment?.id !== 'curse' || f.ailment.lastTurn < s.turn || dmg <= 0) return
  f.hp -= rng ? Math.floor(dmg / 2) : dmg / 2
  entry.note = `${entry.note ? `${entry.note}・` : ''}呪いで${Math.floor(dmg / 2)}返る`
  if (f.hp <= 0) downOrEndure(f, s.turn, rng, entry)
}

function memberAttack(ctx: SimContext, s: BattleState, f: Fighter, a: SimAction, rng: Rng | null, entry: TurnLog['entries'][number], scale = 1) {
  const { atk, dealt } = memberAtkRates(f, s.turn)
  const { def, taken } = enemyDefense(s)
  const asleep = (s.enemy.ailments.sleep ?? 0) >= s.turn
  const m = ctx.member(f.id)
  if (a.special === 'pain-trade') {
    // ペイントレード：(最大HP − 今の HP) × スキル倍率 × レベル補正 の固定ダメージ（atwiki カースメーカー）
    const values = skillValues(a.skill!, a.level, false)!
    const rate = levelCorrection(formulas, m.level, ctx.es.level).rate
    const dmg = dealToEnemy(ctx, s, Math.floor((((f.maxHp - Math.max(0, f.hp)) * values.p1) / 100) * (rate / 100)), rng)
    entry.damage = dmg
    curseBacklash(s, f, dmg, rng, entry)
    return
  }
  if (a.special === 'the-end') {
    // ジエンド：HP が条件の割合以下の敵を即死させる（即死の耐性で判定）。条件を満たさなければ外れ（atwiki ダークハンター）
    const values = skillValues(a.skill!, a.level, false)!
    const hpPct = (s.enemy.hp / s.enemy.maxHp) * 100
    if (hpPct > values.p1) {
      entry.note = '条件の HP を満たさず外れ'
      return
    }
    const chance = inflictVuln(ctx.setup.enemy ?? undefined, 'death') / 100
    if (rng) {
      const note = inflictEnemy(ctx, s, 'death', chance, rng)
      entry.note = note ? '即死' : '即死しなかった'
    } else s.enemy.hp *= 1 - Math.min(1, chance)
    return
  }
  if (a.kind === 'attack') {
    const imbue = a.id === 'normal' ? f.buffs.find((b) => b.mods.some((x) => x.stat === 'imbue'))?.mods[0].elements?.[0] : undefined
    const p = ctx.attack(f.id, a.id, atk, dealt, def, asleep, taken, s.enemy.guarding, imbue)
    if (p) {
      const dmg = dealToEnemy(ctx, s, rollAttack(p, rng, scale), rng)
      entry.damage = dmg
      curseBacklash(s, f, dmg, rng, entry)
      // ドレインバイト：与えたダメージの一部を回復する（atwiki ダークハンター）
      if (a.skill?.id === 'dark-hunter-drain-bite' && dmg > 0 && f.alive) {
        const heal = (dmg * skillValues(a.skill, a.level, false)!.p2) / 100
        f.hp = Math.min(f.maxHp, f.hp + (rng ? Math.floor(heal) : heal))
      }
      // 攻撃を受けると睡眠が解け、起きたターンは行動できない（atwiki「システム」、Part 47）
      if (asleep && dmg > 0) {
        delete s.enemy.ailments.sleep
        s.enemy.wokeTurn = s.turn
      }
      // チェイス：この攻撃の属性（炎・氷・雷）に構えている味方が1度だけ追撃する
      if (dmg > 0) for (const n of chaseFollowUp(ctx, s, f, p.elements, rng, scale)) entry.note = `${entry.note ? `${entry.note}・` : ''}${n}`
    }
  }
  // 状態異常は乱数で計算するときだけ判定する（期待値の計算では付かないものとする）
  if (rng) {
    for (const x of ctx.inflicts(m, a.skill)) {
      const note = inflictEnemy(ctx, s, x.id, x.chance, rng)
      if (note) entry.note = `${entry.note ? `${entry.note}・` : ''}${note}`
    }
  }
}

/**
 * チェイス（atwiki ソードマン）：使ったターン、味方の属性攻撃に反応して1度だけ追撃する。追撃は属性だけで物理を含まず、STR で計算する。
 * 追撃は呪いの反射を受けない。ダブルアタックへの2回の追撃は入れていない（1度だけ）。
 * 2026-10-18 の実測では、敵2体への大爆炎の術式1回に、敵ごとに1回ずつ（計2回）追撃した。1対1の戦闘では対象が1体なので結果は変わらない
 */
function chaseFollowUp(ctx: SimContext, s: BattleState, attacker: Fighter, elements: ElementId[], rng: Rng | null, scale: number): string[] {
  const notes: string[] = []
  for (const c of s.members) {
    if (!c.alive || c === attacker || !c.turnFx.chase) continue
    for (const ch of c.turnFx.chase) {
      if (ch.used || !elements.includes(ch.element) || enemyDown(s)) continue
      ch.used = true
      const { atk, dealt } = memberAtkRates(c, s.turn)
      const { def, taken } = enemyDefense(s)
      const p = ctx.extraHit(c.id, ch.skill, ch.level, ch.element, 'dmg', atk, dealt, def, (s.enemy.ailments.sleep ?? 0) >= s.turn, taken, s.enemy.guarding)
      if (p) notes.push(`${c.name}の${ch.skill.name} ${Math.round(dealToEnemy(ctx, s, rollAttack(p, rng, scale), rng))}`)
    }
  }
  return notes
}

/** 戦闘不能になる HP になったとき：医術防御II がかかっていれば、その確率で HP 1 で残り、強化・弱体がすべて消える（atwiki メディック） */
function downOrEndure(f: Fighter, turn: number, rng: Rng | null, entry?: { note?: string }) {
  const endure = f.buffs.find((b) => b.mods.some((m) => m.stat === 'endure'))
  const p = endure ? endure.mods.find((m) => m.stat === 'endure')!.value : 0
  // 期待値の計算では、発動率が 50% 以上なら残るとした
  if (p > 0 && (rng ? rng() * 100 < p : p >= 50)) {
    f.hp = 1
    f.buffs = []
    f.debuffs = []
    refreshMaxHp(f)
    if (entry) entry.note = `${entry.note ? `${entry.note}・` : ''}医術防御IIで HP1`
    return
  }
  knockDown(f, turn)
}

/**
 * 敵に状態異常・封じをかける（乱数）。返り値は記録に出す文字（かからなければ null）。
 * 封じの耐性の変化は HD版の決まり（EO Wiki「Accumulative Resistance」の HD版）：外れるたびに付与率に +25%（上限 90%）、入るとその部位の耐性が −25%（下限 5%、重ならない）。
 * 状態異常は変化しない。封じの付与率の上限は 90%、状態異常は 100%（Part 47）
 */
function inflictEnemy(ctx: SimContext, s: BattleState, id: InflictId, chance: number, rng: Rng): string | null {
  let p = chance
  const bind = id.startsWith('bind-')
  if (bind) {
    const vuln = inflictVuln(ctx.setup.enemy ?? undefined, id)
    if (s.enemy.resistMul[`reduced:${id}`] && vuln > 0) p = (p * Math.max(5, vuln - 25)) / vuln
    p = Math.min(0.9, p + (s.enemy.resistMul[`bonus:${id}`] ?? 0))
  }
  const landed = rng() < Math.min(1, p)
  if (bind) {
    if (landed) {
      s.enemy.resistMul[`bonus:${id}`] = 0
      s.enemy.resistMul[`reduced:${id}`] = 1
    } else s.enemy.resistMul[`bonus:${id}`] = (s.enemy.resistMul[`bonus:${id}`] ?? 0) + 0.25
  }
  if (!landed) return null
  if (id === 'death' || id === 'petrify') {
    // 即死は残りの HP 分のダメージ、石化は倒れたのと同じ（1対1なので戦闘が終わる）
    s.enemy.hp = 0
    return INFLICT_LABELS[id]
  }
  if (id === 'stun') {
    s.enemy.ailments.stun = s.turn
    return INFLICT_LABELS[id]
  }
  if (!id.startsWith('bind-')) {
    const current = AILMENT_PRIORITY.find((a) => a !== 'petrify' && (s.enemy.ailments[a as InflictId] ?? 0) >= s.turn)
    if (!ailmentReplaces(current, id)) return `${INFLICT_LABELS[id]}（${INFLICT_LABELS[current as InflictId]}に負けた）`
    if (current) delete s.enemy.ailments[current as InflictId]
  }
  // 重苦の呪言：持続 ÷ 回復率補正（切り上げ。EO Wiki）
  const relapse = product(s.enemy.debuffs, (m) => (m.stat === 'ailmentRecovery' ? m.value * 100 : null)) / 100
  s.enemy.ailments[id] = Math.max(s.enemy.ailments[id] ?? 0, s.turn + Math.ceil(ailmentDuration(id, rng) / relapse) - 1)
  return INFLICT_LABELS[id]
}

function effectOf(skill: Skill, type: 'buff' | 'debuff') {
  return skill.effects.find((e): e is Extract<SkillEffect, { type: 'buff' | 'debuff' }> => e.type === type)
}

function castEffect(ctx: SimContext, s: BattleState, f: Fighter, a: SimAction, entry: TurnLog['entries'][number]) {
  const skill = a.skill!
  const values = skillValues(skill, a.level, false)!
  const e = effectOf(skill, a.kind === 'debuff' ? 'debuff' : 'buff')
  if (!e) return
  const effect: ActiveEffect = {
    skillId: skill.id,
    name: `${skill.name} Lv${a.level}`,
    mods: e.modifiers.map((m) => ({ stat: m.stat, value: values[m.param], appliesTo: m.appliesTo, elements: m.elements })),
    lastTurn: e.untilBattleEnd ? Infinity : s.turn + (e.durationTurns ?? 1) - 1,
    oneShot: !!e.oneShot,
  }
  if (a.kind === 'debuff') {
    const [debuffs, buffs, canceled] = applyEffect(s.enemy.debuffs, s.enemy.buffs, effect)
    s.enemy.debuffs = debuffs
    s.enemy.buffs = buffs
    entry.target = '敵'
    if (canceled) entry.note = '敵の強化と打ち消し合った'
    return
  }
  const caster = ctx.member(f.id)
  const targets = s.members.filter((x) => {
    if (!x.alive) return false
    if (e.target === 'self') return x.id === f.id
    if (e.target === 'ally-row') return ctx.member(x.id).row === (e.row ?? caster.row)
    // 1人が対象の強化は、自分にかける（シミュレーションでは対象を選ばない）
    if (e.target === 'ally-single') return x.id === f.id
    return true
  })
  for (const x of targets) {
    const [buffs, debuffs, canceled] = applyEffect(x.buffs, x.debuffs, effect)
    x.buffs = buffs
    x.debuffs = debuffs
    if (canceled) entry.note = `${entry.note ? `${entry.note}・` : ''}${x.name}の弱体と打ち消し合った`
    refreshMaxHp(x)
  }
  entry.target = e.target === 'self' ? '自分' : e.target === 'ally-row' ? `${(e.row ?? caster.row) === 'front' ? '前' : '後'}列` : e.target === 'ally-single' ? '自分' : '味方全体'
}

/** 個別に計算するスキル（攻撃以外）。atwiki の各ジョブのページの説明による */
function castSpecial(s: BattleState, f: Fighter, a: SimAction, entry: TurnLog['entries'][number]) {
  const skill = a.skill!
  const values = skillValues(skill, a.level, false) ?? {}
  const name = `${skill.name} Lv${a.level}`
  const target = a.targetId ? s.members.find((x) => x.id === a.targetId) : undefined
  const put = (x: Fighter, e: ActiveEffect) => {
    const [buffs, debuffs] = applyEffect(x.buffs, x.debuffs, e)
    x.buffs = buffs
    x.debuffs = debuffs
  }
  switch (a.special) {
    case 'imbue': {
      // 序曲：味方1人の通常攻撃を戦闘終了まで複合属性にする（歌。強化の枠を使う）。ほかの序曲は外す（1人に1つと仮定）
      if (!target?.alive) break
      target.buffs = target.buffs.filter((b) => !b.mods.some((m) => m.stat === 'imbue'))
      put(target, { skillId: skill.id, name, mods: [{ stat: 'imbue', value: 0, elements: [specialElement(skill.id)!] }], lastTurn: Infinity, oneShot: false })
      entry.target = target.name
      break
    }
    case 'dispel': {
      // 沈静なる奇想曲：敵の強化をレベルに応じた数だけ消す（古いものから。LP Archive）
      const n = values.p1 ?? 1
      s.enemy.buffs = s.enemy.buffs.slice(n)
      entry.target = '敵'
      break
    }
    case 'tp-regen':
      for (const x of s.members) if (x.alive) put(x, { skillId: skill.id, name, mods: [{ stat: 'tpRegen', value: values.p1 }], lastTurn: Infinity, oneShot: false })
      entry.target = '味方全体'
      break
    case 'endure':
      // 医術防御II：5ターンの間、戦闘不能になるダメージを受けても発動率で HP1 で残る
      for (const x of s.members) if (x.alive) put(x, { skillId: skill.id, name, mods: [{ stat: 'endure', value: values.p1 }], lastTurn: s.turn + 4, oneShot: false })
      entry.target = '味方全体'
      break
    case 'evade-once':
      f.turnFx.evade = true
      entry.target = '自分'
      break
    case 'parry':
      f.turnFx.parry = { first: values.p1, repeat: values.p2 ?? 0, succeeded: 0 }
      entry.target = '自分'
      break
    case 'chase':
      f.turnFx.chase = [...(f.turnFx.chase ?? []), { element: specialElement(skill.id)!, skill, level: a.level, used: false }]
      break
    case 'trapping':
      f.turnFx.trap = { skill, level: a.level }
      break
    case 'refresh':
      // リフレッシュ：味方全員の状態異常（封じ以外）を治す
      for (const x of s.members) if (x.alive) x.ailment = null
      entry.target = '味方全体'
      break
    case 'bind-recovery': {
      // バインドリカバリ：味方1人の封じをレベルに応じた数だけ治す（頭・腕・脚の順とした）
      if (!target?.alive) break
      let n = values.p1 ?? 1
      for (const part of PARTS) if (n > 0 && target.binds[part] !== undefined) {
        delete target.binds[part]
        n -= 1
      }
      entry.target = target.name
      break
    }
    case 'arm-recovery':
      delete f.binds.arm
      entry.target = '自分'
      break
    case 'others-step':
      entry.target = target?.name
      break
    case 'recovery':
      // 破邪の鎮魂歌：味方全体、戦闘終了まで（歌）。この後にかかる状態異常・封じの持続を短くする
      for (const x of s.members) if (x.alive) put(x, { skillId: skill.id, name, mods: [{ stat: 'ailmentRecovery', value: values.p1 }], lastTurn: Infinity, oneShot: false })
      entry.target = '味方全体'
      break
    case 'relapse': {
      // 重苦の呪言：敵の状態異常・封じの持続を長くする（持続は5ターンと仮定）
      const [debuffs, buffs] = applyEffect(s.enemy.debuffs, s.enemy.buffs, { skillId: skill.id, name, mods: [{ stat: 'ailmentRecovery', value: values.p1 }], lastTurn: s.turn + 4, oneShot: false })
      s.enemy.debuffs = debuffs
      s.enemy.buffs = buffs
      entry.target = '敵'
      break
    }
    case 'cloak':
      // シャドウエントリ：5ターン、この率で敵の狙いの候補から外れる（EO Wiki の HD版の決まり）
      put(f, { skillId: skill.id, name, mods: [{ stat: 'cloak', value: values.p1 }], lastTurn: s.turn + 4, oneShot: false })
      entry.target = '自分'
      break
  }
}

function castHeal(ctx: SimContext, s: BattleState, f: Fighter, a: SimAction, entry: TurnLog['entries'][number]) {
  const skill = a.skill!
  const m = ctx.member(f.id)
  const e = skill.effects.find((x): x is Extract<SkillEffect, { type: 'heal' }> => x.type === 'heal')
  if (!e) return
  const values = skillValues(skill, a.level, false)!
  const alive = s.members.filter((x) => x.alive)
  // 1人が対象なら、HP の割合が最も低い味方
  const lowest = [...alive].sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0]
  const targets = e.target === 'ally-all' ? alive : e.target === 'self' ? alive.filter((x) => x.id === f.id) : lowest ? [lowest] : []
  if (e.timing === 'per-turn') {
    const effect: ActiveEffect = {
      skillId: skill.id,
      name: `${skill.name} Lv${a.level}`,
      mods: [],
      lastTurn: e.untilBattleEnd ? Infinity : s.turn + (e.durationTurns ?? 1) - 1,
      oneShot: false,
      regen: { amount: values[e.amountParam], ratio: e.scaling === 'max-hp-ratio' },
    }
    for (const x of targets) x.buffs = addEffect(x.buffs, effect)
    entry.target = targets.length > 1 ? '味方全体' : targets[0]?.name
    return
  }
  let total = 0
  for (const x of targets) {
    let amount: number
    // 最大HPに対する割合の回復にも難易度の「回復」をかける（未確認）
    if (e.scaling === 'max-hp-ratio') amount = Math.floor((Math.floor((x.maxHp * values[e.amountParam]) / 100) * formulas.difficulty[ctx.setup.difficulty].healing) / 100)
    else amount = healAmount(skillsByJob[m.jobId] ?? [], skill, a.level, m.skills, ctx.setup.difficulty)?.amount ?? 0
    const before = x.hp
    x.hp = Math.min(x.maxHp, x.hp + amount)
    total += x.hp - before
  }
  entry.healed = total
  entry.target = targets.length > 1 ? '味方全体' : targets[0]?.name
}

// ---------------------------------------------------------------
// 敵の行動（B9）
// ---------------------------------------------------------------

/**
 * 狙われ方（EO Wiki「Enemy Aggro」。出典要求中の値。HD版）：
 * - 挑発中の味方がいれば、狙われ率の確率でその味方（複数なら率の高い方）。外れたら次の基本の狙い方
 * - 前列 90%／後列 10%（片方の列にしかいなければその列）。列の中では HP が多い順に 60%／30%／10%（2人なら 60:30 の比）
 */
export function chooseTarget(ctx: SimContext, s: BattleState, rng: Rng): Fighter | null {
  return drawTarget(s, targetDistribution(ctx, s), rng)
}

function chooseRow(ctx: SimContext, alive: Fighter[], rng: Rng): 'front' | 'back' {
  const hasFront = alive.some((f) => ctx.member(f.id).row === 'front')
  const hasBack = alive.some((f) => ctx.member(f.id).row === 'back')
  if (!hasBack) return 'front'
  if (!hasFront) return 'back'
  return rng() < 0.9 ? 'front' : 'back'
}

/** 敵の攻撃が当たる確率（EO Wiki「Hit Rate」）。味方の回避の強化・弱体は入れない */
export function enemyHitChance(ctx: SimContext, s: BattleState, action: EnemyAction, f: Fighter): number {
  // 睡眠中（EO Wiki の HD版）と脚封じ中（HD版の攻略サイト al-gest「回避不可」）は回避できない
  if ((f.ailment?.id === 'sleep' && f.ailment.lastTurn >= s.turn) || (f.binds.leg ?? 0) >= s.turn) return 1
  const m = ctx.member(f.id)
  // 脚封じは AGI −30%（Part 47）。速さの強化・弱体も入れる
  const agi = (ctx.stats.get(f.id)!.agi * memberAgiRate(f, s.turn)) / 100
  // 敵の命中：味方の弱体（トリックステップ）、敵の盲目・頭封じ（命中 −30%。盲目の量は Part 47 では不明なので LP Archive の別の回の 30% とした）
  const acc = product(s.enemy.debuffs, (x) => (x.stat === 'accuracy' ? x.value : null)) * ((s.enemy.ailments.blind ?? 0) >= s.turn ? 0.7 : 1) * ((s.enemy.ailments['bind-head'] ?? 0) >= s.turn ? 0.7 : 1)
  const diff = formulas.difficulty[ctx.setup.difficulty].enemyAccuracy
  const p = ((ctx.es.agi + ctx.es.level + 500) / (agi + m.level + 500)) * (action.accuracy / 100) * (acc / 100) * (diff / 100)
  return Math.max(0, Math.min(1, p))
}

/** 味方の、この攻撃に対する属性倍率（%）・防御の倍率（%）・被ダメージの倍率（%） */
function defenseRates(ctx: SimContext, f: Fighter, action: EnemyAction): { vuln: number; def: number; taken: number } {
  const m = ctx.member(f.id)
  const skills = skillsByJob[m.jobId] ?? []
  const physical = action.attack === 'str'
  const hits = (x: ActiveEffect['mods'][number]) => !x.elements || x.elements.includes(action.element)
  let vuln = product(f.buffs, (x) => (x.appliesTo === 'resistance' && hits(x) ? Math.max(0, 100 - x.value) : null))
  // 防具の属性の耐性（「斬突壊 耐性5%↑」など）：属性倍率から引く（未検証）
  vuln = (vuln * Math.max(0, 100 - armorResist(m, action.element))) / 100
  // パッシブの物理耐性（DEFブースト）：物理の属性倍率を下げる（推定）
  if (physical) {
    for (const sk of skills) {
      const lv = m.skills[sk.id] ?? 0
      if (lv === 0 || !sk.levels) continue
      for (const e of sk.effects) if (e.type === 'passive-stat' && e.stat === 'physResist') vuln = (vuln * (100 - sk.levels[lv - 1].values[e.param])) / 100
    }
  }
  // 睡眠中は攻撃を 1.5倍受ける（Part 47：物理も属性も）
  if (f.ailment?.id === 'sleep') vuln *= 1.5
  const def = (product(f.buffs, (x) => (x.appliesTo === 'defense' && x.stat === 'physDef' ? 100 + x.value : null)) * product(f.debuffs, (x) => (x.stat === 'physDef' ? 100 - x.value : null))) / 100
  const taken = product(f.buffs, (x) => (x.stat === 'damageTaken' ? x.value : null))
  return { vuln, def, taken }
}

/** 敵の攻撃1回の、この味方への期待ダメージ（命中率・クリティカル・強化・弱体を含む）。採点の耐久（C5）で使う */
export function expectedEnemyDamage(ctx: SimContext, s: BattleState, action: EnemyAction, f: Fighter, defOverride?: number): number {
  const p = enemyHitChance(ctx, s, action, f)
  const r = defenseRates(ctx, f, action)
  if (defOverride !== undefined) r.def = defOverride
  const atk = action.attack === 'str' ? product(s.enemy.debuffs, (m) => (m.stat === 'physAtk' ? 100 - m.value : null)) : 100
  const normal = ctx.enemyHit(action, f.id, r.vuln, r.def, atk, f.guarding, false).expected
  const crit = action.normal ? ctx.enemyHit(action, f.id, r.vuln, r.def, atk, f.guarding, true).expected : normal
  const c = action.normal ? ENEMY_CRIT : 0
  return (p * ((1 - c) * normal + c * crit) * r.taken) / 100
}

// ---------------------------------------------------------------
// 敵の行動（ステップ4-6）：行動パターンで選ぶ／表から選ぶ、技の効果
// ---------------------------------------------------------------

/** このターンの敵の行動（ターンの初めに決める） */
export type EnemyChoice =
  | { kind: 'manual'; action: EnemyAction }
  | { kind: 'skill'; id: string; skill: EnemySkill | null; note?: string }
  | { kind: 'skip'; id: string; name: string; note: string }

const PARTS = ['head', 'arm', 'leg'] as const
const enemyBound = (s: BattleState, part: (typeof PARTS)[number]) => (s.enemy.ailments[`bind-${part}`] ?? 0) >= s.turn
/** 味方にかかっている強化の数（メンバーごとに数えた合計。LP Archive・atwiki の行動の条件） */
const partyBuffCount = (s: BattleState) => s.members.reduce((n, f) => n + (f.alive ? f.buffs.length : 0), 0)
const isElemResist = (m: ActiveEffect['mods'][number]) => m.appliesTo === 'resistance' && (!m.elements || m.elements.some((e) => e === 'fire' || e === 'ice' || e === 'volt'))

function conditionHolds(ctx: SimContext, s: BattleState, w: EnemyBehavior['rules'][number]['when'], rng: Rng | null): boolean {
  const t = s.turn
  const hp = (s.enemy.hp / s.enemy.maxHp) * 100
  const bound = PARTS.filter((p) => enemyBound(s, p))
  if (w.turn !== undefined && t !== w.turn) return false
  if (w.turnFrom !== undefined && t < w.turnFrom) return false
  if (w.turnMod && t % w.turnMod[0] !== w.turnMod[1] % w.turnMod[0]) return false
  if (w.hpBelow !== undefined && !(hp < w.hpBelow)) return false
  if (w.hpAtLeast !== undefined && !(hp >= w.hpAtLeast)) return false
  if (w.prev !== undefined && s.enemy.prev !== w.prev) return false
  if (w.notPrev !== undefined && s.enemy.prev === w.notPrev) return false
  if (w.boundExactly && (bound.length !== w.boundExactly.length || !w.boundExactly.every((p) => bound.includes(p)))) return false
  if (w.bound && !w.bound.every((p) => bound.includes(p))) return false
  if (w.notBound && w.notBound.some((p) => bound.includes(p))) return false
  if (w.boundCountAtLeast !== undefined && bound.length < w.boundCountAtLeast) return false
  if (w.partyBuffsAtLeast !== undefined && partyBuffCount(s) < w.partyBuffsAtLeast) return false
  if (w.selfBuff !== undefined && !s.enemy.buffs.some((b) => b.skillId === w.selfBuff)) return false
  if (w.noSelfBuff !== undefined && s.enemy.buffs.some((b) => b.skillId === w.noSelfBuff)) return false
  if (w.partyElemResist !== undefined) {
    const has = s.members.some((f) => f.alive && (f.buffs.some((b) => b.mods.some(isElemResist)) || (['fire', 'ice', 'volt'] as const).some((e) => armorResist(ctx.member(f.id), e) > 0)))
    if (has !== w.partyElemResist) return false
  }
  // 確率の条件：期待値で計算するときは 50% 以上なら当てはまるとする
  if (w.chance !== undefined && !(rng ? rng() * 100 < w.chance : w.chance >= 50)) return false
  return true
}

/** 表から1つ選ぶ（期待値で計算するときは最も重いもの。同じなら先のもの） */
function pickChoice(use: { skill: string; weight: number }[], rng: Rng | null): string {
  if (rng) return pickWeighted(use, (c) => c.weight, rng).skill
  return use.reduce((a, b) => (b.weight > a.weight ? b : a)).skill
}

/** ターンの初めに、敵の行動を決める */
export function chooseEnemyAction(ctx: SimContext, s: BattleState, rng: Rng | null): EnemyChoice | null {
  const b = ctx.behavior
  if (!b) {
    if (!ctx.setup.enemyActions.length) return null
    const action = rng ? pickWeighted(ctx.setup.enemyActions, (a) => a.weight, rng) : ctx.setup.enemyActions.reduce((a, x) => (x.weight > a.weight ? x : a))
    return { kind: 'manual', action }
  }
  const rule = b.rules.find((r) => conditionHolds(ctx, s, r.when, rng))
  const table = rule?.use ?? b.default
  const usable = (id: string) => {
    const sk = b.skills.find((x) => x.id === id)
    return !sk || sk.part === 'none' || !enemyBound(s, sk.part)
  }
  let id = pickChoice(table, rng)
  let note: string | undefined
  if (!usable(id)) {
    const name = b.skills.find((x) => x.id === id)!.name
    const mode = b.onBound ?? 'normal'
    if (mode === 'skip') return { kind: 'skip', id, name, note: `${name}は封じで使えない` }
    if (mode === 'reroll') {
      const rest = table.filter((c) => usable(c.skill))
      id = rest.length ? pickChoice(rest, rng) : 'normal'
    } else id = 'normal'
    note = `${name}は封じで使えない`
  }
  const skill = id === 'normal' ? null : b.skills.find((x) => x.id === id)!
  // 効果の無い技（無駄行動）
  if (skill && skill.effects.length === 0) return { kind: 'skip', id, name: skill.name, note: '何も起きない' }
  return { kind: 'skill', id, skill, note }
}

/** 敵の行動の速度補正（%） */
export const enemyChoiceSpeed = (c: EnemyChoice) => (c.kind === 'skill' && c.skill ? (c.skill.speed ?? 100) : 100)

const PHYSICAL: ElementId[] = ['slash', 'bash', 'pierce']

/** 敵の攻撃力の倍率（味方の弱体と敵の自己強化） */
function enemyAtkRate(s: BattleState): number {
  const arm = (s.enemy.ailments['bind-arm'] ?? 0) >= s.turn ? 0.7 : 1
  return ((product(s.enemy.debuffs, (m) => (m.stat === 'physAtk' ? 100 - m.value : null)) * product(s.enemy.buffs, (m) => (m.stat === 'physAtk' ? 100 + m.value : null))) / 100) * arm
}

/** 狙いの確率（メンバー ID → 確率）。挑発・前後列・HP の順（chooseTarget と同じ考え方） */
export function targetDistribution(ctx: SimContext, s: BattleState, aim?: 'front' | 'back' | 'lowest' | 'highest'): Map<string, number> {
  // シャドウエントリ（EO Wiki の HD版）：その率で狙いの候補から外れ、外れなければいつもどおり。複数いれば1人ずつ独立に判定する
  const cloakers = s.members.filter((f) => f.alive && f.buffs.some((b) => b.mods.some((m) => m.stat === 'cloak')))
  const combine = (excluded: Set<string>, i: number): Map<string, number> => {
    if (i >= cloakers.length) return baseDistribution(ctx, s, aim, excluded)
    const c = cloakers[i]
    const p = Math.max(...c.buffs.flatMap((b) => b.mods.filter((m) => m.stat === 'cloak').map((m) => m.value))) / 100
    const out = new Map<string, number>()
    const add = (d: Map<string, number>, w: number) => d.forEach((v, k) => out.set(k, (out.get(k) ?? 0) + v * w))
    const withOut = new Set(excluded).add(c.id)
    // 全員が外れてしまうときは、外れないものとする
    const removed = s.members.some((f) => f.alive && !withOut.has(f.id)) ? combine(withOut, i + 1) : combine(excluded, i + 1)
    add(removed, p)
    add(combine(excluded, i + 1), 1 - p)
    return out
  }
  return combine(new Set(), 0)
}

function baseDistribution(ctx: SimContext, s: BattleState, aim: 'front' | 'back' | 'lowest' | 'highest' | undefined, excluded: Set<string>): Map<string, number> {
  const out = new Map<string, number>()
  const alive = s.members.filter((f) => f.alive && !excluded.has(f.id))
  if (!alive.length) return out
  if (aim === 'lowest' || aim === 'highest') {
    const pick = [...alive].sort((a, b) => (aim === 'lowest' ? a.hp - b.hp : b.hp - a.hp))[0]
    out.set(pick.id, 1)
    return out
  }
  let rest = 1
  let provoker: { f: Fighter; rate: number } | null = null
  for (const f of alive) for (const b of f.buffs) for (const m of b.mods) if (m.stat === 'aggro' && (!provoker || m.value > provoker.rate)) provoker = { f, rate: m.value }
  if (provoker) {
    out.set(provoker.f.id, provoker.rate / 100)
    rest -= provoker.rate / 100
  }
  const rowOf = (f: Fighter) => ctx.member(f.id).row
  const front = alive.filter((f) => rowOf(f) === 'front')
  const back = alive.filter((f) => rowOf(f) === 'back')
  let rows: [Fighter[], number][]
  if (aim === 'front') rows = [[front.length ? front : back, 1]]
  else if (!back.length) rows = [[front, 1]]
  else if (!front.length) rows = [[back, 1]]
  else rows = aim === 'back' ? [[back, 0.9], [front, 0.1]] : [[front, 0.9], [back, 0.1]]
  const weights = [60, 30, 10]
  for (const [row, p] of rows) {
    const sorted = [...row].sort((a, b) => b.hp - a.hp)
    const total = sorted.reduce((n, _, i) => n + (weights[i] ?? 0), 0)
    sorted.forEach((f, i) => out.set(f.id, (out.get(f.id) ?? 0) + (rest * p * (weights[i] ?? 0)) / total))
  }
  return out
}

/** 確率の表から1人を引く */
function drawTarget(s: BattleState, dist: Map<string, number>, rng: Rng): Fighter | null {
  const ids = [...dist.keys()]
  if (!ids.length) return null
  const id = pickWeighted(ids, (x) => dist.get(x)!, rng)
  return s.members.find((f) => f.id === id) ?? null
}

/** 破邪の鎮魂歌：状態異常・封じの持続 ÷ 回復率補正（切り上げ。EO Wiki） */
function recoveredDuration(f: Fighter, d: number): number {
  const r = product(f.buffs, (m) => (m.stat === 'ailmentRecovery' ? m.value * 100 : null)) / 100
  return Math.ceil(d / r)
}

/** 睡眠から起こす（起きたターンは行動できない） */
function wake(f: Fighter, turn: number) {
  f.ailment = null
  f.wokeTurn = turn
}

/** 味方を戦闘不能にする */
function knockDown(f: Fighter, turn: number) {
  f.hp = 0
  f.alive = false
  f.downTurn = turn
  f.buffs = []
  f.ailment = null
  f.binds = {}
}

/** 味方への状態異常・封じの判定。付与率 × 難易度の「被状態異常」（味方の耐性は 100% とした。LUC は入れない） */
function inflictParty(ctx: SimContext, s: BattleState, f: Fighter, x: { ailments: string[]; all?: boolean; chance: number; poisonDamage?: number; ignoreResist?: boolean }, rng: Rng, notes: string[]) {
  if (!f.alive) return
  const vuln = formulas.difficulty[ctx.setup.difficulty].ailmentVulnerability
  const list = x.all ? x.ailments : [x.ailments[Math.floor(rng() * x.ailments.length)]]
  for (const a of list) {
    if (!f.alive) return
    if (rng() * 100 >= (x.chance * vuln) / 100) continue
    if (a === 'death' || a === 'petrify') {
      knockDown(f, s.turn)
      notes.push(a === 'death' ? '即死' : '石化')
      continue
    }
    if (a.startsWith('bind-')) {
      const part = a.slice(5) as 'head' | 'arm' | 'leg'
      f.binds[part] = Math.max(f.binds[part] ?? 0, s.turn + recoveredDuration(f, ailmentDuration(a as InflictId, rng)) - 1)
      notes.push(INFLICT_NOTE[a])
      continue
    }
    // スタン：そのターンの残りだけ行動できない（Part 47）
    if (a === 'stun') {
      f.stunTurn = s.turn
      notes.push(INFLICT_NOTE.stun)
      continue
    }
    // 封じ以外の状態異常は1つだけ。優先順位方式（暫定）：下位のものは上位のものを置き換えない
    const id = a as PartyAilment
    const current = f.ailment && f.ailment.lastTurn >= s.turn ? f.ailment.id : null
    if (!ailmentReplaces(current, id)) {
      notes.push(`${INFLICT_NOTE[a]}は${INFLICT_NOTE[current!]}に負けてかからない`)
      continue
    }
    f.ailment = { id, lastTurn: s.turn + recoveredDuration(f, ailmentDuration(id as InflictId, rng)) - 1, ...(x.poisonDamage ? { poison: x.poisonDamage } : {}) }
    notes.push(INFLICT_NOTE[a])
  }
}

const INFLICT_NOTE: Record<string, string> = {
  poison: '毒', sleep: '睡眠', paralysis: '麻痺', confusion: '混乱', terror: 'テラー', blind: '盲目', curse: '呪い', stun: 'スタン',
  'bind-head': '頭封じ', 'bind-arm': '腕封じ', 'bind-leg': '脚封じ',
}

/** 敵の攻撃1発をメンバーに当てる（期待値なら weight 倍した期待ダメージ）。与えたダメージを返す */
function enemyStrike(
  ctx: SimContext, s: BattleState, f: Fighter, part: { element: ElementId; power: number }, extra: { element: ElementId; power: number } | null,
  o: { accuracy: number; normal: boolean; ignoreDef: boolean; weight: number }, rng: Rng | null, entries: TurnLog['entries'], name: string,
): number {
  const make = (p: { element: ElementId; power: number }): EnemyAction => ({ name, attack: PHYSICAL.includes(p.element) ? 'str' : 'tec', element: p.element, power: p.power, target: 'single', weight: 1, accuracy: o.accuracy, normal: o.normal })
  const parts = [make(part), ...(extra ? [make(extra)] : [])]
  const atkStr = enemyAtkRate(s)
  if (!rng) {
    // 期待値：命中率・クリティカル・強化をかけた期待ダメージ × この人に当たる重み
    let dmg = 0
    for (const a of parts) {
      const exp = expectedEnemyDamage(ctx, s, a, f, o.ignoreDef ? 100 : undefined)
      dmg += (exp * (a.attack === 'str' ? atkStr : 100)) / 100
    }
    dmg *= o.weight * guardFactor(f, null, entries, name)
    f.hp -= dmg
    if (dmg > 0 && parts[0].attack === 'str') trapCounter(ctx, s, f, null, o.weight, entries)
    if (f.hp <= 0) downOrEndure(f, s.turn, null)
    return dmg
  }
  const entry: TurnLog['entries'][number] = { actor: '敵', action: name, target: f.name }
  if (rng() >= enemyHitChance(ctx, s, parts[0], f)) {
    entry.note = '回避'
    entries.push(entry)
    return 0
  }
  if (guardFactor(f, rng, entries, name) === 0) return 0
  const crit = o.normal && rng() < ENEMY_CRIT
  let dmg = 0
  for (const a of parts) {
    const r = defenseRates(ctx, f, a)
    const d = ctx.enemyHit(a, f.id, r.vuln, o.ignoreDef ? 100 : r.def, a.attack === 'str' ? atkStr : 100, f.guarding, crit)
    dmg += Math.floor((sampleHit(d, rng) * r.taken) / 100)
  }
  f.hp -= dmg
  entry.damage = dmg
  if (crit) entry.note = 'クリティカル'
  // 攻撃を受けると睡眠が解け、そのターンは行動できない（atwiki「システム」、Part 47）
  if (f.ailment?.id === 'sleep' && dmg > 0) wake(f, s.turn)
  if (f.hp <= 0) {
    downOrEndure(f, s.turn, rng, entry)
    if (!f.alive) entry.note = `${entry.note ? `${entry.note}・` : ''}戦闘不能`
  }
  entries.push(entry)
  if (dmg > 0 && parts[0].attack === 'str') trapCounter(ctx, s, f, rng, 1, entries)
  return dmg
}

/** 行動パターンの技を使う */
function doEnemySkill(ctx: SimContext, s: BattleState, skill: EnemySkill | null, rng: Rng | null, entries: TurnLog['entries'], note?: string) {
  const enemy = ctx.setup.enemy!
  const b = ctx.behavior!
  const name = skill ? skill.name : '通常攻撃'
  const accuracy = skill?.accuracy ?? enemy.accuracy
  const effects: EnemySkillEffect[] = skill ? skill.effects : [{ type: 'damage', element: enemy.normalElement ?? 'slash', power: 100, target: 'single' }]
  const aim = skill ? skill.aim : b.normalAim
  const head: TurnLog['entries'][number] = { actor: '敵', action: name, ...(note ? { note } : {}) }
  let logged = false
  const logHead = (extra: Partial<TurnLog['entries'][number]> = {}) => {
    entries.push({ ...head, ...extra })
    logged = true
  }
  for (const e of effects) {
    switch (e.type) {
      case 'damage': {
        const main = { element: e.element, power: e.power }
        const extra = e.element2 && e.power2 ? { element: e.element2, power: e.power2 } : null
        const o = { accuracy, normal: !skill, ignoreDef: !!e.ignoreDefBuff }
        const hitsAvg = e.hits ? (e.hits[0] + e.hits[1]) / 2 : 1
        // 当てる相手と回数（期待値は重み、乱数は実際に引く）
        const plan: { f: Fighter; weight: number; power?: number }[] = []
        const alive = s.members.filter((f) => f.alive)
        if (e.target === 'all') for (const f of alive) plan.push({ f, weight: 1 })
        else if (e.target === 'random') {
          if (rng) {
            const n = e.hits ? e.hits[0] + Math.floor(rng() * (e.hits[1] - e.hits[0] + 1)) : 1
            const pool = [...alive]
            for (let i = 0; i < n && pool.length; i++) {
              const k = Math.floor(rng() * pool.length)
              plan.push({ f: pool[k], weight: 1 })
              if (e.distinct) pool.splice(k, 1)
            }
          } else for (const f of alive) plan.push({ f, weight: e.distinct ? Math.min(hitsAvg, alive.length) / alive.length : hitsAvg / alive.length })
        } else {
          const dist = targetDistribution(ctx, s, aim)
          const reps = e.target === 'single' && e.hits ? hitsAvg : 1
          const mains: [Fighter, number][] = rng ? (() => {
            const f = drawTarget(s, dist, rng)
            return f ? [[f, 1]] : []
          })() : [...dist.entries()].map(([id, p]) => [s.members.find((x) => x.id === id)!, p])
          for (const [f, p] of mains) {
            const n = rng && e.hits ? e.hits[0] + Math.floor(rng() * (e.hits[1] - e.hits[0] + 1)) : reps
            if (rng) for (let i = 0; i < n; i++) plan.push({ f, weight: 1 })
            else plan.push({ f, weight: p * n })
            if (e.target === 'splash') {
              // 左右：同じ列で並び順が隣の人
              const row = s.members.filter((x) => x.alive && ctx.member(x.id).row === ctx.member(f.id).row)
              const i = row.indexOf(f)
              for (const side of [row[i - 1], row[i + 1]]) if (side) plan.push({ f: side, weight: rng ? 1 : p, power: e.splashPower })
            }
          }
        }
        // 乱数のときは当てた1発ずつを記録する（技の名前の行は出さない）
        if (rng) logged = true
        let total = 0
        for (const x of plan) {
          if (!x.f.alive) continue
          const dealt = enemyStrike(ctx, s, x.f, x.power ? { ...main, power: x.power } : main, extra, { ...o, weight: x.weight }, rng, entries, name)
          total += dealt
          if (rng && dealt > 0 && e.inflict) {
            const notes: string[] = []
            inflictParty(ctx, s, x.f, e.inflict, rng, notes)
            if (notes.length) entries.push({ actor: '敵', action: name, target: x.f.name, note: notes.join('・') })
          }
        }
        if (e.drain && total > 0) s.enemy.hp = Math.min(s.enemy.maxHp, s.enemy.hp + total)
        if (!rng && !logged) logHead({ damage: Math.round(total) })
        break
      }
      case 'inflict': {
        if (!rng) {
          if (!logged) logHead({ note: '（期待値の計算では状態異常を付けない）' })
          break
        }
        const dist = targetDistribution(ctx, s, aim)
        const targets = e.target === 'all' ? s.members.filter((f) => f.alive) : [drawTarget(s, dist, rng)].filter((f): f is Fighter => !!f)
        if (!logged) logHead()
        for (const f of targets) {
          if (rng() * 100 >= accuracy * (enemyHitChance(ctx, s, { name, attack: 'str', element: 'slash', power: 0, target: 'single', weight: 1, accuracy: 100, normal: false }, f))) {
            entries.push({ actor: '敵', action: name, target: f.name, note: '回避' })
            continue
          }
          const notes: string[] = []
          inflictParty(ctx, s, f, e, rng, notes)
          entries.push({ actor: '敵', action: name, target: f.name, note: notes.length ? notes.join('・') : '効かなかった' })
        }
        break
      }
      case 'self-buff':
        {
          const effect: ActiveEffect = { skillId: skill!.id, name, mods: e.mods.map((m) => ({ stat: m.stat, value: m.value, ...(m.elements ? { elements: m.elements } : {}) })), lastTurn: s.turn + e.turns - 1, oneShot: false, ...(e.special ? { special: true } : {}) }
          const [buffs, debuffs, canceled] = applyEffect(s.enemy.buffs, s.enemy.debuffs, effect)
          s.enemy.buffs = buffs
          s.enemy.debuffs = debuffs
          if (!logged) logHead({ target: '自分', ...(canceled ? { note: '味方の弱体と打ち消し合った' } : {}) })
        }
        break
      case 'party-debuff': {
        const effect: ActiveEffect = { skillId: skill!.id, name, mods: e.mods.map((m) => ({ stat: m.stat, value: m.value })), lastTurn: s.turn + e.turns - 1, oneShot: false }
        for (const f of s.members) {
          if (!f.alive) continue
          const [debuffs, buffs] = applyEffect(f.debuffs, f.buffs, effect)
          f.debuffs = debuffs
          f.buffs = buffs
          refreshMaxHp(f)
        }
        if (!logged) logHead({ target: '味方全体' })
        if (rng && e.inflict) for (const f of s.members) {
          const notes: string[] = []
          inflictParty(ctx, s, f, e.inflict, rng, notes)
          if (notes.length) entries.push({ actor: '敵', action: name, target: f.name, note: notes.join('・') })
        }
        break
      }
      case 'heal': {
        const before = s.enemy.hp
        s.enemy.hp = Math.min(s.enemy.maxHp, s.enemy.hp + e.amount)
        if (!logged) logHead({ healed: Math.round(s.enemy.hp - before), target: '自分' })
        break
      }
      case 'regen':
        s.enemy.regen = { amount: e.amount, lastTurn: s.turn + e.turns - 1, ...(e.revive ? { revive: e.revive } : {}) }
        if (!logged) logHead({ target: '自分' })
        break
      case 'dispel':
        for (const f of s.members) {
          f.buffs = []
          refreshMaxHp(f)
        }
        if (!logged) logHead({ target: '味方全体', note: '強化をすべて消した' })
        break
      case 'cleanse':
        for (const p of PARTS) delete s.enemy.ailments[`bind-${p}`]
        if (!logged) logHead({ target: '自分', note: '封じを解いた' })
        break
      case 'counter':
        s.enemy.counter = { element: e.element, power: e.power, accuracy: skill?.accuracy ?? enemy.accuracy }
        if (!logged) logHead({ note: '反撃の構え' })
        break
      case 'guard':
        s.enemy.guarding = true
        if (!logged) logHead({ note: '防御' })
        break
      case 'summon':
        if (!logged) logHead({ note: '仲間を呼んだ（1対1では何もしない）' })
        break
    }
  }
  if (!logged) logHead()
}

/** 表（手入力）の行動を使う（B9 の手入力の表） */
function doManualAction(ctx: SimContext, s: BattleState, action: EnemyAction, rng: Rng | null, entries: TurnLog['entries']) {
  const alive = s.members.filter((f) => f.alive)
  const strike = (f: Fighter, weight: number) => {
    // 手入力の行動は物理か属性かを本人が選ぶので、その区別をそのまま使う
    const a = action
    if (!rng) {
      const dmg = ((expectedEnemyDamage(ctx, s, a, f) * (a.attack === 'str' ? enemyAtkRate(s) : 100) * weight) / 100) * guardFactor(f, null, entries, a.name)
      f.hp -= dmg
      if (dmg > 0 && a.attack === 'str') trapCounter(ctx, s, f, null, weight, entries)
      if (f.hp <= 0) downOrEndure(f, s.turn, null)
      return
    }
    enemyStrikeManual(ctx, s, f, a, rng, entries)
  }
  if (action.target === 'all') for (const f of alive) strike(f, 1)
  else if (action.target === 'row') {
    if (rng) {
      const row = chooseRow(ctx, alive, rng)
      for (const f of alive.filter((x) => ctx.member(x.id).row === row)) strike(f, 1)
    } else {
      const hasBack = alive.some((f) => ctx.member(f.id).row === 'back')
      const hasFront = alive.some((f) => ctx.member(f.id).row === 'front')
      for (const f of alive) {
        const row = ctx.member(f.id).row
        strike(f, !hasBack || !hasFront ? 1 : row === 'front' ? 0.9 : 0.1)
      }
    }
  } else if (rng) {
    const f = chooseTarget(ctx, s, rng)
    if (f) strike(f, 1)
  } else for (const [id, p] of targetDistribution(ctx, s)) strike(s.members.find((x) => x.id === id)!, p)
  if (!rng) entries.push({ actor: '敵', action: action.name })
}

function enemyStrikeManual(ctx: SimContext, s: BattleState, f: Fighter, action: EnemyAction, rng: Rng, entries: TurnLog['entries']) {
  const entry: TurnLog['entries'][number] = { actor: '敵', action: action.name, target: f.name }
  if (rng() >= enemyHitChance(ctx, s, action, f)) {
    entry.note = '回避'
    entries.push(entry)
    return
  }
  if (guardFactor(f, rng, entries, action.name) === 0) return
  const crit = action.normal && rng() < ENEMY_CRIT
  const r = defenseRates(ctx, f, action)
  const d = ctx.enemyHit(action, f.id, r.vuln, r.def, action.attack === 'str' ? enemyAtkRate(s) : 100, f.guarding, crit)
  const dmg = Math.floor((sampleHit(d, rng) * r.taken) / 100)
  f.hp -= dmg
  entry.damage = dmg
  if (crit) entry.note = 'クリティカル'
  if (f.ailment?.id === 'sleep' && dmg > 0) wake(f, s.turn)
  if (f.hp <= 0) {
    downOrEndure(f, s.turn, rng, entry)
    if (!f.alive) entry.note = `${entry.note ? `${entry.note}・` : ''}戦闘不能`
  }
  entries.push(entry)
  if (dmg > 0 && action.attack === 'str') trapCounter(ctx, s, f, rng, 1, entries)
}

/**
 * 一寸の見切り（1度だけ無効）とパリング（成功率で無効。2回目以降は連続発動率）。無効にしたら 0、そうでなければ 1 を返す。
 * 期待値の計算では、見切りは最初の1回を 0 にし、パリングは成功しない割合をかける
 */
function guardFactor(f: Fighter, rng: Rng | null, entries: TurnLog['entries'], name: string): number {
  const fx = f.turnFx
  if (fx.evade) {
    fx.evade = false
    if (rng) entries.push({ actor: '敵', action: name, target: f.name, note: '一寸の見切りで無効' })
    return 0
  }
  if (fx.parry) {
    const p = (fx.parry.succeeded === 0 ? fx.parry.first : fx.parry.repeat) / 100
    if (!rng) {
      fx.parry.succeeded += p
      return 1 - Math.min(1, p)
    }
    if (rng() < p) {
      fx.parry.succeeded += 1
      entries.push({ actor: '敵', action: name, target: f.name, note: 'パリングで無効' })
      return 0
    }
  }
  return 1
}

/**
 * トラッピング（atwiki ダークハンター）：使ったターン、自分か左右の味方が直接攻撃を受けるたびに斬攻撃で反撃する（自分なら威力大、左右なら威力小）。
 * 直接攻撃は物理（STR）の攻撃とした（Claude 決定）
 */
function trapCounter(ctx: SimContext, s: BattleState, victim: Fighter, rng: Rng | null, weight: number, entries: TurnLog['entries']) {
  for (const t of s.members) {
    if (!t.alive || !t.turnFx.trap || enemyDown(s)) continue
    let param: string | null = null
    if (t === victim) param = 'p1'
    else {
      const row = s.members.filter((x) => ctx.member(x.id).row === ctx.member(t.id).row)
      const i = row.indexOf(t)
      if (row[i - 1] === victim || row[i + 1] === victim) param = 'p2'
    }
    if (!param) continue
    const { atk, dealt } = memberAtkRates(t, s.turn)
    const { def, taken } = enemyDefense(s)
    const p = ctx.extraHit(t.id, t.turnFx.trap.skill, t.turnFx.trap.level, 'slash', param, atk, dealt, def, (s.enemy.ailments.sleep ?? 0) >= s.turn, taken, s.enemy.guarding)
    if (!p) continue
    const dmg = dealToEnemy(ctx, s, rollAttack(p, rng, weight), rng)
    if (rng) entries.push({ actor: t.name, action: 'トラッピングの反撃', damage: dmg })
  }
}

function enemyTurn(ctx: SimContext, s: BattleState, choice: EnemyChoice, rng: Rng | null, entries: TurnLog['entries']) {
  const from = entries.length
  if (choice.kind === 'manual') doManualAction(ctx, s, choice.action, rng, entries)
  else if (choice.kind === 'skip') entries.push({ actor: '敵', action: choice.name, note: choice.note })
  else doEnemySkill(ctx, s, choice.skill, rng, entries, choice.note)
  // フロントガード・属性ガードは、軽減した敵の行動1回で消える（範囲攻撃でも1回）
  const elements: ElementId[] =
    choice.kind === 'manual' ? [choice.action.element] : choice.kind === 'skill' ? (choice.skill ? choice.skill.effects.flatMap((e) => (e.type === 'damage' ? [e.element, ...(e.element2 ? [e.element2] : [])] : [])) : [ctx.setup.enemy?.normalElement ?? 'slash']) : []
  if (!elements.length) return
  const used = (b: ActiveEffect) => b.oneShot && b.mods.some((m) => m.stat === 'damageTaken' || (m.appliesTo === 'resistance' && (!m.elements || m.elements.some((e) => elements.includes(e)))))
  // 乱数のときは当たった（狙われた）人だけ、期待値のときは全員
  const hit = new Set(entries.slice(from).map((e) => e.target))
  for (const f of s.members) if (!rng || hit.has(f.name)) f.buffs = f.buffs.filter((b) => !used(b))
}
