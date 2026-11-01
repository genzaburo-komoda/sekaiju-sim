// 条件付き最適化とジョブ編成の探索（仕様書 B10）。
//
// 比べ方（2026-10-18 本人決定：撃破ターン＋耐久）：
//   点数 ＝ 重み付き平均（撃破の点、耐久の点）。どちらも 0〜1
//   - 撃破の点：選んだ敵を期待値で何ターンで倒せるか（B2 の最小ターン数）。k ターンで倒せたら (上限 + 1 − (k − 1 + 最後のターンの割合)) ÷ (上限 + 1)。
//     最後のターンの割合は、倒すのに要ったダメージの割合（同じターン数なら余裕のある方が高い）。2026-11-01 に、1ターンで倒すと 1 を超えていたのを直した
//     上限までに倒せなければ、削った HP の割合 ÷ (上限 + 1)（倒せた編成より必ず低い）
//     2026-11-01（本人決定）：撃破の点 ＝ 上の速さの点 × 0.8 ＋ 余った火力 × 0.2。余った火力は、倒すまでのターンに敵が倒れても
//     攻撃を続けたときの総ダメージが敵の HP を超えた分（0〜2倍を 0〜1 に。倒せなければ 0）。1〜2ターンで倒せる敵でも、
//     倒すのに要らない人の火力が点数に出るようにするため（火力役が後列に置かれていた）
//   - 耐久の点：敵の行動（B9 の表）に対して、決めたターン数のあと生き残っている確率の、メンバーの平均
//     2026-11-01（Claude 決定、仮）：生き残る確率 × 0.8 ＋ 最後に残った HP の割合 × 0.2 にした。
//     全員が生き残る敵では生き残る確率だけでは差が付かず、後列に置いて受けるダメージを減らす効果が点数に出なかったため
// 探索するメンバーの武器（2026-10-18 本人決定）：入手時期に関係なく、そのジョブが持てる武器の種類ごとに最も攻撃力の高いものを試し、
//   ダメージが最も大きくなるものを使う。2026-11-01（本人の依頼）：「レベルに応じた装備」を選ぶと、枠のレベルで手に入る物（equipByLevel.ts）の中から同じように選ぶ
// 探索するメンバーの振り方（Claude 決定）：ジョブごとに次の候補を作る
//   - 火力：最大ダメージの最適化（C2。自己強化・構えも使う）
//   - 支援：攻撃に効く強化・弱体（舞曲・軟身の呪言など）を先に上げ、残りの SP で火力の振り方を足す
//   - 回復：1ターンの総回復量の最適化（C4）に、残りの SP で火力の振り方を足す
//   - 盾：フロントガードと耐久に効くパッシブを先に上げ、残りの SP で火力の振り方を足す
// 探し方：探索する枠を1つずつ埋めていくビームサーチ（近似解）。途中の編成もそのまま評価し、点数のよい beamWidth 個を残す
// 隊列（2026-11-01 本人の指摘で追加）：searchRows なら、ジョブを決めた上位 ROW_FINALISTS 個の編成について、
//   探索する枠の前列・後列の並べ方をすべて試す（前列1〜3人・後列0〜3人を守る）。
//   後列は弓以外の物理攻撃の攻撃値が半分、物理攻撃に対して (VIT＋防具) が2倍、狙われにくい。それを撃破と耐久の評価で比べる
import { equipment, findEquipment, findJob, jobs as allJobs, rules, skillsByJob } from '../data/gameData'
import type { Skill } from '../data/schema'
import { defaultPolicy, findMinTurns, planDamageRatio, runPlan, simulateEndurance, type Progress } from './battle'
import { ARMOR_SLOT_RULES, armorChoices } from './equip'
import { equipAllowsAtLevel, type EquipFilter } from './equipByLevel'
import { optimizeMaxDamage } from './optimize'
import { MAX_BACK, MAX_FRONT, MIN_FRONT, type Member, type Row } from './party'
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
  /** 必ず入れるジョブ（固定のメンバーも含めて数える。最大 MAX_REQUIRED_JOBS） */
  requiredJobs: string[]
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
  /** 武器・防具の選び方：all＝すべてから最強、level＝枠のレベルで手に入る物から（equipByLevel.ts。2026-11-01 追加） */
  equipment: 'all' | 'level'
  /** 探索する枠の隊列も探す（false なら今の枠の隊列のまま） */
  searchRows: boolean
}

