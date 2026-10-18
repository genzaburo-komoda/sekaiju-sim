// 戦闘シミュレーションの3つの機能（仕様書 B2・B3・B9）。1ターンの進め方は sim.ts。
//
// - B2 撃破までの最小ターン数：期待値で計算し、行動の計画を探す（近似解。下の findMinTurns）
// - B3 確率分布：計画どおりに乱数で何度も戦い、ダメージの分布と「n ターン以内に倒せる確率」を出す
// - B9 耐久：敵の行動（本人が入れる）に対して、各メンバーが何ターン生き残るか・全滅する確率を乱数で何度も試して出す
//
// どれも敵は1体。命中率は、味方の攻撃は入れず（味方の基礎命中が分からないため、当たった場合）、敵の攻撃は入れる。
import type { Member } from './party'
import { enemyDefense, enemyDown, initialState, memberActions, memberAtkRates, runTurn, specialElement, seededRng, SimContext, type BattleSetup, type BattleState, type Fighter, type Rng, type SimAction, type TurnLog } from './sim'
import type { InflictId } from './support'

/** 行動の計画：ターンごとの「メンバー ID → 行動 ID」 */
export type Plan = Record<string, string>[]

/** 計画の t ターン目（計画より長く戦うときは最後のターンの行動を繰り返す） */
const planAt = (plan: Plan, t: number): Record<string, string> => plan[Math.min(t, plan.length) - 1] ?? {}

export interface PlanRun {
  logs: TurnLog[]
  /** 倒したターン（倒せなければ null） */
  killTurn: number | null
  state: BattleState
}

/** 計画を期待値で実行する（B2 の結果の表示） */
export function runPlan(setup: BattleSetup, plan: Plan): PlanRun {
  const ctx = new SimContext(setup)
  let state = initialState(setup)
  const logs: TurnLog[] = []
  let killTurn: number | null = null
  for (let t = 1; t <= plan.length; t++) {
    const r = runTurn(ctx, state, { rng: null, plan: planAt(plan, t), fallback: 'normal', log: true })
    state = r.state
    logs.push(r.log!)
    if (enemyDown(state)) {
      killTurn = t
      break
    }
  }
  return { logs, killTurn, state }
}

// ---------------------------------------------------------------
// B2：撃破までの最小ターン数（ビームサーチ）
// ---------------------------------------------------------------

interface Node {
  state: BattleState
  plan: Plan
  score: number
}

/** 攻撃に効く強化・弱体か（与ダメージ・攻撃力・敵の防御力、序曲・チェイス） */
const offensive = (a: SimAction) =>
  a.special === 'imbue' || a.special === 'chase' ||
  (a.skill?.effects.some(
    (e) =>
      (e.type === 'buff' && e.modifiers.some((m) => m.stat === 'damageDealt' || m.stat === 'physAtk')) ||
      (e.type === 'debuff' && e.modifiers.some((m) => m.stat === 'physDef' && m.appliesTo === 'defense')),
  ) ?? false)

function attackRates(s: BattleState, f: Fighter) {
  return { ...memberAtkRates(f, s.turn + 1), ...enemyDefense(s) }
}

/** 今の強化のまま、TP が足りる攻撃で出せる1ターンのダメージの期待値（メンバーごと、行動の候補つき） */
function attackChoices(ctx: SimContext, s: BattleState, f: Fighter): { action: SimAction; expected: number }[] {
  const r = attackRates(s, f)
  const out: { action: SimAction; expected: number }[] = []
  for (const a of ctx.actions.get(f.id)!) {
    if (a.kind !== 'attack' || a.tp > f.tp) continue
    if (a.needsStance && !f.buffs.some((b) => b.skillId === a.needsStance)) continue
    const p = ctx.attack(f.id, a.id, r.atk, r.dealt, r.def, false, r.taken, s.enemy.guarding)
    if (p) out.push({ action: a, expected: p.expected })
  }
  return out.sort((x, y) => y.expected - x.expected)
}

