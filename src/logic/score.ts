// 採点・改善案・次に振るスキル・役割バランス（仕様書 C5・C6・B6・B8、6.2）。
//
// 点数の考え方（仕様書 6.2）：今の振り方の評価値 ÷ 同じジョブ・同じレベル（・同じ武器）での最適値 × 100。
// - 火力＝C2（1ターンの総ダメージの期待値）、状態異常＝C3（最も付けやすい状態異常の付与率）、回復＝C4（1ターンの総回復量）
// - 探索＝探索スキルのチェックリスト（パーティ全体で1つ）
// - 耐久は B9（ステップ4-3）が前提なので、それまでは点数を出さない（2026-10-17 本人決定）
//
// D13（採点の重み・必要な探索スキル・標準敵）は Claude の案で仮に決めたもの（2026-10-17 本人了承）。あとで本人が見て直す。
// - メンバーごとに「役割」（火力・状態異常・回復・耐久・支援）を決め、その役割の点数をそのメンバーの点数にする。
//   役割を決めないと、メディックの火力のように「そもそも求めていない軸」で点数が下がるため
// - パーティの軸の点数は、その役割のメンバーの点数の平均。総合点は軸の点数の重み付き平均（その役割のメンバーがいない軸は除く）
// - こうすると、全員が自分の役割の最適構築なら総合 100 点になる（6.2 の「満点の条件」）
import { enemies, findEquipment, rules, skillsByJob } from '../data/gameData'
import type { Skill } from '../data/schema'
import { currentMaxDamage, optimizeMaxDamage } from './optimize'
import type { DifficultyId, Member, Party } from './party'
import { DEFAULT_TARGET, type TargetSettings } from './predict'
import { retireSpBonus } from './retire'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'
import { currentAilment, currentHeal, INFLICT_IDS, INFLICT_LABELS, optimizeAilment, optimizeHeal, type InflictId } from './support'

export type Axis = 'damage' | 'ailment' | 'heal' | 'endurance' | 'explore'
/** 点数をメンバーごとに出す軸 */
export type MemberAxis = 'damage' | 'ailment' | 'heal'
export type Role = MemberAxis | 'endurance' | 'support'

export const AXES: Axis[] = ['damage', 'ailment', 'heal', 'endurance', 'explore']
export const MEMBER_AXES: MemberAxis[] = ['damage', 'ailment', 'heal']
export const AXIS_LABELS: Record<Axis, string> = { damage: '火力', ailment: '状態異常', heal: '回復', endurance: '耐久', explore: '探索' }
export const ROLE_LABELS: Record<Role, string> = { damage: '火力', ailment: '状態異常', heal: '回復', endurance: '耐久（4-3 で実装）', support: '支援（採点なし）' }
export const ROLES: Role[] = ['damage', 'ailment', 'heal', 'endurance', 'support']

/** ジョブごとの役割の初期値（仮。画面で変えられる） */
export const DEFAULT_ROLE: Record<string, Role> = {
  swordsman: 'damage', ranger: 'damage', 'dark-hunter': 'damage', bushido: 'damage', alchemist: 'damage',
  medic: 'heal', hexer: 'ailment', paladin: 'endurance', bard: 'support',
}
export const defaultRole = (jobId: string): Role => DEFAULT_ROLE[jobId] ?? 'damage'

export type Weights = Record<Axis, number>

/** 総合点の重みのプリセット（仮、6.2） */
export const WEIGHT_PRESETS: { id: string; name: string; weights: Weights }[] = [
  { id: 'boss', name: 'ボス戦重視', weights: { damage: 40, ailment: 30, heal: 30, endurance: 0, explore: 0 } },
  { id: 'explore', name: '探索重視', weights: { damage: 20, ailment: 10, heal: 30, endurance: 0, explore: 40 } },
  { id: 'even', name: '均等', weights: { damage: 25, ailment: 25, heal: 25, endurance: 0, explore: 25 } },
]

