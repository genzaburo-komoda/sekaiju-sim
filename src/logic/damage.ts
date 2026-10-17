// ダメージ計算エンジン（仕様書 5.1・5.2・5.3・5.7）と計算根拠（仕様書 B4）。
// 画面から切り離した純粋な関数。入力をすべて引数で受け取り、ダメージの分布と「どう計算したか」の手順を返す。
//
// 乱数は「取りうる値を全部数え上げる」方式で扱う（1回の攻撃で乱数は2つ・数十通りしかないため）。
// これで最小・最大・期待値が近似なしで出る。
//
// 未確定の点（仕様書 5.5）：各段階の端数処理、レベル差補正と難易度補正の順番。
// 当面は「基礎ダメージで切り捨て → 乱数 → BOOST → レベル差補正で切り捨て → 難易度補正で切り捨て」とし、
// 手順ごとに確度ラベルを付けて画面に出す。実測（ステップ2-2・2-3）で確定させる。
import type { z } from 'zod'
import type { Confidence, Element, FormulaSet } from '../data/schema'

export type ConfidenceId = z.infer<typeof Confidence>
export type ElementId = z.infer<typeof Element>

/** 攻撃の計算方法。str=物理、tec=術式、hybrid=物理＋属性（属性付きの武器での通常攻撃など） */
export type AttackKind = 'str' | 'tec' | 'hybrid'

export interface AttackInput {
  kind: AttackKind
  /** 攻撃側 */
  attacker: {
    level: number
    /** STR（装備・引退込み。ATKブースト前） */
    str: number
    tec: number
    /** ATKブーストの倍率（%）。無しは 100 */
    atkBoostRate: number
    /** 武器の攻撃力（素手は 0） */
    weaponAtk: number
    /** 武器マスタリーの倍率（%）。無しは 100 */
    masteryRate: number
    /** 後列から攻撃するか（弓以外は攻撃値が半分） */
    backRow: boolean
    /** 弓で攻撃するか（後列でも攻撃値が減らない） */
    bow: boolean
  }
  /** スキルのダメージ倍率（%）。通常攻撃は 100 */
  power: number
  /** 属性部分のダメージ倍率（%、hybrid のとき）。属性付き通常攻撃は 100 */
  elemPower?: number
  /** 対象の属性倍率（%）。100 が等倍 */
  vuln: number
  /** 属性部分の属性倍率（%、hybrid のとき） */
  elemVuln?: number
  /** 攻撃強化の倍率（%）。ウォークライなどを掛け合わせた値。無しは 100 */
  atkBuffRate: number
  /** 防御側 */
  defender: {
    level: number
    vit: number
    /** 防具の防御力（敵は 0） */
    armorDef: number
    /** 防御強化の倍率（%）。無しは 100 */
    defBuffRate: number
  }
  /** クリティカル（DEF を 0 として計算） */
  critical: boolean
  /** BOOST した通常攻撃（×2） */
  boostedNormal: boolean
  /** 対象が防御中（×0.7） */
  guarding: boolean
  /** 式セット（レベル差補正の表と難易度補正） */
  formulas: FormulaSet
  difficulty: 'expert' | 'basic' | 'picnic'
}

/** 計算根拠の1行（仕様書 B4） */
export interface Step {
  label: string
  /** 式（値を代入したもの） */
  formula: string
  /** この段階の結果。乱数が入った後は範囲で出す */
  value: string
  confidence: ConfidenceId
  note?: string
}