/** 味方の危なさ（倒れた人は 3、それ以外は減った HP の割合の合計）。全滅率つきの探索（4-8）で評価に足す */
function partyRisk(s: BattleState): number {
  return s.members.reduce((n, f) => n + (f.alive ? 1 - Math.max(0, f.hp) / f.maxHp : 3), 0)
}

/**
 * 評価：倒すまでにかかりそうなターン数（今のターン ＋ 残りHP ÷ 今出せる1ターンのダメージ）＋ risk × 味方の危なさ。小さいほどよい。
 * risk が 0 なら今までどおり（最短だけを見る）
 */
function evaluate(ctx: SimContext, s: BattleState, risk = 0): number {
  if (enemyDown(s)) return s.turn + risk * partyRisk(s)
  return evaluateBase(ctx, s) + risk * partyRisk(s)
}

function evaluateBase(ctx: SimContext, s: BattleState): number {
  let potential = 0
  let tp = 0
  for (const f of s.members) {
    if (!f.alive) continue
    potential += attackChoices(ctx, s, f)[0]?.expected ?? 0
    tp += f.tp
  }
  if (potential <= 0) return Infinity
  // 同じなら TP が多く残る方を選ぶ
  return s.turn + s.enemy.hp / potential - tp * 1e-9
}

/** 守りの行動か（防御、被ダメージを減らす強化・敵の攻撃を下げる弱体、回復・治療、パリングなど） */
function defensiveKind(a: SimAction): boolean {
  if (a.kind === 'defend' || a.kind === 'heal' || a.kind === 'cure') return true
  if (a.special === 'parry' || a.special === 'evade-once' || a.special === 'endure') return true
  return (
    a.skill?.effects.some(
      (e) =>
        (e.type === 'buff' && e.modifiers.some((m) => ['physDef', 'elemDef', 'damageTaken', 'aggro', 'maxHp'].includes(m.stat))) ||
        (e.type === 'debuff' && e.modifiers.some((m) => m.stat === 'physAtk' || m.stat === 'accuracy')),
    ) ?? false
  )
}

/** 守りの行動の候補（その時に意味のあるものだけ） */
function defensiveCandidates(ctx: SimContext, s: BattleState, f: Fighter): string[] {
  const out: string[] = ['defend']
  const next = s.turn + 1
  const hurt = s.members.some((x) => x.alive && x.hp / x.maxHp < HEAL_THRESHOLD)
  for (const a of ctx.actions.get(f.id)!) {
    if (a.id === 'defend' || a.tp > f.tp || !defensiveKind(a)) continue
    if (a.needsStance && !f.buffs.some((b) => b.skillId === a.needsStance)) continue
    if (a.kind === 'heal') {
      if (hurt) out.push(a.id)
      continue
    }
    if (a.kind === 'cure') {
      if (policyAction(ctx, s, f, a.id) === a.id) out.push(a.id)
      continue
    }
    if (a.special === 'parry' || a.special === 'evade-once') {
      out.push(a.id)
      continue
    }
    // 強化・弱体：かかっていないか、次のターンで切れるもの（味方全体の強化は使った人の強化で見る）
    const holder = a.targetId ? s.members.find((x) => x.id === a.targetId) : f
    const on = a.kind === 'debuff' ? s.enemy.debuffs.find((b) => b.skillId === a.skill?.id) : holder?.buffs.find((b) => b.skillId === a.skill?.id)
    if (!on || (on.lastTurn !== Infinity && on.lastTurn <= next) || on.oneShot) out.push(a.id)
  }
  return out
}

