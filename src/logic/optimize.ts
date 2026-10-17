// 最大ダメージの最適化（仕様書 C2・B1）。
// 「このメンバーが、この敵に、1ターンで与えるダメージの期待値」が最大になるスキルの振り方と行動を探す。
//
// 探し方：ダメージに効くスキル（攻撃スキル・ATKブースト・装備中の武器のマスタリー・ダブルアタック・自己強化）の
// レベルの組み合わせを全部試す。前提スキルは自動で取り（A3 と同じ手順）、SP が足りない組み合わせは捨てる。
// ソードマンでは1つの攻撃につき数千通りなので、全部試しても一瞬で終わる（ジョブが増えて重くなったら仕様書 6.1 の動的計画法に切り替える）。
//
// 前提と割り切り（画面にも出す）：
// - 命中率は入れない（味方の基礎命中が分かっていないため。命中した場合の期待値）
// - 通常攻撃はクリティカル（5%）とダブルアタックの追加の一撃を期待値に入れる
// - 自己強化（ウォークライなど）は「事前にかけてある」場合だけ選べる。かけるターンは攻撃できないため
// - チェイス系（味方の属性攻撃に追撃）は味方の行動しだいなので対象外
import { findEnemy, findEquipment, formulas, rules, skillsByJob } from '../data/gameData'
import type { Skill } from '../data/schema'
import { attackOptions, buildAttackInput, selfBuffOptions, skillValues } from './attack'
import { calcDamage, type AttackInput, type DamageResult } from './damage'
import type { DifficultyId, Member } from './party'
import { memberStats, targetFromEnemy, type TargetSettings } from './predict'
import { retireSpBonus } from './retire'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'

/** 味方のクリティカル率（仕様書 5.4） */
const CRIT_RATE = 0.05

export interface OptimizeOptions {
  /** 敵の数（トルネードの左右・ハヤブサ駆けに使う） */
  enemyCount: number
  /** 自己強化を事前にかけてある前提で評価するか */
  preBuffed: boolean
}

export interface Candidate {
  /** 攻撃（'normal' かスキル ID） */
  attackId: string
  attackName: string
  /** 使う自己強化（'' は無し） */
  buffId: string
  /** スキルの振り方（ダメージに関係するスキルと、その前提スキルだけ） */
  alloc: Allocation
  spUsed: number
  /** 1ターンの総ダメージの期待値 */
  expected: number
  /** 1回の攻撃（1体分）の最小・最大 */
  hitMin: number
  hitMax: number
  /** 期待値の内訳の説明 */
  breakdown: string
}

/** 0〜max の整数 */
const levels = (max: number) => Array.from({ length: max + 1 }, (_, i) => i)

/**
 * 変数（スキルとレベルの候補）を順に決めながら振っていき（前提スキルは自動で取る）、全組み合わせを visit に渡す。
 * レベルは小さい順に試すので、SP が足りなくなったらそれより上のレベルは試さない（SP は増える一方のため）
 */
function search(
  skills: Skill[],
  vars: { skillId: string; choices: number[] }[],
  total: number,
  visit: (alloc: Allocation) => void,
  i = 0,
  alloc: Allocation = {},
) {
  if (i === vars.length) {
    visit(alloc)
    return
  }
  const { skillId, choices } = vars[i]
  for (const lv of choices) {
    const next = lv > 0 ? setSkillLevel(skills, alloc, skillId, Math.max(lv, alloc[skillId] ?? 0)) : alloc
    if (spUsed(next) > total) break
    search(skills, vars, total, visit, i + 1, next)
  }
}

/** 同じ入力のダメージ計算を何度もしないための覚え書き */
function cachedCalc() {
  const cache = new Map<string, DamageResult>()
  return (input: AttackInput): DamageResult => {
    const { formulas: _formulas, ...rest } = input
    const key = JSON.stringify(rest)
    let r = cache.get(key)
    if (!r) {
      r = calcDamage(input)
      cache.set(key, r)
    }
    return r
  }
}