export interface DamageResult {
  min: number
  max: number
  /** 期待値（乱数がすべて等確率として） */
  expected: number
  /** ダメージ → 確率 */
  distribution: Map<number, number>
  steps: Step[]
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
const pct = (n: number) => `${fmt(n)}%`
const range = (a: number, b: number) => (a === b ? String(a) : `${a}〜${b}`)
const intRange = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

/** 確率分布の変換：各値に関数をかけ、同じ値になったものをまとめる */
function mapDist(dist: Map<number, number>, f: (v: number) => number): Map<number, number> {
  const out = new Map<number, number>()
  for (const [v, p] of dist) {
    const w = f(v)
    out.set(w, (out.get(w) ?? 0) + p)
  }
  return out
}

/** 確率分布の変換：各値から等確率の複数の値に分かれる */
function spreadDist(dist: Map<number, number>, f: (v: number) => number[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const [v, p] of dist) {
    const ws = f(v)
    for (const w of ws) out.set(w, (out.get(w) ?? 0) + p / ws.length)
  }
  return out
}

function distRange(dist: Map<number, number>): [number, number] {
  const vs = [...dist.keys()]
  return [Math.min(...vs), Math.max(...vs)]
}

/** レベル差補正（%）。表は −20〜+20 で、外側は端の値 */
export function levelCorrection(formulas: FormulaSet, attackerLevel: number, defenderLevel: number): { diff: number; rate: number } {
  const diff = attackerLevel - defenderLevel
  const clamped = Math.max(-20, Math.min(20, diff))
  const row = formulas.levelCorrection.find((r) => r.levelDiff === clamped)!
  return { diff, rate: row.playerDealt }
}

/** 味方の攻撃のダメージ */
export function calcDamage(input: AttackInput): DamageResult {
  const { attacker: a, defender: d } = input
  const steps: Step[] = []
  const physical = input.kind !== 'tec'

  // ---- 1. 攻撃値 ATK ----
  // ATKブーストは攻撃するときの STR にかかる（ステータス画面の STR には出ない。ソードマン Lv66 で確認）
  const str = Math.floor((a.str * a.atkBoostRate) / 100)
  if (a.atkBoostRate !== 100) {
    steps.push({ label: '攻撃時の STR', formula: `STR ${a.str} × ATKブースト ${pct(a.atkBoostRate)}（切り捨て）`, value: String(str), confidence: 'estimated', note: '倍率は資料の値。端数処理は未確認' })
  }
  const weapon = (a.weaponAtk * a.masteryRate) / 100
  const buff = input.atkBuffRate / 100
  let atk: number
  if (input.kind === 'str') {
    atk = (str + weapon) * (input.power / 100) * (input.vuln / 100) * buff
    steps.push({
      label: '攻撃値 ATK（物理）',
      formula: `(STR ${str} + 武器 ${a.weaponAtk} × マスタリー ${pct(a.masteryRate)}) × 倍率 ${pct(input.power)} × 属性倍率 ${pct(input.vuln)} × 攻撃強化 ${pct(input.atkBuffRate)}`,
      value: fmt(atk),
      confidence: 'estimated',
      note: 'EO Wiki の式（DS版）。'+'実測33発と一致（2026-10-12）。スキル倍率・マスタリー・ATKブーストは一部のみ確認',
    })
  } else if (input.kind === 'tec') {
    atk = (2 * a.tec + weapon) * (input.power / 100) * (input.vuln / 100) * buff
    steps.push({
      label: '攻撃値 ATK（術式）',
      formula: `(2 × TEC ${a.tec} + 術式攻撃力 ${fmt(weapon)}) × 倍率 ${pct(input.power)} × 属性倍率 ${pct(input.vuln)} × 攻撃強化 ${pct(input.atkBuffRate)}`,
      value: fmt(atk),
      confidence: 'unverified',
      note: 'EO Wiki の式（DS版）',
    })
  } else {
    const phys = (str + weapon) * (input.power / 100) * (input.vuln / 100) * buff
    const elem = (a.tec + weapon) * ((input.elemPower ?? 100) / 100) * ((input.elemVuln ?? 100) / 100)
    atk = phys + elem
    steps.push({
      label: '攻撃値 ATK（物理＋属性）',
      formula:
        `物理 (STR ${str} + 武器 ${fmt(weapon)}) × ${pct(input.power)} × ${pct(input.vuln)} × ${pct(input.atkBuffRate)} = ${fmt(phys)}` +
        ` ＋ 属性 (TEC ${a.tec} + 武器 ${fmt(weapon)}) × ${pct(input.elemPower ?? 100)} × ${pct(input.elemVuln ?? 100)} = ${fmt(elem)}`,
      value: fmt(atk),
      confidence: 'unverified',
      note: 'EO Wiki の複合属性の式。属性付き武器の通常攻撃にこの式が使われるかは未確認',
    })
  }

  // 後列から弓以外で攻撃すると、攻撃値（STR＋武器）全体が半分。
  // 2026-10-12 の実測（杖・鞭の後列攻撃9発）で、STR だけ半分では予測の約2倍になり、全体を半分にすると全て範囲内だった
  if (physical && a.backRow && !a.bow) {
    const half = atk / 2
    steps.push({ label: '後列からの攻撃', formula: `ATK ${fmt(atk)} ÷ 2（弓以外）`, value: fmt(half), confidence: 'estimated', note: '実測から推定（2026-10-12）。物理＋属性の攻撃でも全体が半分かは未確認' })
    atk = half
  }

  // ---- 2. 防御値 DEF ----
  const defCoef = physical ? 0.5 : 0.25
  let def = defCoef * (d.vit + d.armorDef) * (d.defBuffRate / 100)
  steps.push({
    label: '防御値 DEF',
    formula: `${defCoef} × (VIT ${d.vit} + 防具 ${d.armorDef}) × 防御強化 ${pct(d.defBuffRate)}`,
    value: fmt(def),
    confidence: 'estimated',
    note: '敵は防具なし（VIT だけ）。物理は実測33発と一致（2026-10-12）',
  })
  if (input.critical) {
    def = 0
    steps.push({ label: 'クリティカル', formula: '防御値を 0 にする', value: '0', confidence: 'estimated', note: '実測4発と一致（2026-10-12）' })
  }

  // ---- 3. 基礎ダメージ（3通りの分岐） ----
  const varRange: [number, number] = physical ? [8, 12] : [8, 15]
  const addRange: [number, number] = physical ? [0, 5] : [0, 10]
  const spread = physical ? 5 : 10
  let dist: Map<number, number>
  let fixed = false
  if (def >= atk) {
    dist = spreadDist(new Map([[0, 1]]), () => intRange(1, 5))
    fixed = true
    steps.push({ label: '基礎ダメージ', formula: `DEF ${fmt(def)} ≧ ATK ${fmt(atk)} なので 1〜5 のランダム（以降の補正なし）`, value: '1〜5', confidence: 'unverified' })
  } else if (atk < def * 1.1) {
    dist = spreadDist(new Map([[0, 1]]), () => intRange(varRange[0], varRange[1]).map((v) => Math.floor((atk / 100) * v)))
    const [lo, hi] = distRange(dist)
    steps.push({
      label: '基礎ダメージ',
      formula: `ATK ${fmt(atk)} < DEF ${fmt(def)} × 1.1 なので ATK ÷ 100 × 乱数 ${varRange[0]}〜${varRange[1]}（切り捨て）`,
      value: range(lo, hi),
      confidence: 'unverified',
    })
  } else {
    const base = Math.floor(atk - def)
    dist = new Map([[base, 1]])
    steps.push({ label: '基礎ダメージ', formula: `ATK ${fmt(atk)} − DEF ${fmt(def)}（切り捨て）`, value: String(base), confidence: 'estimated', note: '実測33発と一致（2026-10-12）' })
  }

  if (!fixed) {
    // ---- 4. 乱数の加算 ----
    dist = spreadDist(dist, (v) =>
      v <= 100
        ? intRange(addRange[0], addRange[1]).map((k) => v + k)
        : intRange(-spread, spread).map((k) => Math.ceil((v * (100 + k)) / 100)),
    )
    const [lo, hi] = distRange(dist)
    steps.push({
      label: '乱数',
      formula: `100 以下なら +${addRange[0]}〜${addRange[1]}、100 超なら ±${spread}%（切り上げ）`,
      value: range(lo, hi),
      confidence: 'estimated',
      note: '幅は実測33発と一致（2026-10-12）。±% は 1% 刻みの等確率と仮定',
    })

    // ---- 5. BOOST・防御 ----
    if (input.boostedNormal) {
      dist = mapDist(dist, (v) => v * 2)
      const [l2, h2] = distRange(dist)
      steps.push({ label: 'BOOST（通常攻撃）', formula: '× 2', value: range(l2, h2), confidence: 'unverified' })
    }
    if (input.guarding) {
      dist = mapDist(dist, (v) => Math.floor(v * 0.7))
      const [l2, h2] = distRange(dist)
      steps.push({ label: '対象が防御中', formula: '× 0.7（切り捨て）', value: range(l2, h2), confidence: 'unverified' })
    }

    // ---- 6. レベル差補正 ----
    const lc = levelCorrection(input.formulas, a.level, d.level)
    dist = mapDist(dist, (v) => Math.floor((v * lc.rate) / 100))
    {
      const [l2, h2] = distRange(dist)
      steps.push({
        label: 'レベル差補正',
        formula: `レベル差 ${lc.diff >= 0 ? '+' : ''}${lc.diff}（Lv${a.level} − Lv${d.level}）→ × ${pct(lc.rate)}（切り捨て）`,
        value: range(l2, h2),
        confidence: 'estimated',
        note: 'DS版のゲームデータの表。レベル差 −10〜+11 の範囲で実測と一致（2026-10-12）',
      })
    }

    // ---- 7. 難易度補正 ----
    const diffRate = input.formulas.difficulty[input.difficulty].damageDealt
    if (diffRate !== 100) {
      dist = mapDist(dist, (v) => Math.floor((v * diffRate) / 100))
      const [l2, h2] = distRange(dist)
      steps.push({ label: '難易度補正', formula: `与ダメージ × ${pct(diffRate)}（切り捨て）`, value: range(l2, h2), confidence: 'unverified', note: 'かける位置と順番は未確認' })
    }
  }

  // ダメージは最低 1
  dist = mapDist(dist, (v) => Math.max(1, v))
  const [min, max] = distRange(dist)
  let expected = 0
  for (const [v, p] of dist) expected += v * p
  return { min, max, expected, distribution: dist, steps }
}
