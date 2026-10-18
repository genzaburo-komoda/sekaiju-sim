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
import { findEquipment, formulas, skillsByJob } from '../data/gameData'
import type { Enemy, Skill, SkillEffect } from '../data/schema'
import { attackOptions, buildAttackInput, skillValues } from './attack'
import { calcDamage, type AttackInput, type ElementId } from './damage'
import { armorDefense, armorResist, gearAllows, hasShield } from './equip'
import type { DifficultyId, Member } from './party'
import { doubleAttackChance } from './optimize'
import { memberStats, targetFromEnemy, type TargetSettings } from './predict'
import { healAmount, inflictChance, inflictVuln, type InflictId } from './support'

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

export type ActionKind = 'attack' | 'buff' | 'debuff' | 'heal' | 'ailment' | 'defend'

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
    const kind = kindOf(s)
    if (!kind) continue
    if (kind === 'attack' && !usable.has(s.id)) continue
    if (kind !== 'attack' && !gearAllows(s.weapons, member)) continue
    out.push({
      id: s.id,
      name: `${s.name} Lv${lv}`,
      kind,
      skill: s,
      level: lv,
      tp: s.levels[lv - 1].tp ?? 0,
      ...speedOf(s, lv),
      ...(s.stance ? { needsStance: `bushido-${s.stance}` } : {}),
    })
  }
  return out
}

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
  /** 戦闘不能になったターン（null は倒れていない） */
  downTurn: number | null
}

export interface EnemyState {
  hp: number
  maxHp: number
  debuffs: ActiveEffect[]
  /** かかっている状態異常（ID → このターンの終わりまで） */
  ailments: Partial<Record<InflictId, number>>
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
      return { id: m.id, name: m.name, hp: st.hp, maxHp: st.hp, baseMaxHp: st.hp, tp: st.tp, alive: true, buffs: [], debuffs: [], guarding: false, downTurn: null }
    }),
    enemy: { hp: es.hp, maxHp: es.hp, debuffs: [], ailments: {} },
  }
}

