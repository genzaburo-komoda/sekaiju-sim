// 条件付き最適化とジョブ編成の探索（仕様書 B10）。
//
// 比べ方（2026-10-18 本人決定：撃破ターン＋耐久）：
//   点数 ＝ 重み付き平均（撃破の点、耐久の点）。どちらも 0〜1
//   - 撃破の点：選んだ敵を期待値で何ターンで倒せるか（B2 の最小ターン数）。k ターンで倒せたら (上限 − k + 1) ÷ 上限。
//     ただし最後のターンは、倒すのに要ったダメージの割合だけ数える（同じターン数なら余裕のある方が高い）。
//     上限までに倒せなければ、削った HP の割合 ÷ (上限 + 1)（倒せた編成より必ず低い）
//   - 耐久の点：敵の行動（B9 の表）に対して、決めたターン数のあと生き残っている確率の、メンバーの平均
// 探索するメンバーの武器（2026-10-18 本人決定）：入手時期に関係なく、そのジョブが持てる武器の種類ごとに最も攻撃力の高いものを試し、
//   ダメージが最も大きくなるものを使う
// 探索するメンバーの振り方（Claude 決定）：ジョブごとに次の候補を作る
//   - 火力：最大ダメージの最適化（C2。自己強化・構えも使う）
//   - 支援：攻撃に効く強化・弱体（舞曲・軟身の呪言など）を先に上げ、残りの SP で火力の振り方を足す
//   - 回復：1ターンの総回復量の最適化（C4）に、残りの SP で火力の振り方を足す
//   - 盾：フロントガードと耐久に効くパッシブを先に上げ、残りの SP で火力の振り方を足す
// 探し方：探索する枠を1つずつ埋めていくビームサーチ（近似解）。途中の編成もそのまま評価し、点数のよい beamWidth 個を残す
import { equipment, findJob, jobs as allJobs, rules, skillsByJob } from '../data/gameData'
import type { Skill } from '../data/schema'
import { defaultPolicy, findMinTurns, runPlan, simulateEndurance, type Progress } from './battle'
import { ARMOR_SLOT_RULES, armorChoices } from './equip'
import { optimizeMaxDamage } from './optimize'
import type { Member } from './party'
import { retireSpBonus } from './retire'
import { memberOptimum } from './score'
import type { BattleSetup } from './sim'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'
import { optimizeHeal } from './support'

export interface SearchConditions {
  /** メンバーの並び順ごとに、振り方を固定するか（false ならジョブ・振り方・武器を探す） */
  fixed: boolean[]
  /** ジョブの重複なし（固定のメンバーも含めて） */
  noDuplicateJobs: boolean
  /** 使わないジョブ */
  excludedJobs: string[]
  /** パーティの誰かが Lv1 以上持っていなければならないスキル（スキル ID） */
  requiredSkills: string[]
  /** 重み（撃破・耐久） */
  weights: { kill: number; endurance: number }
  /** 撃破までのターン数の上限 */
  maxTurns: number
  /** 耐久を見るターン数・試行回数・シード */
  enduranceTurns: number
  trials: number
  seed: number
  /** ビームサーチで残す編成の数 */
  beamWidth: number
}

export const DEFAULT_CONDITIONS: Omit<SearchConditions, 'fixed'> = {
  noDuplicateJobs: true,
  excludedJobs: [],
  requiredSkills: [],
  weights: { kill: 50, endurance: 50 },
  maxTurns: 15,
  enduranceTurns: 10,
  trials: 200,
  seed: 1,
  beamWidth: 4,
}

export type BuildKind = 'damage' | 'support' | 'heal' | 'guard' | 'fixed'
export const BUILD_LABELS: Record<BuildKind, string> = { damage: '火力', support: '支援', heal: '回復', guard: '盾', fixed: '固定' }

export interface PartyEval {
  members: Member[]
  /** メンバーごとの振り方の種類 */
  kinds: BuildKind[]
  killTurn: number | null
  /** 倒せなかったときの、削った HP の割合 */
  hpDealt: number
  /** 生き残る確率のメンバー平均 */
  survive: number
  killScore: number
  enduranceScore: number
  score: number
}