/** 次のターンの、メンバーごとの行動の候補（攻撃の上位2つ、TP あたりで最も効率のよい攻撃、攻撃に効く強化・弱体） */
function candidates(ctx: SimContext, s: BattleState, f: Fighter, defensive = false): string[] {
  const attacks = attackChoices(ctx, s, f)
  const ids = new Set(attacks.slice(0, 2).map((x) => x.action.id))
  const efficient = attacks.filter((x) => x.action.tp > 0).sort((a, b) => b.expected / b.action.tp - a.expected / a.action.tp)[0]
  if (efficient) ids.add(efficient.action.id)
  ids.add('normal')
  const next = s.turn + 1
  // 序曲は、敵の弱点に最も合う属性だけを、まだ序曲のかかっていない味方に（候補が増えすぎないように）
  const vuln = ctx.spec.vuln
  const bestImbue = (['fire', 'ice', 'volt'] as const).reduce((a, b) => (vuln[b] > vuln[a] ? b : a))
  for (const a of ctx.actions.get(f.id)!) {
    if ((a.kind !== 'buff' && a.kind !== 'debuff') || a.tp > f.tp || !offensive(a)) continue
    if (a.special === 'imbue') {
      const t = s.members.find((x) => x.id === a.targetId)
      if (specialElement(a.skill!.id) === bestImbue && t?.alive && !t.buffs.some((b) => b.mods.some((m) => m.stat === 'imbue'))) ids.add(a.id)
      continue
    }
    if (a.special === 'chase') {
      ids.add(a.id)
      continue
    }
    const on = a.kind === 'debuff' ? s.enemy.debuffs.find((b) => b.skillId === a.id) : f.buffs.find((b) => b.skillId === a.id)
    // かかっていないか、次のターンで切れるものだけ
    if (!on || on.lastTurn <= next) ids.add(a.id)
  }
  if (defensive) for (const id of defensiveCandidates(ctx, s, f)) ids.add(id)
  return [...ids]
}

const stateKey = (s: BattleState) =>
  [
    Math.round(s.enemy.hp * 100),
    ...s.members.map((f) => `${f.tp}:${Math.round(f.alive ? f.hp : -1)}:${f.buffs.map((b) => `${b.skillId}@${b.lastTurn}`).join(',')}`),
    s.enemy.debuffs.map((b) => `${b.skillId}@${b.lastTurn}`).join(','),
  ].join('|')

export interface MinTurnsResult {
  plan: Plan
  /** 期待値で倒せたターン（maxTurns 以内に倒せなければ null） */
  killTurn: number | null
  /** 1ターンに調べた状態の数の上限（表示用） */
  beamWidth: number
}

/**
 * 撃破までの最小ターン数（B2）。期待値で計算し、ビームサーチで行動の計画を探す（近似解、仕様書 6.1）。
 * 1ターンの行動は「全員が今最もダメージの大きい攻撃」を基本に、1〜2人の行動を別の候補（別の攻撃・強化・弱体）に変えたものを試す。
 * 各ターンで評価のよい状態を beamWidth 個だけ残す
 */