const cloneState = (s: BattleState): BattleState => ({
  turn: s.turn,
  members: s.members.map((m) => ({ ...m, buffs: [...m.buffs], debuffs: [...m.debuffs] })),
  enemy: { ...s.enemy, debuffs: [...s.enemy.debuffs], ailments: { ...s.enemy.ailments } },
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
}

/** 戦闘の計算で使う覚え書き（同じ設定の間は使い回す） */
export class SimContext {
  readonly setup: BattleSetup
  readonly actions: Map<string, SimAction[]>
  readonly stats: Map<string, ReturnType<typeof memberStats>>
  readonly spec: TargetSettings
  readonly es: EnemyStats
  private cache = new Map<string, AttackProfile | null>()
  private enemyCache = new Map<string, HitDist>()

  constructor(setup: BattleSetup) {
    this.setup = setup
    this.actions = new Map(setup.members.map((m) => [m.id, memberActions(m)]))
    this.stats = new Map(setup.members.map((m) => [m.id, memberStats(m)]))
    this.spec = setup.enemy ? targetFromEnemy(setup.enemy, false) : { ...setup.target, guarding: false }
    this.es = enemyStats(setup)
  }

  member(id: string): Member {
    return this.setup.members.find((m) => m.id === id)!
  }

  action(memberId: string, actionId: string): SimAction | undefined {
    return this.actions.get(memberId)?.find((a) => a.id === actionId)
  }

  /** 攻撃の分布。atk＝攻撃の強化（物理）の倍率、dealt＝与ダメージの倍率、def＝敵の防御の倍率、sleep＝敵が睡眠中 */
  attack(memberId: string, actionId: string, atk: number, dealt: number, def: number, sleep: boolean): AttackProfile | null {
    const key = `${memberId}|${actionId}|${atk}|${dealt}|${def}|${sleep}`
    if (this.cache.has(key)) return this.cache.get(key)!
    const r = this.buildAttack(memberId, actionId, atk, dealt, def, sleep)
    this.cache.set(key, r)
    return r
  }

  private buildAttack(memberId: string, actionId: string, atk: number, dealt: number, def: number, sleep: boolean): AttackProfile | null {
    const m = this.member(memberId)
    const skills = skillsByJob[m.jobId] ?? []
    const weapon = findEquipment(m.weaponId)
    const option = attackOptions(skills, m.skills, weapon, hasShield(m)).find((o) => o.id === actionId)
    if (!option) return null
    const effect = option.skill?.effects.find((e) => e.type === 'damage')
    // 攻撃の強化（攻撃力上昇）は物理だけ、与ダメージ（ウォークライ）はすべてに効くとした
    const tec = effect?.type === 'damage' && effect.attack === 'tec'
    // 睡眠中の敵は物理攻撃の属性倍率が 1.5 倍（EO Wiki）
    const vulnMul = sleep && !tec ? 1.5 : 1
    const target = { ...this.spec, vuln: Object.fromEntries(Object.entries(this.spec.vuln).map(([k, v]) => [k, v * vulnMul])) as TargetSettings['vuln'] }
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
    const r = calcDamage(built.input)
    const hit = toHitDist(r.distribution, r.expected)
    const inflicts = this.inflicts(m, option.skill)
    if (!option.skill) {
      const c = calcDamage({ ...built.input, critical: true } as AttackInput)
      const crit = toHitDist(c.distribution, c.expected)
      const doubleChance = doubleAttackChance(skills, m.skills)
      const per = (1 - PARTY_CRIT) * hit.expected + PARTY_CRIT * crit.expected
      return { hit, crit, hitsMin: 1, hitsMax: 1, doubleChance, inflicts, expected: per * (1 + doubleChance) }
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
    return { hit, crit: null, hitsMin: lo, hitsMax: hi, doubleChance: 0, inflicts, expected: (hit.expected * (lo + hi)) / 2 }
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

/** 状態に合わせて実際にする行動（TP 不足・構えなし・回復の必要なし → 代わりの行動） */
function resolveAction(ctx: SimContext, f: Fighter, actionId: string, fallbackId: 'normal' | 'defend'): { action: SimAction; fallback?: string } {
  const a = ctx.action(f.id, actionId) ?? ctx.action(f.id, fallbackId)!
  if (a.tp > f.tp) return { action: ctx.action(f.id, fallbackId)!, fallback: `TP 不足（${a.name}）` }
  if (a.needsStance && !f.buffs.some((b) => b.skillId === a.needsStance)) return { action: ctx.action(f.id, fallbackId)!, fallback: `構えがない（${a.name}）` }
  return { action: a }
}

/** 行動の速度（ターンの初めの状態で決める） */
function speedKey(ctx: SimContext, f: Fighter, a: SimAction): number {
  const agiBuff = product(f.buffs, (m) => (m.stat === 'agi' ? 100 + m.value : null))
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
}

/** 1ターン進める（元の状態は変えない） */
export function runTurn(ctx: SimContext, prev: BattleState, opts: TurnOptions): { state: BattleState; log: TurnLog | null } {
  const s = cloneState(prev)
  s.turn += 1
  const t = s.turn
  const rng = opts.rng
  const entries: TurnLog['entries'] = []
  for (const f of s.members) f.guarding = false

  // ---- 行動順 ----
  type Slot = { kind: 'member'; f: Fighter; action: SimAction; fallback?: string; key: number; tie: number; index: number } | { kind: 'enemy'; key: number; tie: number; index: number }
  const slots: Slot[] = []
  s.members.forEach((f, i) => {
    if (!f.alive) return
    const r = resolveAction(ctx, f, opts.plan[f.id] ?? opts.fallback, opts.fallback)
    slots.push({ kind: 'member', f, action: r.action, fallback: r.fallback, key: r.action.priority ? Infinity : speedKey(ctx, f, r.action), tie: rng ? rng() : 0, index: i })
  })
  const enemyActs = ctx.setup.enemyActions.length > 0 && !enemyDisabled(s.enemy, t)
  if (enemyActs) {
    const agi = ctx.es.agi * (product(s.enemy.debuffs, (m) => (m.stat === 'agi' ? 100 - m.value : null)) / 100)
    slots.push({ kind: 'enemy', key: Math.round(agi / 5), tie: rng ? rng() : 0, index: s.members.length })
  }
  slots.sort((a, b) => b.key - a.key || (rng ? a.tie - b.tie : a.index - b.index))

  for (const slot of slots) {
    if (slot.kind === 'enemy') {
      enemyTurn(ctx, s, rng, entries)
      continue
    }
    const f = slot.f
    if (!f.alive) continue
    // 行動の直前にもう一度確かめる（同じターンに TP が減ることはないが、構えが消えることはない。念のため）
    const a = slot.action
    f.tp -= a.tp
    const entry: TurnLog['entries'][number] = { actor: f.name, action: a.name, ...(slot.fallback ? { fallback: slot.fallback } : {}) }
    if (a.kind === 'defend') f.guarding = true
    else if (a.kind === 'attack' || a.kind === 'ailment') memberAttack(ctx, s, f, a, rng, entry)
    else if (a.kind === 'buff' || a.kind === 'debuff') castEffect(ctx, s, f, a, entry)
    else if (a.kind === 'heal') castHeal(ctx, s, f, a, entry)
    entries.push(entry)
  }

  // ---- ターンの終わり：継続回復、持続の切れた強化・弱体と状態異常を消す ----
  const healRate = formulas.difficulty[ctx.setup.difficulty].healing
  for (const f of s.members) {
    if (!f.alive) continue
    for (const b of f.buffs) {
      if (!b.regen) continue
      const amount = b.regen.ratio ? Math.floor((f.maxHp * b.regen.amount) / 100) : b.regen.amount
      f.hp = Math.min(f.maxHp, f.hp + Math.floor((amount * healRate) / 100))
    }
  }
  for (const f of s.members) {
    const before = f.buffs
    f.buffs = f.buffs.filter((b) => b.lastTurn > t)
    f.debuffs = f.debuffs.filter((b) => b.lastTurn > t)
    if (before.length !== f.buffs.length) refreshMaxHp(f)
  }
  s.enemy.debuffs = s.enemy.debuffs.filter((b) => b.lastTurn > t)
  for (const [id, last] of Object.entries(s.enemy.ailments)) if (last! <= t) delete s.enemy.ailments[id as InflictId]

  if (!opts.log) return { state: s, log: null }
  const remain = (b: ActiveEffect) => `${b.name}${b.lastTurn === Infinity ? '' : `（残り${b.lastTurn - t}）`}`
  const log: TurnLog = {
    turn: t,
    entries,
    enemyHp: Math.max(0, s.enemy.hp),
    tp: Object.fromEntries(s.members.map((f) => [f.id, f.tp])),
    hp: Object.fromEntries(s.members.map((f) => [f.id, Math.max(0, f.hp)])),
    effects: {
      ...Object.fromEntries(s.members.map((f) => [f.id, f.buffs.map(remain)])),
      enemy: [...s.enemy.debuffs.map(remain), ...Object.keys(s.enemy.ailments)],
    },
  }
  return { state: s, log }
}

/** 敵が行動できない状態異常（睡眠・麻痺・石化・スタン）。麻痺は毎ターン確実に止まるとした（未確認） */
function enemyDisabled(e: EnemyState, t: number): boolean {
  return (['sleep', 'paralysis', 'petrify', 'stun'] as InflictId[]).some((id) => (e.ailments[id] ?? 0) >= t)
}

/** 最大HPの強化（蛮族の行進曲・ヘルズクライ）を反映する */
function refreshMaxHp(f: Fighter) {
  const rate = product(f.buffs, (m) => (m.stat === 'maxHp' ? m.value : null))
  const next = Math.floor((f.baseMaxHp * rate) / 100)
  // 上がった分は今の HP にも足す（未確認）。下がったら今の HP を最大HP に合わせる
  if (next > f.maxHp) f.hp += next - f.maxHp
  f.maxHp = next
  f.hp = Math.min(f.hp, f.maxHp)
}

function memberAttack(ctx: SimContext, s: BattleState, f: Fighter, a: SimAction, rng: Rng | null, entry: TurnLog['entries'][number]) {
  const atk = product(f.buffs, (m) => (m.stat === 'physAtk' ? 100 + m.value : null))
  const dealt = product(f.buffs, (m) => (m.stat === 'damageDealt' ? m.value : null))
  const def = product(s.enemy.debuffs, (m) => (m.stat === 'physDef' && m.appliesTo === 'defense' ? 100 - m.value : null))
  const asleep = (s.enemy.ailments.sleep ?? 0) >= s.turn
  if (a.kind === 'attack') {
    const p = ctx.attack(f.id, a.id, atk, dealt, def, asleep)
    if (p) {
      let dmg: number
      if (!rng) dmg = p.expected
      else {
        const one = () => (p.crit && rng() < PARTY_CRIT ? sampleHit(p.crit, rng) : sampleHit(p.hit, rng))
        const n = p.hitsMin + Math.floor(rng() * (p.hitsMax - p.hitsMin + 1))
        dmg = 0
        for (let i = 0; i < n; i++) dmg += one()
        if (p.doubleChance > 0 && rng() < p.doubleChance) dmg += one()
      }
      s.enemy.hp -= dmg
      entry.damage = dmg
      // 攻撃を受けると睡眠が解ける（atwiki のカースメーカーの解説から。推定）
      if (asleep && dmg > 0) delete s.enemy.ailments.sleep
    }
  }
  // 状態異常は乱数で計算するときだけ判定する（期待値の計算では付かないものとする）
  if (rng) {
    const m = ctx.member(f.id)
    for (const x of ctx.inflicts(m, a.skill)) {
      if (rng() < x.chance) {
        s.enemy.ailments[x.id] = Math.max(s.enemy.ailments[x.id] ?? 0, s.turn + ailmentDuration(x.id, rng) - 1)
        entry.note = `${entry.note ? `${entry.note}・` : ''}${x.id}`
      }
    }
  }
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
    s.enemy.debuffs = addEffect(s.enemy.debuffs, effect)
    entry.target = '敵'
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
    x.buffs = addEffect(x.buffs, effect)
    refreshMaxHp(x)
  }
  entry.target = e.target === 'self' ? '自分' : e.target === 'ally-row' ? `${(e.row ?? caster.row) === 'front' ? '前' : '後'}列` : e.target === 'ally-single' ? '自分' : '味方全体'
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
  const alive = s.members.filter((f) => f.alive)
  if (!alive.length) return null
  let provoker: { f: Fighter; rate: number } | null = null
  for (const f of alive) {
    for (const b of f.buffs) for (const m of b.mods) if (m.stat === 'aggro' && (!provoker || m.value > provoker.rate)) provoker = { f, rate: m.value }
  }
  if (provoker && rng() < provoker.rate / 100) return provoker.f
  const row = chooseRow(ctx, alive, rng)
  const inRow = alive.filter((f) => ctx.member(f.id).row === row).sort((a, b) => b.hp - a.hp)
  const weights = [60, 30, 10]
  return pickWeighted(inRow, (f) => weights[inRow.indexOf(f)] ?? 0, rng)
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
  const m = ctx.member(f.id)
  const agi = ctx.stats.get(f.id)!.agi * (product(f.buffs, (x) => (x.stat === 'agi' ? 100 + x.value : null)) / 100)
  const acc = product(s.enemy.debuffs, (x) => (x.stat === 'accuracy' ? x.value : null))
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
  const def = product(f.buffs, (x) => (x.appliesTo === 'defense' && x.stat === 'physDef' ? 100 + x.value : null))
  const taken = product(f.buffs, (x) => (x.stat === 'damageTaken' ? x.value : null))
  return { vuln, def, taken }
}

/** 敵の攻撃1回の、この味方への期待ダメージ（命中率・クリティカル・強化・弱体を含む）。採点の耐久（C5）で使う */
export function expectedEnemyDamage(ctx: SimContext, s: BattleState, action: EnemyAction, f: Fighter): number {
  const p = enemyHitChance(ctx, s, action, f)
  const r = defenseRates(ctx, f, action)
  const atk = action.attack === 'str' ? product(s.enemy.debuffs, (m) => (m.stat === 'physAtk' ? 100 - m.value : null)) : 100
  const normal = ctx.enemyHit(action, f.id, r.vuln, r.def, atk, f.guarding, false).expected
  const crit = action.normal ? ctx.enemyHit(action, f.id, r.vuln, r.def, atk, f.guarding, true).expected : normal
  const c = action.normal ? ENEMY_CRIT : 0
  return (p * ((1 - c) * normal + c * crit) * r.taken) / 100
}

function enemyTurn(ctx: SimContext, s: BattleState, rng: Rng | null, entries: TurnLog['entries']) {
  if (!rng) return
  const action = pickWeighted(ctx.setup.enemyActions, (a) => a.weight, rng)
  const alive = s.members.filter((f) => f.alive)
  let targets: Fighter[]
  if (action.target === 'all') targets = alive
  else if (action.target === 'row') {
    const row = chooseRow(ctx, alive, rng)
    targets = alive.filter((f) => ctx.member(f.id).row === row)
  } else {
    const t = chooseTarget(ctx, s, rng)
    targets = t ? [t] : []
  }
  const atk = action.attack === 'str' ? product(s.enemy.debuffs, (m) => (m.stat === 'physAtk' ? 100 - m.value : null)) : 100
  for (const f of targets) {
    const entry: TurnLog['entries'][number] = { actor: '敵', action: action.name, target: f.name }
    if (rng() >= enemyHitChance(ctx, s, action, f)) {
      entry.note = '回避'
      entries.push(entry)
      continue
    }
    const crit = action.normal && rng() < ENEMY_CRIT
    const r = defenseRates(ctx, f, action)
    const d = ctx.enemyHit(action, f.id, r.vuln, r.def, atk, f.guarding, crit)
    const dmg = Math.floor((sampleHit(d, rng) * r.taken) / 100)
    f.hp -= dmg
    entry.damage = dmg
    if (crit) entry.note = 'クリティカル'
    if (f.hp <= 0) {
      f.hp = 0
      f.alive = false
      f.downTurn = s.turn
      f.buffs = []
      entry.note = `${entry.note ? `${entry.note}・` : ''}戦闘不能`
    }
    entries.push(entry)
  }
  // フロントガード・属性ガードは、軽減した敵の行動1回で消える（範囲攻撃でも1回）
  const used = (b: ActiveEffect) => b.oneShot && b.mods.some((m) => m.stat === 'damageTaken' || (m.appliesTo === 'resistance' && (!m.elements || m.elements.includes(action.element))))
  for (const f of targets) f.buffs = f.buffs.filter((b) => !used(b))
}
