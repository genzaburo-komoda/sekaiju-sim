// 実測記録（仕様書 B5）。
// ゲーム内で実際に出たダメージを、そのときの条件（メンバー・攻撃・敵・難易度）と一緒に記録し、
// 今の計算式の予測範囲に入っているかを比べる。記録はこのブラウザに保存し、JSON で書き出し・読み込みできる。
import { z } from 'zod'
import { Difficulty } from '../data/schema'
import type { Member } from './party'
import { predict, type AttackSettings, type Prediction, type TargetSettings } from './predict'

const Vuln = z.object({ slash: z.number(), bash: z.number(), pierce: z.number(), fire: z.number(), ice: z.number(), volt: z.number() })

/** 記録1件（読み込むときの検査にも使う） */
export const MeasurementSchema = z.object({
  id: z.string(),
  /** 記録した日時（ISO 形式） */
  createdAt: z.string(),
  /** ゲームのバージョン（タイトル画面などの表記） */
  gameVersion: z.string().max(40),
  difficulty: Difficulty,
  member: z.object({
    id: z.string(),
    name: z.string(),
    jobId: z.string(),
    level: z.number().int(),
    row: z.enum(['front', 'back']),
    skills: z.record(z.string(), z.number().int()),
    retire: z.object({ level: z.number().int(), jobId: z.string() }).nullable(),
    weaponId: z.string().nullable(),
    armorIds: z.array(z.string().nullable()).optional(),
  }),
  attack: z.object({
    attackId: z.string(),
    boosted: z.boolean(),
    critical: z.boolean(),
    buffId: z.string(),
    otherBuff: z.number(),
  }),
  target: z.object({
    enemyId: z.string().nullable(),
    level: z.number().int(),
    vit: z.number(),
    vuln: Vuln,
    guarding: z.boolean(),
  }),
  /** 実際に出たダメージ（1回の攻撃ごとに1つ） */
  values: z.array(z.number().int().nonnegative()).min(1),
  note: z.string().max(200),
})
export type Measurement = z.infer<typeof MeasurementSchema>

const ExportFile = z.object({
  format: z.literal('sekaiju-sim-measurements'),
  version: z.literal(1),
  records: z.array(MeasurementSchema),
})

/** 「123 130、127」のような入力を数の配列にする。数でないものがあれば null */
export function parseValues(text: string): number[] | null {
  const parts = text.split(/[\s,、，]+/).filter(Boolean)
  if (parts.length === 0) return null
  const nums = parts.map((p) => Number(p.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  return nums
}

let serial = 0
export function newMeasurement(
  member: Member,
  attack: AttackSettings,
  target: TargetSettings,
  difficulty: Measurement['difficulty'],
  values: number[],
  gameVersion: string,
  note: string,
): Measurement {
  serial += 1
  return {
    id: `r${Date.now().toString(36)}${serial}`,
    createdAt: new Date().toISOString(),
    gameVersion,
    difficulty,
    member: structuredClone(member),
    attack: { ...attack },
    target: structuredClone(target),
    values,
    note,
  }
}

/** 記録と予測の比較 */
export interface Comparison {
  prediction: Prediction
  /** 予測範囲に入った値の数 */
  inRange: number
  /** 範囲外の値 */
  outside: number[]
}

export function compare(record: Measurement): Comparison {
  let prediction: Prediction
  try {
    prediction = predict(record.member, record.attack, record.target, record.difficulty)
  } catch {
    // 読み込んだ記録のジョブが今のデータに無いときなど
    prediction = { attackName: record.attack.attackId, element: 'bash', result: null }
  }
  const r = prediction.result
  if (!r) return { prediction, inRange: 0, outside: [...record.values] }
  const outside = record.values.filter((v) => v < r.min || v > r.max)
  return { prediction, inRange: record.values.length - outside.length, outside }
}

/** 全記録のまとめ */
export function summarize(records: Measurement[]) {
  let values = 0
  let inRange = 0
  let recordsWithOutliers = 0
  for (const rec of records) {
    const c = compare(rec)
    values += rec.values.length
    inRange += c.inRange
    if (c.outside.length > 0) recordsWithOutliers += 1
  }
  return { records: records.length, values, inRange, recordsWithOutliers }
}

// ---- 保存（このブラウザ） ----
const KEY = 'sekaiju-sim:measurements'

export function loadMeasurements(): Measurement[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const r = z.array(MeasurementSchema).safeParse(JSON.parse(raw))
    return r.success ? r.data : []
  } catch {
    return []
  }
}

/** 保存できたら true */
export function saveMeasurements(records: Measurement[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(records))
    return true
  } catch {
    return false
  }
}

// ---- 書き出し・読み込み（JSON） ----
export function exportMeasurements(records: Measurement[]): string {
  return JSON.stringify({ format: 'sekaiju-sim-measurements', version: 1, records }, null, 2)
}

/** JSON を読み込み、今の記録に足す（同じ ID の記録は足さない） */
export function importMeasurements(text: string, current: Measurement[]): { ok: true; records: Measurement[]; added: number } | { ok: false; error: string } {
  let parsed: z.infer<typeof ExportFile>
  try {
    const r = ExportFile.safeParse(JSON.parse(text))
    if (!r.success) return { ok: false, error: '実測記録の形式ではありません' }
    parsed = r.data
  } catch {
    return { ok: false, error: 'JSON として読めません' }
  }
  const ids = new Set(current.map((r) => r.id))
  const fresh = parsed.records.filter((r) => !ids.has(r.id))
  return { ok: true, records: [...current, ...fresh], added: fresh.length }
}