export function optimizeMaxDamage(member: Member, target: TargetSettings, difficulty: DifficultyId, opts: OptimizeOptions): Candidate[] {
  const skills = skillsByJob[member.jobId] ?? []
  const weapon = findEquipment(member.weaponId)
  const total = spTotal(rules, member.level, retireSpBonus(rules, member.retire))
  const enemy = findEnemy(target.enemyId)
  const spec = enemy ? targetFromEnemy(enemy, target.guarding) : target
  const byId = new Map(skills.map((s) => [s.id, s]))

  // ダメージに効くパッシブ
  const passiveVars = skills.filter((s) =>
    s.effects.some(
      (e) => e.type === 'passive-stat' && (e.stat === 'str' || (e.stat === 'weaponAtk' && weapon?.weaponType !== undefined && e.weapon === weapon.weaponType)),
    ),
  )
  const doubleAttack = skills.filter((s) => s.effects.some((e) => e.type === 'passive-proc' && e.trigger === 'normal-attack'))
  // 自己強化の候補（全スキルを振った状態で調べる）
  const allMax = Object.fromEntries(skills.map((s) => [s.id, s.maxLevel]))
  const buffSkills = opts.preBuffed ? selfBuffOptions(skills, allMax).map((b) => byId.get(b.id)!) : []

  // 攻撃の候補（武器で使えるもの）
  // 構えが必要なスキル（ブシドー）は「前のターンに済ませてある」を選んだときだけ
  const attacks = attackOptions(skills, allMax, weapon).filter((o) => o.unusable === null && (!o.skill?.stance || opts.preBuffed))

  const best = new Map<string, Candidate>()
  const calc = cachedCalc()
  for (const attack of attacks) {
    const attackVars = attack.skill ? [{ skillId: attack.skill.id, choices: levels(attack.skill.maxLevel).slice(1) }] : doubleAttack.map((s) => ({ skillId: s.id, choices: levels(s.maxLevel) }))
    const buffChoices: { id: string; skill: Skill | null }[] = [{ id: '', skill: null }, ...buffSkills.map((s) => ({ id: s.id, skill: s }))]
    for (const buff of buffChoices) {
      const vars = [
        ...attackVars,
        ...passiveVars.map((s) => ({ skillId: s.id, choices: levels(s.maxLevel) })),
        ...(buff.skill ? [{ skillId: buff.skill.id, choices: levels(buff.skill.maxLevel).slice(1) }] : []),
      ]
      const key = `${attack.id}|${buff.id}`
      // どのスキルもレベルを上げてダメージが下がることはないので、
      // 「まだどれかを1つ上げられる（SP が余る）」組み合わせは最善になり得ない。上げきった組み合わせだけ評価する
      const raisable = (alloc: Allocation) =>
        vars.some(({ skillId, choices }) => {
          const next = choices.find((lv) => lv > (alloc[skillId] ?? 0))
          return next !== undefined && spUsed(setSkillLevel(skills, alloc, skillId, next)) <= total
        })
      search(skills, vars, total, (alloc) => {
        if (raisable(alloc)) return
        const c = evaluate(member, alloc, attack.id, buff.id, spec, difficulty, opts, skills, calc)
        if (!c) return
        const prev = best.get(key)
        if (!prev || c.expected > prev.expected + 1e-9) best.set(key, { ...c, spUsed: spUsed(alloc) })
      })
      // 最善の振り方から、下げても期待値が変わらないレベルを下げて、使う SP をできるだけ減らす
      const found = best.get(key)
      if (found) best.set(key, trim(found, vars, (alloc) => evaluate(member, alloc, attack.id, buff.id, spec, difficulty, opts, skills, calc), skills))
    }
  }
  // 攻撃ごとの最良を、期待値の大きい順に（同じなら SP の少ない順）
  return [...best.values()].sort((a, b) => b.expected - a.expected || a.spUsed - b.spUsed)
}