export interface SearchResult {
  /** 点数の高い順（最大5つ） */
  best: PartyEval[]
  evaluated: number
  /** 条件を満たす編成が無いときの理由 */
  error: string | null
}

interface Build {
  kind: BuildKind
  alloc: Allocation
  weaponId: string | null
}

/** base に add のスキルを、SP が足りる範囲でできるだけ足す（前提スキルは自動で取る） */
function mergeGreedy(skills: Skill[], base: Allocation, add: Allocation, total: number): Allocation {
  let alloc = base
  for (const [id, lv] of Object.entries(add)) {
    for (let l = lv; l > (alloc[id] ?? 0); l--) {
      const next = setSkillLevel(skills, alloc, id, l)
      if (spUsed(next) <= total) {
        alloc = next
        break
      }
    }
  }
  return alloc
}

/** スキルを、SP が足りる範囲でできるだけ上げる */
const raiseAll = (skills: Skill[], base: Allocation, ids: string[], total: number) =>
  mergeGreedy(skills, base, Object.fromEntries(ids.map((id) => [id, skills.find((s) => s.id === id)!.maxLevel])), total)

/** ジョブが持てる武器のうち、種類ごとに最も攻撃力が高いもの（盾は除く） */
function strongestWeapons(jobId: string): (string | null)[] {
  const best = new Map<string, { id: string; atk: number }>()
  for (const e of equipment) {
    if (e.slot !== 'weapon' || !e.weaponType || e.weaponType === 'shield' || !e.jobs.includes(jobId)) continue
    const cur = best.get(e.weaponType)
    if (!cur || (e.atk ?? 0) > cur.atk) best.set(e.weaponType, { id: e.id, atk: e.atk ?? 0 })
  }
  return best.size ? [...best.values()].map((x) => x.id) : [null]
}

/**
 * 探索するメンバーの防具：枠ごとに、まだ使っていない種類のうち防御力が最も高いもの（2026-10-18、Claude 決定。
 * 武器を「全武器から最強」にしたのに合わせた）。意味が確かめられない特性の防具（殺戮の盾）は除く
 */
export function strongestArmor(jobId: string): (string | null)[] {
  const used = new Set<string>()
  return ARMOR_SLOT_RULES.map((_, i) => {
    const best = armorChoices(i, jobId)
      .filter((e) => !used.has(e.slot) && !e.notes?.includes('意味が確かめられない'))
      .sort((a, b) => (b.def ?? 0) - (a.def ?? 0))[0]
    if (!best) return null
    used.add(best.slot)
    return best.id
  })
}