/** 探索で必要とみなすスキル（仮）。パーティの誰かが Lv1 以上持っていれば満たす */
export const EXPLORE_CHECKLIST: { id: string; label: string; match: (s: Skill) => boolean }[] = [
  { id: 'mining', label: '採掘', match: (s) => s.effects.some((e) => e.type === 'exploration' && e.kind === 'mining') },
  { id: 'logging', label: '伐採', match: (s) => s.effects.some((e) => e.type === 'exploration' && e.kind === 'logging') },
  { id: 'gathering', label: '採取', match: (s) => s.effects.some((e) => e.type === 'exploration' && e.kind === 'gathering') },
  { id: 'cautious-walk', label: '警戒歩行', match: (s) => s.id.endsWith('cautious-walk') },
]

/** 「不足」とみなす点数（B8、仮） */
export const SHORTAGE_THRESHOLD = 50

/**
 * 標準敵（敵を指定しないときの評価対象、仮）：メンバーと同じレベルで、属性・状態異常の耐性はすべて 100%。
 * VIT は、レベルが ±5 以内の敵（いなければレベルが最も近い敵）の VIT の中央値。
 * 特定の弱点や耐性で点数が偏らないように、耐性は等倍にした
 */
export function standardTarget(level: number): TargetSettings {
  let near = enemies.filter((e) => Math.abs(e.level - level) <= 5)
  if (near.length === 0) {
    const d = Math.min(...enemies.map((e) => Math.abs(e.level - level)))
    near = enemies.filter((e) => Math.abs(e.level - level) === d)
  }
  const vits = near.map((e) => e.vit).sort((a, b) => a - b)
  const vit = vits[Math.floor((vits.length - 1) / 2)]
  return { ...DEFAULT_TARGET, enemyId: null, level, vit, guarding: false }
}

export interface ScoreSettings {
  difficulty: DifficultyId
  /** 評価対象の敵（null は標準敵） */
  target: TargetSettings | null
  partySize: number
}

const DAMAGE_OPTS = { enemyCount: 1, preBuffed: false }
const targetFor = (member: Member, s: ScoreSettings) => s.target ?? standardTarget(member.level)

/** 今の振り方での評価値 */
export function memberValue(member: Member, axis: MemberAxis, s: ScoreSettings): number {
  if (axis === 'damage') return currentMaxDamage(member, targetFor(member, s), s.difficulty, DAMAGE_OPTS)?.expected ?? 0
  if (axis === 'ailment') return Math.max(0, ...INFLICT_IDS.map((id) => currentAilment(member, s.target?.enemyId ?? null, id, s.difficulty)))
  return currentHeal(member, s.partySize, s.difficulty)
}

export interface Optimum {
  value: number
  /** 最適値になる振り方 */
  alloc: Allocation
  /** 何で最適値になるか（表示用） */
  label: string
}

/** 同じジョブ・レベル・武器での最適値（C2〜C4 の最適化の結果） */
export function memberOptimum(member: Member, axis: MemberAxis, s: ScoreSettings): Optimum {
  if (axis === 'damage') {
    const c = optimizeMaxDamage(member, targetFor(member, s), s.difficulty, DAMAGE_OPTS)[0]
    return c ? { value: c.expected, alloc: c.alloc, label: c.attackName } : { value: 0, alloc: {}, label: '' }
  }
  if (axis === 'ailment') {
    let best: Optimum = { value: 0, alloc: {}, label: '' }
    for (const id of INFLICT_IDS) {
      const c = optimizeAilment(member, s.target?.enemyId ?? null, id, s.difficulty)[0]
      if (c && c.value > best.value + 1e-12) best = { value: c.value, alloc: c.alloc, label: `${c.skillName}（${INFLICT_LABELS[id as InflictId]}）` }
    }
    return best
  }
  const c = optimizeHeal(member, s.partySize, s.difficulty, { criterion: 'total', damage: 0, targets: 1 })[0]
  return c ? { value: c.value, alloc: c.alloc, label: c.skillName } : { value: 0, alloc: {}, label: '' }
}

/** 点数（0〜100）。最適値が 0（その軸の行動ができないジョブ・武器）なら null */
export function ratioScore(current: number, optimum: number): number | null {
  if (optimum <= 0) return null
  return Math.min(100, (current / optimum) * 100)
}

export interface MemberAxisScore {
  current: number
  optimum: Optimum
  score: number | null
}