export function findMinTurns(setup: BattleSetup, maxTurns: number, beamWidth = 30, risk = 0): MinTurnsResult {
  const ctx = new SimContext(setup)
  // 守りの行動も候補にするのは、敵が行動して risk が正のとき（4-8）
  const defensive = risk > 0 && ctx.enemyActs
  let beam: Node[] = [{ state: initialState(setup), plan: [], score: 0 }]
  for (let t = 1; t <= maxTurns; t++) {
    const next = new Map<string, Node>()
    for (const node of beam) {
      const alive = node.state.members.filter((f) => f.alive)
      if (!alive.length) continue
      const opts = alive.map((f) => candidates(ctx, node.state, f, defensive))
      const base = alive.map((f, i) => attackChoices(ctx, node.state, f)[0]?.action.id ?? opts[i][0])
      const joints: string[][] = [base]
      for (let i = 0; i < alive.length; i++) {
        for (const a of opts[i]) {
          if (a === base[i]) continue
          const one = [...base]
          one[i] = a
          joints.push(one)
          for (let j = i + 1; j < alive.length; j++) {
            for (const b of opts[j]) {
              if (b === base[j]) continue
              const two = [...one]
              two[j] = b
              joints.push(two)
            }
          }
        }
      }
      for (const joint of joints) {
        const plan = Object.fromEntries(alive.map((f, i) => [f.id, joint[i]]))
        const { state } = runTurn(ctx, node.state, { rng: null, plan, fallback: 'normal', log: false })
        const key = stateKey(state)
        if (state.members.every((f) => !f.alive)) continue
        const score = evaluate(ctx, state, risk)
        const prev = next.get(key)
        if (!prev || score < prev.score) next.set(key, { state, plan: [...node.plan, plan], score })
      }
    }
    const nodes = [...next.values()].sort((a, b) => a.score - b.score)
    // どの計画でも全滅する（期待値）なら、その前のターンまでの計画を返す
    if (!nodes.length) return { plan: beam[0]?.plan ?? [], killTurn: null, beamWidth }
    const killed = nodes.filter((n) => enemyDown(n.state))
    if (killed.length) {
      // 倒せた計画のうち、味方の危なさが最も小さく（risk が正のとき）、TP が最も多く残るもの
      const tpLeft = (n: Node) => n.state.members.reduce((sum, f) => sum + f.tp, 0)
      const best = killed.sort((a, b) => (risk > 0 ? partyRisk(a.state) - partyRisk(b.state) : 0) || tpLeft(b) - tpLeft(a))[0]
      return { plan: best.plan, killTurn: t, beamWidth }
    }
    beam = nodes.slice(0, beamWidth)
  }
  return { plan: beam[0]?.plan ?? [], killTurn: null, beamWidth }
}

// ---------------------------------------------------------------
// 4-8：全滅率の上限つきの最短ターン
// ---------------------------------------------------------------

/** 計画を乱数で何度も戦わせた結果 */
export interface PlanCheck {
  /** 上限のターン数までに倒せた割合 */
  killRate: number
  /** 倒すまでのターン数の期待値（倒せなかった回は上限＋1 ターンとして数える） */
  expectedTurns: number
  /** 倒せた回だけの平均ターン数 */
  meanKillTurn: number | null
  /** 倒す前に全滅した割合 */
  wipeRate: number
  /** 倒すまでに1人でも倒れた割合 */
  anyDownRate: number
}

/** 計画を乱数で trials 回戦わせる（計画より長いターンは最後のターンの行動をくり返す） */
export function checkPlan(setup: BattleSetup, plan: Plan, maxTurns: number, trials: number, seed: number): PlanCheck {
  const ctx = new SimContext(setup)
  const rng = seededRng(seed)
  const start = initialState(setup)
  let kills = 0
  let wipes = 0
  let anyDown = 0
  let sumTurns = 0
  let sumKill = 0
  for (let i = 0; i < trials; i++) {
    let s = start
    let killTurn: number | null = null
    for (let t = 1; t <= maxTurns; t++) {
      s = runTurn(ctx, s, { rng, plan: planAt(plan, t), fallback: 'normal', log: false }).state
      if (enemyDown(s)) {
        killTurn = t
        break
      }
      if (s.members.every((f) => !f.alive)) break
    }
    if (s.members.some((f) => !f.alive)) anyDown += 1
    if (killTurn !== null) {
      kills += 1
      sumKill += killTurn
      sumTurns += killTurn
    } else {
      sumTurns += maxTurns + 1
      if (s.members.every((f) => !f.alive)) wipes += 1
    }
  }
  return { killRate: kills / trials, expectedTurns: sumTurns / trials, meanKillTurn: kills ? sumKill / kills : null, wipeRate: wipes / trials, anyDownRate: anyDown / trials }
}

export interface SafePlan {
  /** 探索で使った「危なさ」の重み（0 は最短だけを見た計画） */
  risk: number
  plan: Plan
  /** 期待値の計算で倒せたターン */
  killTurn: number | null
  check: PlanCheck
}