/**
 * 今の振り方のままで出せる、1ターンの総ダメージの期待値の最大（採点 C5 の「今の値」）。
 * 最適化と同じ評価を、振り方を変えずに使える攻撃すべてで行う（自己強化・構えは使わない）
 */
export function currentMaxDamage(member: Member, target: TargetSettings, difficulty: DifficultyId, opts: OptimizeOptions): Omit<Candidate, 'spUsed'> | null {
  const skills = skillsByJob[member.jobId] ?? []
  const enemy = findEnemy(target.enemyId)
  const spec = enemy ? targetFromEnemy(enemy, target.guarding) : target
  const calc = cachedCalc()
  let best: Omit<Candidate, 'spUsed'> | null = null
  for (const o of attackOptions(skills, member.skills, findEquipment(member.weaponId))) {
    if (o.unusable !== null || (o.skill?.stance && !opts.preBuffed)) continue
    const c = evaluate(member, member.skills, o.id, '', spec, difficulty, opts, skills, calc)
    if (c && (!best || c.expected > best.expected)) best = c
  }
  return best
}

/** 期待値を変えずに下げられるレベルを1つずつ下げていく */
function trim(
  c: Candidate,
  vars: { skillId: string; choices: number[] }[],
  score: (alloc: Allocation) => Omit<Candidate, 'spUsed'> | null,
  skills: Skill[],
): Candidate {
  let cur = c
  for (let changed = true; changed; ) {
    changed = false
    for (const { skillId, choices } of vars) {
      const lv = cur.alloc[skillId] ?? 0
      const lower = [...choices].reverse().find((x) => x < lv)
      if (lower === undefined) continue
      const alloc = setSkillLevel(skills, cur.alloc, skillId, lower)
      const r = score(alloc)
      if (r && Math.abs(r.expected - cur.expected) < 1e-9) {
        cur = { ...r, spUsed: spUsed(alloc) }
        changed = true
      }
    }
  }
  return cur
}