/** 探索するメンバーの振り方の候補（ジョブ・レベル・隊列・敵ごと） */
export function buildsFor(slot: Member, jobId: string, setup: BattleSetup, required: string[]): Build[] {
  const skills = skillsByJob[jobId] ?? []
  const total = spTotal(rules, slot.level, retireSpBonus(rules, null))
  const base = mergeGreedy(skills, {}, Object.fromEntries(required.filter((id) => skills.some((s) => s.id === id)).map((id) => [id, 1])), total)
  const target = setup.target
  const opts = { enemyCount: 1, preBuffed: true }
  // 武器：種類ごとの最強の武器で火力の最適化をして、最も大きいもの
  let damage: { alloc: Allocation; weaponId: string | null; expected: number } = { alloc: {}, weaponId: null, expected: -1 }
  for (const weaponId of strongestWeapons(jobId)) {
    const m: Member = { ...slot, jobId, weaponId, armorIds: strongestArmor(jobId), skills: {}, retire: null }
    const c = optimizeMaxDamage(m, target, setup.difficulty, opts)[0]
    if (c && c.expected > damage.expected) damage = { alloc: c.alloc, weaponId, expected: c.expected }
  }
  const member: Member = { ...slot, jobId, weaponId: damage.weaponId, armorIds: strongestArmor(jobId), skills: {}, retire: null }
  const withDamage = (b: Allocation) => mergeGreedy(skills, b, damage.alloc, total)
  const builds: Build[] = [{ kind: 'damage', alloc: withDamage(base), weaponId: damage.weaponId }]

  const offensive = skills.filter((s) =>
    s.effects.some(
      (e) =>
        (e.type === 'buff' && e.target !== 'self' && e.modifiers.some((m) => m.stat === 'physAtk' || m.stat === 'damageDealt')) ||
        (e.type === 'debuff' && e.modifiers.some((m) => m.stat === 'physDef' && m.appliesTo === 'defense')),
    ),
  )
  if (offensive.length) builds.push({ kind: 'support', alloc: withDamage(raiseAll(skills, base, offensive.map((s) => s.id), total)), weaponId: damage.weaponId })

  const heal = optimizeHeal({ ...member, skills: base }, setup.members.length, setup.difficulty, { criterion: 'total', damage: 0, targets: 1 })[0]
  if (heal) builds.push({ kind: 'heal', alloc: withDamage(mergeGreedy(skills, base, heal.alloc, total)), weaponId: damage.weaponId })

  if (skills.some((s) => s.id === 'paladin-front-guard')) {
    const endure = memberOptimum(member, 'endurance', { difficulty: setup.difficulty, target: null, partySize: setup.members.length }).alloc
    builds.push({ kind: 'guard', alloc: withDamage(mergeGreedy(skills, raiseAll(skills, base, ['paladin-front-guard'], total), endure, total)), weaponId: damage.weaponId })
  }
  // 同じ振り方は1つにまとめる
  const seen = new Set<string>()
  return builds.filter((b) => {
    const key = JSON.stringify(Object.entries(b.alloc).sort())
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 編成の評価（撃破ターン＋耐久） */
export function evaluateParty(setup: BattleSetup, members: Member[], kinds: BuildKind[], c: Omit<SearchConditions, 'fixed'>): PartyEval {
  const s: BattleSetup = { ...setup, members, enemyActions: [] }
  const found = findMinTurns(s, c.maxTurns, 15)
  const run = runPlan(s, found.plan)
  let hpDealt = 1
  let killScore: number
  if (found.killTurn !== null) {
    // 最後のターンで必要だったダメージの割合を足して、同じターン数でも早く倒せる方を高くする
    const logs = run.logs
    const before = logs.length > 1 ? logs[logs.length - 2].enemyHp : run.state.enemy.maxHp
    const dealt = before - logs[logs.length - 1].enemyHp + Math.max(0, -run.state.enemy.hp)
    const frac = dealt > 0 ? Math.min(1, before / dealt) : 1
    killScore = (c.maxTurns - (found.killTurn - 1 + frac) + 1) / c.maxTurns
  } else {
    hpDealt = Math.max(0, 1 - run.state.enemy.hp / run.state.enemy.maxHp)
    killScore = hpDealt / (c.maxTurns + 1)
  }
  let survive = 1
  if (setup.enemyActions.length) {
    const policies = Object.fromEntries(members.map((m) => [m.id, defaultPolicy(m)]))
    const r = simulateEndurance({ ...setup, members }, policies, c.enduranceTurns, c.trials, c.seed)
    survive = r.members.reduce((a, x) => a + x.survive, 0) / r.members.length
  }
  const w = c.weights.kill + c.weights.endurance
  const score = w > 0 ? (c.weights.kill * killScore + c.weights.endurance * survive) / w : 0
  return { members, kinds, killTurn: found.killTurn, hpDealt, survive, killScore, enduranceScore: survive, score }
}

/** パーティの誰かが持っていなければならないスキルのうち、足りないもの */
export function missingSkills(members: Member[], required: string[]): string[] {
  return required.filter((id) => !members.some((m) => (m.skills[id] ?? 0) > 0))
}

/**
 * 条件付きで最適な編成を探す（B10）。setup.members が今のパーティ（並び順・隊列・レベルを使う）。
 * 固定のメンバーはそのまま、探索する枠はジョブ・振り方・武器を探す
 */
export function searchParty(setup: BattleSetup, cond: SearchConditions, onProgress?: Progress): SearchResult {
  const slots = setup.members
  const searchIdx = slots.map((_, i) => i).filter((i) => !cond.fixed[i])
  const fixedJobs = slots.filter((_, i) => cond.fixed[i]).map((m) => m.jobId)
  const jobs = allJobs.map((j) => j.id).filter((j) => !cond.excludedJobs.includes(j))
  if (cond.noDuplicateJobs && new Set(fixedJobs).size < fixedJobs.length) return { best: [], evaluated: 0, error: '固定したメンバーのジョブが重複しています' }

  // 枠ごと・ジョブごとの振り方の候補（同じレベル・隊列の枠は使い回す）
  const cache = new Map<string, Build[]>()
  const builds = (slot: Member, jobId: string) => {
    const key = `${jobId}|${slot.level}|${slot.row}`
    let b = cache.get(key)
    if (!b) {
      b = buildsFor(slot, jobId, setup, cond.requiredSkills)
      cache.set(key, b)
    }
    return b
  }

  type State = { picks: Map<number, { member: Member; kind: BuildKind }>; eval: PartyEval | null }
  const partyOf = (st: State) => {
    const members: Member[] = []
    const kinds: BuildKind[] = []
    slots.forEach((m, i) => {
      if (cond.fixed[i]) {
        members.push(m)
        kinds.push('fixed')
      } else {
        const p = st.picks.get(i)
        if (p) {
          members.push(p.member)
          kinds.push(p.kind)
        }
      }
    })
    return { members, kinds }
  }

  let beam: State[] = [{ picks: new Map(), eval: null }]
  let evaluated = 0
  const totalSteps = searchIdx.length
  for (let step = 0; step < searchIdx.length; step++) {
    const i = searchIdx[step]
    const last = step === searchIdx.length - 1
    const next: State[] = []
    const seen = new Set<string>()
    for (const st of beam) {
      const used = new Set([...fixedJobs, ...[...st.picks.values()].map((p) => p.member.jobId)])
      for (const jobId of jobs) {
        if (cond.noDuplicateJobs && used.has(jobId)) continue
        for (const b of builds(slots[i], jobId)) {
          const member: Member = { ...slots[i], name: findJob(jobId).name, jobId, skills: b.alloc, weaponId: b.weaponId, armorIds: strongestArmor(jobId), retire: null }
          const picks = new Map(st.picks)
          picks.set(i, { member, kind: b.kind })
          const cand: State = { picks, eval: null }
          const { members, kinds } = partyOf(cand)
          // 同じ隊列に同じジョブ・振り方の組み合わせは1回だけ
          const key = members.map((m, k) => `${m.row}:${m.jobId}:${kinds[k]}`).sort().join('|')
          if (seen.has(key)) continue
          seen.add(key)
          if (last && missingSkills(members, cond.requiredSkills).length) continue
          cand.eval = evaluateParty(setup, members, kinds, cond)
          evaluated++
          next.push(cand)
        }
      }
    }
    next.sort((a, b) => b.eval!.score - a.eval!.score)
    beam = next.slice(0, last ? 5 : cond.beamWidth)
    onProgress?.(step + 1, totalSteps)
    if (!beam.length) break
  }

  if (searchIdx.length === 0) {
    const { members, kinds } = partyOf(beam[0])
    if (missingSkills(members, cond.requiredSkills).length) return { best: [], evaluated: 0, error: '固定したメンバーだけでは必須のスキルがそろいません' }
    return { best: [evaluateParty(setup, members, kinds, cond)], evaluated: 1, error: null }
  }
  if (!beam.length) return { best: [], evaluated, error: '条件を満たす編成がありません（ジョブの除外・重複なし・必須のスキルを見直してください）' }
  return { best: beam.map((s) => s.eval!), evaluated, error: null }
}

/** 結果の表示用：メンバーの説明（ジョブ・振り方の種類・武器） */
export function describeMember(m: Member, kind: BuildKind): string {
  const weapon = equipment.find((e) => e.id === m.weaponId)?.name ?? '素手'
  return `${findJob(m.jobId).name}（${BUILD_LABELS[kind]}・${m.row === 'front' ? '前列' : '後列'}・${weapon}）`
}