export interface SafeSearchResult {
  candidates: SafePlan[]
  /** 選んだ計画（candidates の添字）。上限を満たすものが無ければ全滅率が最も低いもの */
  best: number
  /** 全滅率の上限を満たす計画があったか */
  satisfied: boolean
  wipeLimit: number
}

/** 探索で試す「危なさ」の重み。0 は最短だけ、大きいほど守りを重く見る（Claude 決定） */
export const RISK_WEIGHTS = [0, 0.3, 1, 3, 10]

/**
 * 全滅率の上限つきの最短ターン（4-8、2026-10-18 本人決定）：
 * 「危なさ」の重みを変えて期待値のビームサーチで候補の計画を作り、それぞれを乱数で trials 回戦わせて、
 * 全滅率が上限以下のうち倒すまでのターン数の期待値が最も短い計画を選ぶ
 */
export function findSafeMinTurns(
  setup: BattleSetup, o: { maxTurns: number; wipeLimit: number; trials: number; seed: number; beamWidth?: number }, onProgress?: Progress,
): SafeSearchResult {
  const seen = new Set<string>()
  const candidates: SafePlan[] = []
  RISK_WEIGHTS.forEach((risk, i) => {
    const r = findMinTurns(setup, o.maxTurns, o.beamWidth ?? (risk > 0 ? 15 : 30), risk)
    const key = JSON.stringify(r.plan)
    if (r.plan.length && !seen.has(key)) {
      seen.add(key)
      candidates.push({ risk, plan: r.plan, killTurn: r.killTurn, check: checkPlan(setup, r.plan, o.maxTurns, o.trials, o.seed) })
    }
    onProgress?.(i + 1, RISK_WEIGHTS.length)
  })
  const ok = candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.check.wipeRate <= o.wipeLimit && c.check.killRate > 0)
  const pick = (list: { c: SafePlan; i: number }[], by: (c: SafePlan) => number) => list.reduce((a, b) => (by(b.c) < by(a.c) - 1e-12 ? b : a))
  if (ok.length) return { candidates, best: pick(ok, (c) => c.check.expectedTurns + c.check.wipeRate * 1e-3).i, satisfied: true, wipeLimit: o.wipeLimit }
  const all = candidates.map((c, i) => ({ c, i }))
  return { candidates, best: all.length ? pick(all, (c) => c.check.wipeRate + c.check.expectedTurns * 1e-6).i : -1, satisfied: false, wipeLimit: o.wipeLimit }
}

// ---------------------------------------------------------------
// B3：確率分布（モンテカルロ法）
// ---------------------------------------------------------------

export interface KillDistribution {
  trials: number
  seed: number
  turns: number
  /** n ターン目の終わりまでに倒せた確率（添字 0 が1ターン目） */
  killBy: number[]
  /** 計画のターン数で与えた総ダメージの分布（区間の下限・上限・確率） */
  histogram: { lo: number; hi: number; p: number }[]
  mean: number
  min: number
  max: number
  /** 付けた状態異常（ID → 計画の間に1回以上付いた確率） */
  inflicted: Partial<Record<InflictId, number>>
}

const BINS = 20

/** 進み具合の知らせ（終わった回数、全部の回数） */
export type Progress = (done: number, total: number) => void
const PROGRESS_EVERY = 250

/**
 * 計画どおりに乱数で trials 回戦う（B3）。同じシード・同じ入力なら同じ結果（仕様書 5.6）。
 * 敵を倒しても計画のターン数まで続けて、総ダメージを数える（倒すまでのダメージではない）
 */