export interface MemberScore {
  member: Member
  role: Role
  axes: Record<MemberAxis, MemberAxisScore>
  /** 役割の点数（耐久・支援、または役割の行動ができないときは null） */
  roleScore: number | null
}

export function scoreMember(member: Member, role: Role, s: ScoreSettings): MemberScore {
  const axes = Object.fromEntries(
    MEMBER_AXES.map((axis) => {
      const optimum = memberOptimum(member, axis, s)
      const current = memberValue(member, axis, s)
      return [axis, { current, optimum, score: ratioScore(current, optimum.value) }]
    }),
  ) as Record<MemberAxis, MemberAxisScore>
  const roleScore = role === 'damage' || role === 'ailment' || role === 'heal' ? axes[role].score : null
  return { member, role, axes, roleScore }
}

/** 探索のチェックリストの達成状況 */
export function exploreChecklist(members: Member[]) {
  return EXPLORE_CHECKLIST.map((item) => {
    const who = members.find((m) => (skillsByJob[m.jobId] ?? []).some((sk) => item.match(sk) && (m.skills[sk.id] ?? 0) > 0))
    const can = members.some((m) => (skillsByJob[m.jobId] ?? []).some(item.match))
    return { ...item, have: who?.name ?? null, possible: can }
  })
}

export interface PartyScore {
  members: MemberScore[]
  /** 軸ごとのパーティの点数（その役割のメンバーがいない軸は null） */
  axes: Record<Axis, number | null>
  explore: ReturnType<typeof exploreChecklist>
  /** 総合点（重みのある軸がすべて null なら null） */
  total: number | null
  /** 役割バランス（B8）：軸ごとの、メンバーの中で最も高い点数。耐久は未実装で null */
  balance: Record<Axis, number | null>
  /** 点数が低い理由 */
  reasons: string[]
}

const fmt = (axis: MemberAxis, v: number) => (axis === 'ailment' ? `${(v * 100).toFixed(1)}%` : axis === 'damage' ? v.toFixed(1) : String(v))