/** 1つの振り方・行動の評価 */
function evaluate(
  member: Member,
  alloc: Allocation,
  attackId: string,
  buffId: string,
  target: TargetSettings,
  difficulty: DifficultyId,
  opts: OptimizeOptions,
  skills: Skill[],
  calcDamage: (input: AttackInput) => DamageResult,
): Omit<Candidate, 'spUsed'> | null {
  const m: Member = { ...member, skills: alloc }
  const weapon = findEquipment(m.weaponId)
  const option = attackOptions(skills, alloc, weapon).find((o) => o.id === attackId)
  if (!option) return null
  const buff = selfBuffOptions(skills, alloc).find((b) => b.id === buffId)
  const base = {
    level: m.level,
    stats: memberStats(m),
    row: m.row,
    skills,
    alloc,
    weapon,
    option,
    atkBuffRate: buff?.rate ?? 100,
    target,
    formulas,
    difficulty,
  }
  const normal = buildAttackInput({ ...base, boosted: false, critical: false })
  if (!normal) return null
  const hit = calcDamage(normal.input)
  const buffText = buff ? `（${buff.name} Lv${buff.level} をかけた状態）` : ''

  if (!option.skill) {
    // 通常攻撃：クリティカル 5%、ダブルアタックで追加の一撃
    const crit = calcDamage({ ...normal.input, critical: true })
    const perHit = (1 - CRIT_RATE) * hit.expected + CRIT_RATE * crit.expected
    const da = doubleAttackChance(skills, alloc)
    return {
      attackId,
      attackName: '通常攻撃',
      buffId,
      alloc,
      expected: perHit * (1 + da),
      hitMin: hit.min,
      hitMax: hit.max,
      breakdown: `1回 ${perHit.toFixed(1)}（クリティカル5%込み）${da > 0 ? ` × (1 + ダブルアタック ${Math.round(da * 100)}%)` : ''}${buffText}`,
    }
  }

  const effect = option.skill.effects.find((e) => e.type === 'damage')
  const values = skillValues(option.skill, option.level, false)
  if (!effect || effect.type !== 'damage' || !values) return null
  const name = `${option.skill.name} Lv${option.level}`
  // 攻撃回数：固定・レベル別・範囲（範囲は最小〜最大の等確率と仮定。同じ敵に何度も当たり得る）
  const hitsFixed =
    effect.minHitsParam && effect.maxHitsParam
      ? (values[effect.minHitsParam] + values[effect.maxHitsParam]) / 2
      : (effect.hits ?? (effect.hitsParam ? values[effect.hitsParam] : 1))

  if (effect.target === 'enemy-single-splash' && effect.splashPowerParam) {
    // 正面の1体＋左右（敵の数に応じて最大2体）
    const side = calcDamage({ ...normal.input, power: values[effect.splashPowerParam] })
    const sides = Math.min(2, Math.max(0, opts.enemyCount - 1))
    return {
      attackId, attackName: name, buffId, alloc,
      expected: (hit.expected + side.expected * sides) * hitsFixed,
      hitMin: hit.min, hitMax: hit.max,
      breakdown: `正面 ${hit.expected.toFixed(1)}${sides > 0 ? ` ＋ 左右 ${side.expected.toFixed(1)} × ${sides}体` : ''}${buffText}`,
    }
  }
  if (effect.target === 'enemy-random' && effect.minTargetsParam && effect.maxTargetsParam) {
    // 対象数は最小〜最大の等確率と仮定（atwiki「Lv3で3体攻撃率50%」と合う）。
    // 同じ敵に2回当たらない（atwiki「敵が1体の場合でも単体に複数回ヒットはしない」）ので、敵の数で頭打ち
    const lo = values[effect.minTargetsParam]
    const hi = values[effect.maxTargetsParam]
    let n = 0
    for (let k = lo; k <= hi; k++) n += Math.min(k, opts.enemyCount) / (hi - lo + 1)
    return {
      attackId, attackName: name, buffId, alloc,
      expected: hit.expected * n,
      hitMin: hit.min, hitMax: hit.max,
      breakdown: `1体 ${hit.expected.toFixed(1)} × 平均 ${n.toFixed(2).replace(/\.?0+$/, '')} 体（対象 ${lo}〜${hi} 体、敵 ${opts.enemyCount} 体。同じ敵には1回だけ）${buffText}`,
    }
  }
  // 全体攻撃・列攻撃は敵の数だけ当たる（初代の敵は1列に並ぶので、列攻撃も全員に当たるとみなす）
  const targets = effect.target === 'enemy-all' || effect.target === 'enemy-row' ? opts.enemyCount : 1
  return {
    attackId, attackName: name, buffId, alloc,
    expected: hit.expected * hitsFixed * targets,
    hitMin: hit.min, hitMax: hit.max,
    breakdown:
      `1回 ${hit.expected.toFixed(1)}${hitsFixed > 1 ? ` × ${effect.minHitsParam ? '平均 ' : ''}${hitsFixed} 回` : ''}` +
      `${targets > 1 ? ` × 敵 ${targets} 体` : ''}${buffText}`,
  }
}

/** ダブルアタックの発動率（0〜1） */
function doubleAttackChance(skills: Skill[], alloc: Allocation): number {
  let p = 0
  for (const s of skills) {
    const lv = alloc[s.id] ?? 0
    if (lv === 0 || !s.levels) continue
    for (const e of s.effects) if (e.type === 'passive-proc' && e.trigger === 'normal-attack') p = Math.max(p, s.levels[lv - 1].values[e.chanceParam] / 100)
  }
  return p
}

/** パーティ全員の最大の和（バフの相乗はまだ考えない） */
export function optimizePartyMaxDamage(members: Member[], target: TargetSettings, difficulty: DifficultyId, opts: OptimizeOptions) {
  const perMember = members.map((m) => ({ member: m, best: optimizeMaxDamage(m, target, difficulty, opts)[0] ?? null }))
  return { perMember, total: perMember.reduce((sum, x) => sum + (x.best?.expected ?? 0), 0) }
}