export function simulateKill(setup: BattleSetup, plan: Plan, trials: number, seed: number, onProgress?: Progress): KillDistribution {
  const ctx = new SimContext(setup)
  const rng = seededRng(seed)
  const turns = plan.length
  const kills = new Array<number>(turns).fill(0)
  const totals: number[] = []
  const inflictedCount: Partial<Record<InflictId, number>> = {}
  const start = initialState(setup)
  for (let i = 0; i < trials; i++) {
    let s = start
    let killed = false
    const seen = new Set<InflictId>()
    for (let t = 1; t <= turns; t++) {
      s = runTurn(ctx, s, { rng, plan: planAt(plan, t), fallback: 'normal', log: false }).state
      for (const id of Object.keys(s.enemy.ailments) as InflictId[]) seen.add(id)
      if (!killed && enemyDown(s)) {
        killed = true
        kills[t - 1] += 1
      }
    }
    for (const id of seen) inflictedCount[id] = (inflictedCount[id] ?? 0) + 1
    totals.push(start.enemy.hp - s.enemy.hp)
    if (onProgress && (i + 1) % PROGRESS_EVERY === 0) onProgress(i + 1, trials)
  }
  const killBy: number[] = []
  let c = 0
  for (const k of kills) killBy.push((c += k) / trials)
  return { trials, seed, turns, killBy, ...histogram(totals), inflicted: Object.fromEntries(Object.entries(inflictedCount).map(([k, v]) => [k, v! / trials])) }
}

/** 値の分布を区間に分ける */
export function histogram(values: number[]): { histogram: KillDistribution['histogram']; mean: number; min: number; max: number } {
  if (!values.length) return { histogram: [], mean: 0, min: 0, max: 0 }
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const v of values) {
    min = Math.min(min, v)
    max = Math.max(max, v)
    sum += v
  }
  const width = Math.max(1, Math.ceil((max - min + 1) / BINS))
  const bins: KillDistribution['histogram'] = []
  for (let lo = Math.floor(min); lo <= max; lo += width) bins.push({ lo, hi: lo + width - 1, p: 0 })
  for (const v of values) bins[Math.min(bins.length - 1, Math.floor((v - Math.floor(min)) / width))].p += 1 / values.length
  return { histogram: bins, mean: sum / values.length, min, max }
}

// ---------------------------------------------------------------
// B9：耐久
// ---------------------------------------------------------------

/** 回復スキルを使う目安：HP の割合がこれを下回る味方がいるとき */
export const HEAL_THRESHOLD = 0.7

/**
 * メンバーの行動のしかた（B9）。毎ターン同じ行動をするが、次のときは防御する：
 * - 回復スキル：HP が 70% を下回る味方がいないとき
 * - 強化・弱体・継続回復：まだかかっていて、次のターンも続くとき（フロントガードなど使ったターンだけのものは毎ターン使う）
 * - TP が足りないとき
 */
export function policyAction(ctx: SimContext, s: BattleState, f: Fighter, actionId: string): string {
  const a = ctx.action(f.id, actionId)
  if (!a || a.tp > f.tp) return 'defend'
  if (a.kind === 'heal') {
    const perTurn = a.skill!.effects.some((e) => e.type === 'heal' && e.timing === 'per-turn')
    if (perTurn) return f.buffs.some((b) => b.skillId === a.id && b.lastTurn > s.turn + 1) ? 'defend' : a.id
    return s.members.some((x) => x.alive && x.hp / x.maxHp < HEAL_THRESHOLD) ? a.id : 'defend'
  }
  if (a.kind === 'cure') {
    const need = a.special === 'refresh' ? s.members.some((x) => x.alive && x.ailment) : a.special === 'arm-recovery' ? f.binds.arm !== undefined : s.members.some((x) => x.id === a.targetId && x.alive && Object.keys(x.binds).length > 0)
    return need ? a.id : 'defend'
  }
  if (a.kind === 'buff' || a.kind === 'debuff') {
    const holder = a.targetId ? s.members.find((x) => x.id === a.targetId) : f
    const list = a.kind === 'debuff' ? s.enemy.debuffs : (holder?.buffs ?? f.buffs)
    const on = list.find((b) => b.skillId === a.id)
    return on && on.lastTurn > s.turn + 1 ? 'defend' : a.id
  }
  return a.id
}