export function scoreParty(members: Member[], roles: Record<string, Role>, weights: Weights, s: ScoreSettings): PartyScore {
  const scored = members.map((m) => scoreMember(m, roles[m.id] ?? defaultRole(m.jobId), s))
  const explore = exploreChecklist(members)
  const axes = {} as Record<Axis, number | null>
  for (const axis of MEMBER_AXES) {
    const xs = scored.filter((x) => x.role === axis && x.roleScore !== null).map((x) => x.roleScore!)
    axes[axis] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  axes.endurance = null
  axes.explore = (explore.filter((e) => e.have).length / explore.length) * 100

  let wsum = 0
  let sum = 0
  for (const axis of AXES) {
    const v = axes[axis]
    if (v === null || weights[axis] <= 0) continue
    wsum += weights[axis]
    sum += weights[axis] * v
  }
  const total = wsum > 0 ? sum / wsum : null

  const balance = {} as Record<Axis, number | null>
  for (const axis of MEMBER_AXES) {
    const xs = scored.map((x) => x.axes[axis].score).filter((v): v is number => v !== null)
    balance[axis] = xs.length ? Math.max(...xs) : 0
  }
  balance.endurance = null
  balance.explore = axes.explore

  const reasons: string[] = []
  for (const x of scored) {
    if (x.role === 'endurance' || x.role === 'support') {
      reasons.push(`${x.member.name}：役割が「${ROLE_LABELS[x.role]}」なので採点に入れていません`)
      continue
    }
    const a = x.axes[x.role]
    if (a.score === null) reasons.push(`${x.member.name}：このジョブ・武器では${AXIS_LABELS[x.role]}の行動ができないため、採点に入れていません`)
    else if (a.score < 99.95)
      reasons.push(`${x.member.name}：${AXIS_LABELS[x.role]} ${Math.floor(a.score)}点（今 ${fmt(x.role, a.current)}、最適なら ${fmt(x.role, a.optimum.value)}：${a.optimum.label}）`)
  }
  for (const axis of MEMBER_AXES) {
    if (weights[axis] > 0 && axes[axis] === null) reasons.push(`${AXIS_LABELS[axis]}の役割のメンバーがいないため、総合点から${AXIS_LABELS[axis]}を除いています`)
  }
  if (weights.explore > 0) {
    for (const e of explore) if (!e.have) reasons.push(`探索：${e.label}を持つメンバーがいません${e.possible ? '' : '（このパーティのジョブでは覚えられません）'}`)
  }
  return { members: scored, axes, explore, total, balance, reasons }
}

// ---------------------------------------------------------------
// 改善案（C6）・次に振るスキル（B6）
// ---------------------------------------------------------------

/**
 * その軸の評価にそれ自体が効くスキル（振り替え先・次に振る候補を絞るため）。
 * 今の武器で使えない攻撃、構えが必要な攻撃（採点では構えを使わない）、継続回復・蘇生は除く。
 * 除かないと、前提スキルとして自動で上がる別のスキルの効果が、そのスキルの効果に見えてしまう
 */
function relevantSkills(member: Member, axis: MemberAxis): Skill[] {
  const skills = skillsByJob[member.jobId] ?? []
  const weaponType = findEquipment(member.weaponId)?.weaponType
  const usable = (s: Skill) => !s.weapons || (weaponType !== undefined && s.weapons.includes(weaponType))
  return skills.filter((s) =>
    s.effects.some((e) => {
      if (e.type === 'passive-stat') {
        if (axis === 'damage') return e.stat === 'str' || (e.stat === 'weaponAtk' && e.weapon === weaponType)
        return e.stat === (axis === 'ailment' ? 'ailmentRate' : 'healing')
      }
      if (axis === 'damage') return (e.type === 'damage' && usable(s) && !s.stance) || (e.type === 'passive-proc' && e.trigger === 'normal-attack')
      if (axis === 'ailment') return (e.type === 'ailment' || e.type === 'bind') && usable(s)
      return e.type === 'heal' && e.scaling === 'fixed' && e.timing !== 'per-turn' && !e.revive && usable(s)
    }),
  )
}

export interface Improvement {
  /** 下げるスキル（'' は残りの SP を使うだけ） */
  fromId: string
  fromName: string
  toId: string
  toName: string
  /** 動かす SP（下げたレベルの合計。前提スキルの連鎖で下がった分を含む） */
  moved: number
  alloc: Allocation
  before: number
  after: number
}

const nameOf = (skills: Skill[], id: string) => skills.find((s) => s.id === id)?.name ?? id

/**
 * 改善案（C6）：そのメンバーの役割の点数が最も上がる「振り替え」を上位3つ出す。
 * 振り替え＝スキル A を 1〜5 レベル下げ（A を前提にするスキルも下がる）、空いた SP で役割に効くスキル B をできるだけ上げる。
 * 残りの SP がある場合は「A を下げずに B を上げる」も候補にする。点数の伸びが大きい順、同じなら動かす SP が少ない順
 */
export function improvements(member: Member, axis: MemberAxis, s: ScoreSettings, optimum: number): Improvement[] {
  if (optimum <= 0) return []
  const skills = skillsByJob[member.jobId] ?? []
  const total = spTotal(rules, member.level, retireSpBonus(rules, member.retire))
  const score = (alloc: Allocation) => ratioScore(memberValue({ ...member, skills: alloc }, axis, s), optimum) ?? 0
  const before = score(member.skills)
  const targets = relevantSkills(member, axis)
  const best = new Map<string, Improvement>()

  const tryRaise = (fromId: string, base: Allocation, moved: number) => {
    for (const to of targets) {
      if (to.id === fromId) continue
      // 上げられるところまで上げる（前提スキルも自動で取る）。どのスキルもレベルを上げて評価が下がることはない
      let alloc: Allocation | null = null
      for (let lv = (base[to.id] ?? 0) + 1; lv <= to.maxLevel; lv++) {
        const next = setSkillLevel(skills, base, to.id, lv)
        if (spUsed(next) > total) break
        alloc = next
      }
      if (!alloc) continue
      const after = score(alloc)
      if (after <= before + 1e-6) continue
      const key = `${fromId}|${to.id}`
      const prev = best.get(key)
      if (!prev || after > prev.after + 1e-9 || (Math.abs(after - prev.after) < 1e-9 && moved < prev.moved))
        best.set(key, { fromId, fromName: fromId ? nameOf(skills, fromId) : '残りの SP', toId: to.id, toName: to.name, moved, alloc, before, after })
    }
  }

  tryRaise('', member.skills, 0)
  for (const from of skills) {
    const lv = member.skills[from.id] ?? 0
    for (let d = 1; d <= Math.min(lv, 5); d++) {
      const lowered = setSkillLevel(skills, member.skills, from.id, lv - d)
      tryRaise(from.id, lowered, spUsed(member.skills) - spUsed(lowered))
    }
  }
  return [...best.values()].sort((a, b) => b.after - a.after || a.moved - b.moved).slice(0, 3)
}

export interface NextSkill {
  skillId: string
  name: string
  /** 振ったあとのレベル */
  level: number
  /** 使う SP（前提スキルを自動で取る分を含む） */
  cost: number
  alloc: Allocation
  /** 軸ごとの点数の伸び（その軸の行動ができないなら null） */
  gains: Record<MemberAxis, number | null>
}

/**
 * 次に振るスキル（B6）：今の振り方にスキルを1レベル足した全候補の、軸ごとの点数の伸び（その軸にそれ自体が効くスキルだけ）。
 * 前提スキルが足りないスキルは、前提も含めた SP で評価する。残りの SP で振れない候補は出さない
 */
export function nextSkills(member: Member, s: ScoreSettings, optima: Record<MemberAxis, number>): NextSkill[] {
  const skills = skillsByJob[member.jobId] ?? []
  const total = spTotal(rules, member.level, retireSpBonus(rules, member.retire))
  const scoreOf = (alloc: Allocation, axis: MemberAxis) => ratioScore(memberValue({ ...member, skills: alloc }, axis, s), optima[axis])
  const now = Object.fromEntries(MEMBER_AXES.map((a) => [a, scoreOf(member.skills, a)])) as Record<MemberAxis, number | null>
  const relevant = Object.fromEntries(MEMBER_AXES.map((a) => [a, new Set(relevantSkills(member, a).map((x) => x.id))])) as Record<MemberAxis, Set<string>>
  const out: NextSkill[] = []
  for (const sk of skills) {
    const lv = member.skills[sk.id] ?? 0
    if (lv >= sk.maxLevel) continue
    const alloc = setSkillLevel(skills, member.skills, sk.id, lv + 1)
    if (spUsed(alloc) > total) continue
    const gains = Object.fromEntries(
      MEMBER_AXES.map((a) => {
        if (!relevant[a].has(sk.id)) return [a, null]
        const after = scoreOf(alloc, a)
        return [a, after === null || now[a] === null ? null : after - now[a]!]
      }),
    ) as Record<MemberAxis, number | null>
    out.push({ skillId: sk.id, name: sk.name, level: lv + 1, cost: spUsed(alloc) - spUsed(member.skills), alloc, gains })
  }
  return out
}

export interface ScoreAll {
  score: PartyScore
  /** メンバー ID → 改善案 */
  ideas: Record<string, Improvement[]>
  /** 選んだメンバーの次に振るスキル */
  next: NextSkill[]
}

/** 採点・改善案・次に振るスキルをまとめて計算する（画面の「採点する」） */
export function scoreAll(party: Party, roles: Record<string, Role>, weights: Weights, selectedId: string): ScoreAll {
  const members = party.members
  const settings = { difficulty: party.difficulty, target: null, partySize: members.length }
  const score = scoreParty(members, roles, weights, settings)
  const ideas: Record<string, Improvement[]> = {}
  for (const x of score.members) {
    if (x.role !== 'damage' && x.role !== 'ailment' && x.role !== 'heal') continue
    ideas[x.member.id] = improvements(x.member, x.role, settings, x.axes[x.role].optimum.value)
  }
  const sel = score.members.find((x) => x.member.id === selectedId) ?? score.members[0]
  const optima = Object.fromEntries(MEMBER_AXES.map((a) => [a, sel.axes[a].optimum.value])) as Record<MemberAxis, number>
  return { score, ideas, next: nextSkills(sel.member, settings, optima) }
}