export const DEFAULT_CONDITIONS: Omit<SearchConditions, 'fixed'> = {
  noDuplicateJobs: true,
  excludedJobs: [],
  requiredJobs: [],
  requiredSkills: [],
  weights: { kill: 50, endurance: 50 },
  maxTurns: 15,
  enduranceTurns: 10,
  trials: 200,
  seed: 1,
  beamWidth: 4,
  equipment: 'all',
  searchRows: true,
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
export function mergeGreedy(skills: Skill[], base: Allocation, add: Allocation, total: number): Allocation {
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

/** 装備を候補にしてよいか（おすすめパーティと「レベルに応じた装備」では入手の階層と価格で絞る。equipByLevel.ts）。省略はすべて */
export type { EquipFilter }
const ALL: EquipFilter = () => true

/** ジョブが持てる武器のうち、種類ごとに最も攻撃力が高いもの（盾は除く） */
function strongestWeapons(jobId: string, allow: EquipFilter = ALL): (string | null)[] {
  const best = new Map<string, { id: string; atk: number }>()
  for (const e of equipment) {
    if (e.slot !== 'weapon' || !e.weaponType || e.weaponType === 'shield' || !e.jobs.includes(jobId) || !allow(e.id)) continue
    const cur = best.get(e.weaponType)
    if (!cur || (e.atk ?? 0) > cur.atk) best.set(e.weaponType, { id: e.id, atk: e.atk ?? 0 })
  }
  return best.size ? [...best.values()].map((x) => x.id) : [null]
}

/**
 * 探索するメンバーの防具：枠ごとに、まだ使っていない種類のうち防御力が最も高いもの（2026-10-18、Claude 決定。
 * 武器を「全武器から最強」にしたのに合わせた）。意味が確かめられない特性の防具（殺戮の盾）は除く
 */
export function strongestArmor(jobId: string, allow: EquipFilter = ALL): (string | null)[] {
  const used = new Set<string>()
  return ARMOR_SLOT_RULES.map((_, i) => {
    const best = armorChoices(i, jobId)
      .filter((e) => !used.has(e.slot) && !e.notes?.includes('意味が確かめられない') && allow(e.id))
      .sort((a, b) => (b.def ?? 0) - (a.def ?? 0))[0]
    if (!best) return null
    used.add(best.slot)
    return best.id
  })
}

/** 探索するメンバーの振り方の候補（ジョブ・レベル・隊列・敵ごと） */
export function buildsFor(slot: Member, jobId: string, setup: BattleSetup, required: string[], allow: EquipFilter = ALL): Build[] {
  const skills = skillsByJob[jobId] ?? []
  const total = spTotal(rules, slot.level, retireSpBonus(rules, null))
  const base = mergeGreedy(skills, {}, Object.fromEntries(required.filter((id) => skills.some((s) => s.id === id)).map((id) => [id, 1])), total)
  const target = setup.target
  const opts = { enemyCount: 1, preBuffed: true }
  // 武器：種類ごとの最強の武器で火力の最適化をして、最も大きいもの
  let damage: { alloc: Allocation; weaponId: string | null; expected: number } = { alloc: {}, weaponId: null, expected: -1 }
  for (const weaponId of strongestWeapons(jobId, allow)) {
    const m: Member = { ...slot, jobId, weaponId, armorIds: strongestArmor(jobId, allow), skills: {}, retire: null }
    const c = optimizeMaxDamage(m, target, setup.difficulty, opts)[0]
    // 同じ期待値なら攻撃力の高い武器（術式は武器の攻撃力を使わないので、どの杖でも同じ値になる）
    const better = c && (c.expected > damage.expected || (c.expected === damage.expected && (findEquipment(weaponId)?.atk ?? 0) > (findEquipment(damage.weaponId)?.atk ?? 0)))
    if (c && better) damage = { alloc: c.alloc, weaponId, expected: c.expected }
  }
  const member: Member = { ...slot, jobId, weaponId: damage.weaponId, armorIds: strongestArmor(jobId, allow), skills: {}, retire: null }
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

/** 撃破の点のうち「余った火力」の重みと、頭打ちにする超過分（敵の HP の何倍まで数えるか）。2026-11-01 本人決定（値は Claude の仮置き） */
const SURPLUS_WEIGHT = 0.2
const SURPLUS_CAP = 2

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
    const speed = (c.maxTurns + 1 - (found.killTurn - 1 + frac)) / (c.maxTurns + 1)
    // 余った火力：倒すまでのターンに、敵が倒れても攻撃を続けたときの総ダメージが敵の HP を超えた分（敵の HP の2倍で頭打ち）
    const surplus = Math.min(SURPLUS_CAP, Math.max(0, planDamageRatio(s, found.plan, found.killTurn) - 1)) / SURPLUS_CAP
    killScore = (1 - SURPLUS_WEIGHT) * speed + SURPLUS_WEIGHT * surplus
  } else {
    hpDealt = Math.max(0, 1 - run.state.enemy.hp / run.state.enemy.maxHp)
    killScore = ((1 - SURPLUS_WEIGHT) * hpDealt) / (c.maxTurns + 1)
  }
  let survive = 1
  let enduranceScore = 1
  if (setup.enemyActions.length || setup.enemyAi) {
    const policies = Object.fromEntries(members.map((m) => [m.id, defaultPolicy(m)]))
    const r = simulateEndurance({ ...setup, members }, policies, c.enduranceTurns, c.trials, c.seed)
    survive = r.members.reduce((a, x) => a + x.survive, 0) / r.members.length
    const hp = r.members.reduce((a, x) => a + x.meanHpRatio, 0) / r.members.length
    enduranceScore = 0.8 * survive + 0.2 * hp
  }
  const w = c.weights.kill + c.weights.endurance
  const score = w > 0 ? (c.weights.kill * killScore + c.weights.endurance * enduranceScore) / w : 0
  return { members, kinds, killTurn: found.killTurn, hpDealt, survive, killScore, enduranceScore, score }
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
  // 必須のジョブ（2026-11-01 本人の依頼）：どの段でも「まだ入っていない必須のジョブの数 ≦ 残りの枠の数」を守り、最後に必ずそろうようにする
  const requiredJobs = [...new Set(cond.requiredJobs ?? [])]
  if (requiredJobs.length > MAX_REQUIRED_JOBS) return { best: [], evaluated: 0, error: `必須のジョブは${MAX_REQUIRED_JOBS}つまでです` }
  const bothJobs = requiredJobs.filter((j) => cond.excludedJobs.includes(j))
  if (bothJobs.length) return { best: [], evaluated: 0, error: `${bothJobs.map((j) => findJob(j).name).join('・')}が「必須」と「使わない」の両方に入っています` }
  const missingJobs = (used: Set<string>) => requiredJobs.filter((j) => !used.has(j)).length
  if (missingJobs(new Set(fixedJobs)) > searchIdx.length) return { best: [], evaluated: 0, error: '必須のジョブが、固定していない枠の数より多いです（固定を外すか、必須のジョブを減らしてください）' }

  // 武器・防具の候補：すべて、または枠のレベルで手に入る物
  const allowFor = (slot: Member): EquipFilter => (cond.equipment === 'level' ? equipAllowsAtLevel(slot.level) : ALL)

  // 枠ごと・ジョブごとの振り方の候補（同じレベル・隊列の枠は使い回す）
  const cache = new Map<string, Build[]>()
  const builds = (slot: Member, jobId: string) => {
    const key = `${jobId}|${slot.level}|${slot.row}`
    let b = cache.get(key)
    if (!b) {
      b = buildsFor(slot, jobId, setup, cond.requiredSkills, allowFor(slot))
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
        if (missingJobs(new Set([...used, jobId])) > searchIdx.length - step - 1) continue
        for (const b of builds(slots[i], jobId)) {
          const member: Member = { ...slots[i], name: findJob(jobId).name, jobId, skills: b.alloc, weaponId: b.weaponId, armorIds: strongestArmor(jobId, allowFor(slots[i])), retire: null }
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
    beam = next.slice(0, last ? (cond.searchRows ? ROW_FINALISTS : 5) : cond.beamWidth)
    onProgress?.(step + 1, totalSteps)
    if (!beam.length) break
  }

  // 隊列の探索（2段目）：ジョブと振り方の決まった上位の編成ごとに、探索する枠の前列・後列の並べ方をすべて試す。
  // 枠を埋めながら隊列も選ぶと、途中の少人数の編成では後列が有利に見えて偏るため、ジョブを決めてから並べ直す
  if (cond.searchRows && beam.length && searchIdx.length) {
    const finals: PartyEval[] = []
    const seen = new Set<string>()
    for (const st of beam) {
      for (const rows of rowAssignments(slots, cond.fixed)) {
        const members: Member[] = []
        const kinds: BuildKind[] = []
        slots.forEach((m, i) => {
          if (cond.fixed[i]) {
            members.push(m)
            kinds.push('fixed')
            return
          }
          const p = st.picks.get(i)!
          const slot: Member = { ...slots[i], row: rows[i] }
          // 隊列が変わると武器（弓か）と振り方の最適が変わるので、同じ種類の振り方を作り直す
          const b = rows[i] === p.member.row ? null : builds(slot, p.member.jobId).find((x) => x.kind === p.kind)
          members.push(b ? { ...p.member, row: rows[i], skills: b.alloc, weaponId: b.weaponId } : { ...p.member, row: rows[i] })
          kinds.push(p.kind)
        })
        const key = members.map((m, k) => `${m.row}:${m.jobId}:${kinds[k]}`).sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        if (missingSkills(members, cond.requiredSkills).length) continue
        finals.push(evaluateParty(setup, members, kinds, cond))
        evaluated++
      }
    }
    finals.sort((a, b) => b.score - a.score)
    return { best: finals.slice(0, 5), evaluated, error: finals.length ? null : '条件を満たす編成がありません（必須のスキルを見直してください）' }
  }

  if (searchIdx.length === 0) {
    const { members, kinds } = partyOf(beam[0])
    if (missingSkills(members, cond.requiredSkills).length) return { best: [], evaluated: 0, error: '固定したメンバーだけでは必須のスキルがそろいません' }
    return { best: [evaluateParty(setup, members, kinds, cond)], evaluated: 1, error: null }
  }
  if (!beam.length) return { best: [], evaluated, error: '条件を満たす編成がありません（ジョブの除外・必須のジョブ・重複なし・必須のスキルを見直してください）' }
  return { best: beam.map((s) => s.eval!), evaluated, error: null }
}

/** 必須のジョブの数の上限（パーティの人数） */
export const MAX_REQUIRED_JOBS = 5

/** 隊列の探索で並べ直す、ジョブを決めた上位の編成の数 */
const ROW_FINALISTS = 5

/** 隊列の決まり（前列1〜3人・後列0〜3人）を守る並べ方。固定の枠は今の隊列のまま */
export function rowAssignments(slots: Member[], fixed: boolean[]): Row[][] {
  const out: Row[][] = []
  const free = slots.map((_, i) => i).filter((i) => !fixed[i])
  for (let mask = 0; mask < 1 << free.length; mask++) {
    const rows = slots.map((m) => m.row)
    free.forEach((i, k) => (rows[i] = mask & (1 << k) ? 'back' : 'front'))
    const front = rows.filter((r) => r === 'front').length
    if (front >= MIN_FRONT && front <= MAX_FRONT && rows.length - front <= MAX_BACK) out.push(rows)
  }
  return out
}

/** 結果の表示用：メンバーの説明（ジョブ・振り方の種類・武器） */
export function describeMember(m: Member, kind: BuildKind): string {
  const weapon = equipment.find((e) => e.id === m.weaponId)?.name ?? '素手'
  return `${findJob(m.jobId).name}（${BUILD_LABELS[kind]}・${m.row === 'front' ? '前列' : '後列'}・${weapon}）`
}