/** B9 の行動のしかたの初期値：回復スキルがあれば最後に覚える回復（たいてい最も効く）、フロントガードがあれば使う、それ以外は防御 */
export function defaultPolicy(m: Member): string {
  const acts = memberActions(m)
  const heal = acts.filter((a) => a.kind === 'heal' && !a.skill!.effects.some((e) => e.type === 'heal' && e.timing === 'per-turn')).at(-1)
  if (heal) return heal.id
  if (acts.some((a) => a.id === 'paladin-front-guard')) return 'paladin-front-guard'
  return 'defend'
}

export interface EnduranceResult {
  trials: number
  seed: number
  turns: number
  /** n ターン目の終わりまでに全滅した確率 */
  wipeBy: number[]
  members: {
    id: string
    name: string
    /** 最後まで生き残った確率 */
    survive: number
    /** 倒れるまでのターン数の平均（最後まで生き残った回は turns として数える） */
    meanTurns: number
    /** n ターン目の終わりに生きている確率 */
    aliveBy: number[]
  }[]
}

/** 敵の行動に何ターン耐えるか（B9）。policies：メンバー ID → 行動 ID */
export function simulateEndurance(setup: BattleSetup, policies: Record<string, string>, turns: number, trials: number, seed: number, onProgress?: Progress): EnduranceResult {
  const ctx = new SimContext(setup)
  const rng: Rng = seededRng(seed)
  const start = initialState(setup)
  const wipes = new Array<number>(turns).fill(0)
  const alive = setup.members.map(() => new Array<number>(turns).fill(0))
  const sumTurns = setup.members.map(() => 0)
  for (let i = 0; i < trials; i++) {
    let s = start
    let wiped = false
    for (let t = 1; t <= turns; t++) {
      const plan = Object.fromEntries(s.members.filter((f) => f.alive).map((f) => [f.id, policyAction(ctx, s, f, policies[f.id] ?? 'defend')]))
      s = runTurn(ctx, s, { rng, plan, fallback: 'defend', log: false, endless: true }).state
      s.members.forEach((f, k) => {
        if (f.alive) alive[k][t - 1] += 1
      })
      if (!wiped && s.members.every((f) => !f.alive)) {
        wiped = true
        wipes[t - 1] += 1
      }
    }
    s.members.forEach((f, k) => (sumTurns[k] += f.downTurn ?? turns))
    if (onProgress && (i + 1) % PROGRESS_EVERY === 0) onProgress(i + 1, trials)
  }
  const wipeBy: number[] = []
  let c = 0
  for (const w of wipes) wipeBy.push((c += w) / trials)
  return {
    trials,
    seed,
    turns,
    wipeBy,
    members: setup.members.map((m, k) => ({
      id: m.id,
      name: m.name,
      survive: alive[k][turns - 1] / trials,
      meanTurns: sumTurns[k] / trials,
      aliveBy: alive[k].map((n) => n / trials),
    })),
  }
}

/** 乱数で1回だけ戦ったときの記録（B9 の様子を見る） */
export function sampleEndurance(setup: BattleSetup, policies: Record<string, string>, turns: number, seed: number): TurnLog[] {
  const ctx = new SimContext(setup)
  const rng = seededRng(seed)
  let s = initialState(setup)
  const logs: TurnLog[] = []
  for (let t = 1; t <= turns && s.members.some((f) => f.alive); t++) {
    const plan = Object.fromEntries(s.members.filter((f) => f.alive).map((f) => [f.id, policyAction(ctx, s, f, policies[f.id] ?? 'defend')]))
    const r = runTurn(ctx, s, { rng, plan, fallback: 'defend', log: true, endless: true })
    s = r.state
    logs.push(r.log!)
  }
  return logs
}
