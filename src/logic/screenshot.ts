// スクリーンショットからメンバーを設定する（2026-11-01 本人の依頼）：読み取った文字をアプリのデータに当てはめる部分。
// 画像から文字を読む部分（OCR）は ocr.ts。ここは画像を扱わないので、テストで確かめられる。
//
// 使う画面（Steam 版。2026-10-18 のスクリーンショット 59〜62 で位置を測った。1920×1080 の画面を基準にした座標）：
// - ステータス画面：名前・Lv・ジョブ・装備4枠
// - スキル画面（ステータス画面でスペースキー）：左の列 11 行・右の列 10 行。行ごとにスキル名と、レベルの札（★＝マスター、数字、灰色の「-」＝未習得）
// スキルの並びはデータの並びと同じとは限らない（パラディンはフリーズガードとショックガードが逆）ので、名前で当てはめる
import { equipment, findEquipment, findJob, jobs, rules, skillsByJob, weaponsFor } from '../data/gameData'
import type { Equipment } from '../data/schema'
import { armorChoices } from './equip'
import type { Allocation } from './skills'

/** 基準の画面の大きさ（座標はこの大きさの画面の中での位置） */
export const REF_W = 1920
export const REF_H = 1080

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** ステータス画面で読む場所 */
export const STATUS_LAYOUT = {
  // 名前は中央寄せで、長い名前は左の「Q」の札の近くまで広がる（2026-11-01、オースティン・ボードレールで頭の1字が切れたので広げた）
  name: { x: 68, y: 20, w: 332, h: 60 },
  level: { x: 500, y: 40, w: 140, h: 60 },
  job: { x: 140, y: 285, w: 470, h: 70 },
  /** 装備の1〜4枠目（武器・2〜4枠目） */
  equip: [868, 916, 964, 1012].map((cy) => ({ x: 185, y: cy - 22, w: 405, h: 44 })),
} satisfies Record<string, Rect | Rect[]>

/** スキル画面で読む場所：行ごとにスキル名とレベルの札 */
export const SKILL_LAYOUT = {
  job: { x: 130, y: 52, w: 320, h: 50 },
  rows: [
    ...Array.from({ length: 11 }, (_, i) => ({ cy: 154 + 60 * i, nameX: 140, badgeX: 820 })),
    ...Array.from({ length: 10 }, (_, i) => ({ cy: 214 + 60 * i, nameX: 990, badgeX: 1672 })),
  ].map((r) => ({
    name: { x: r.nameX, y: r.cy - 28, w: 640, h: 56 },
    /** 札の左半分（レベルの数字か ★ が出る所） */
    digit: { x: r.badgeX, y: r.cy - 20, w: 46, h: 40 },
    /** 札全体（灰色なら未習得） */
    badge: { x: r.badgeX - 10, y: r.cy - 16, w: 100, h: 32 },
  })),
}

/**
 * 画像の中のゲーム画面の範囲（上下・左右の黒い帯を除き、16:9 に合わせる）。
 * bright(x, y)：その点が黒でないか。帯の検出は外側から、行・列のどこかに黒でない点がある所まで
 */
export function gameArea(width: number, height: number, bright: (x: number, y: number) => boolean): Rect {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200))
  const rowLit = (y: number) => {
    for (let x = 0; x < width; x += step) if (bright(x, y)) return true
    return false
  }
  const colLit = (x: number) => {
    for (let y = 0; y < height; y += step) if (bright(x, y)) return true
    return false
  }
  let top = 0
  while (top < height - 1 && !rowLit(top)) top++
  let bottom = height - 1
  while (bottom > top && !rowLit(bottom)) bottom--
  let left = 0
  while (left < width - 1 && !colLit(left)) left++
  let right = width - 1
  while (right > left && !colLit(right)) right--
  let w = right - left + 1
  let h = bottom - top + 1
  let x = left
  let y = top
  // 16:9 に合わせる（暗い場面で帯の検出がずれても、比率で直す）
  if (w / h > REF_W / REF_H) {
    const nw = Math.round((h * REF_W) / REF_H)
    x += Math.round((w - nw) / 2)
    w = nw
  } else {
    const nh = Math.round((w * REF_H) / REF_W)
    y += Math.round((h - nh) / 2)
    h = nh
  }
  return { x, y, w, h }
}

/** 基準の座標を、画像の中の座標にする */
export function toImageRect(area: Rect, r: Rect): Rect {
  const s = area.w / REF_W
  return { x: area.x + r.x * s, y: area.y + r.y * s, w: r.w * s, h: r.h * s }
}

/** 札の色が灰色（未習得）か。r・g・b は札の平均の色（0〜255） */
export function isGreyBadge(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 || (max - min) / max < 0.2
}

/** 比べるための形にそろえる（全角・半角、空白、長音の似た字、続く長音） */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/[一－—―‐\-ｰ]/g, 'ー')
    .replace(/ー{2,}/g, 'ー')
}

function levenshtein(a: string, b: string): number {
  const A = [...a]
  const B = [...b]
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[B.length]
}

/** 似ている度合い（0〜1。1 が同じ） */
export function similarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  const n = Math.max([...x].length, [...y].length)
  return n === 0 ? 0 : 1 - levenshtein(x, y) / n
}

/** 候補の中で最も似ているもの（threshold 未満なら null） */
export function bestMatch<T>(text: string, items: T[], name: (x: T) => string, threshold: number): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null
  for (const item of items) {
    const score = similarity(text, name(item))
    if (!best || score > best.score) best = { item, score }
  }
  return best && best.score >= threshold ? best : null
}

/** 読み取った文字（OCR の結果） */
export interface StatusText {
  name: string
  level: string
  job: string
  /** 装備の1〜4枠目 */
  equip: string[]
}

export interface SkillRowText {
  name: string
  /** 札の左半分の文字（数字、★ は「*」と読まれることが多い） */
  digit: string
  /** 札が灰色（未習得） */
  grey: boolean
}

export interface SkillText {
  job: string
  rows: SkillRowText[]
}

/** 読み取りの結果：メンバーに当てはめる値と、確かめてほしいこと */
export interface ScreenshotResult {
  name: string | null
  jobId: string | null
  level: number | null
  weaponId: string | null
  armorIds: (string | null)[]
  skills: Allocation
  warnings: string[]
}

/** 枠の縁などが文字として読まれたもの（「|」「_」「!」、行末の数字）を除く */
export function stripNoise(s: string): string {
  return s.normalize('NFKC').replace(/[|_!¦｜]/g, '').replace(/[\s\d]+$/, '').trim()
}

const JOB_THRESHOLD = 0.5
/** これより似ていないときは「〜と読みました」と知らせる */
const EQUIP_NOTICE = 0.8
const EQUIP_THRESHOLD = 0.45
const SKILL_THRESHOLD = 0.4

/** ジョブ：ステータス画面とスキル画面の両方の文字から、最も似ているジョブ */
export function matchJob(status: string, skill: string): { jobId: string | null; warning: string | null } {
  const a = bestMatch(status, jobs, (j) => j.name, JOB_THRESHOLD)
  const b = bestMatch(skill, jobs, (j) => j.name, JOB_THRESHOLD)
  if (a && b && a.item.id !== b.item.id) {
    const pick = a.score >= b.score ? a : b
    return { jobId: pick.item.id, warning: `ジョブがステータス画面（${a.item.name}）とスキル画面（${b.item.name}）で違います。${pick.item.name}にしました。同じメンバーの2枚か確かめてください` }
  }
  const pick = a ?? b
  return pick ? { jobId: pick.item.id, warning: null } : { jobId: null, warning: 'ジョブを読み取れませんでした' }
}

/**
 * 装備：1行目は武器、2〜4行目は防具で、そのまま2〜4枠目にする（2026-11-01 本人確認：防具はどの枠にも付けられ、1種類につき1つ）。
 * 同じ種類の防具が2つ読めたときは、2つ目を空きにして知らせる
 */
export function matchEquipment(texts: string[], jobId: string): { weaponId: string | null; armorIds: (string | null)[]; warnings: string[] } {
  const warnings: string[] = []
  const pick = (text: string, items: Equipment[], label: string): Equipment | null => {
    const clean = stripNoise(text)
    if (!normalize(clean)) return null
    const m = bestMatch(clean, items, (e) => e.name, EQUIP_THRESHOLD)
    if (!m) {
      warnings.push(`${label}「${clean}」に合う装備が見つかりませんでした（空きにしました）`)
      return null
    }
    if (m.score < EQUIP_NOTICE) warnings.push(`${label}「${clean}」を「${m.item.name}」と読みました。合っているか確かめてください`)
    return m.item
  }
  const weapon = pick(texts[0] ?? '', weaponsFor(jobId), '装備の1行目')
  const wearable = armorChoices(0, jobId)
  const armorIds: (string | null)[] = []
  for (let i = 0; i < 3; i++) {
    const e = pick(texts[i + 1] ?? '', wearable, `装備の${i + 2}行目`)
    if (e && armorIds.some((id) => findEquipment(id)?.slot === e.slot)) {
      warnings.push(`装備の${i + 2}行目「${e.name}」は、ほかの行と同じ種類の防具なので空きにしました`)
      armorIds.push(null)
    } else armorIds.push(e?.id ?? null)
  }
  return { weaponId: weapon?.id ?? null, armorIds, warnings }
}

/** スキル：行ごとの名前をそのジョブのスキルに当てはめ（似ている順に1対1）、札からレベルを読む */
export function matchSkills(rows: SkillRowText[], jobId: string): { skills: Allocation; warnings: string[] } {
  const skills = skillsByJob[jobId] ?? []
  const warnings: string[] = []
  // 行とスキルの組を似ている順に並べ、まだ決まっていない行とスキルから順に当てはめる
  const pairs: { row: number; skill: number; score: number }[] = []
  rows.forEach((r, i) => skills.forEach((s, k) => pairs.push({ row: i, skill: k, score: similarity(r.name, s.name) })))
  pairs.sort((a, b) => b.score - a.score)
  const rowSkill = new Map<number, number>()
  const used = new Set<number>()
  for (const p of pairs) {
    if (p.score < SKILL_THRESHOLD || rowSkill.has(p.row) || used.has(p.skill)) continue
    rowSkill.set(p.row, p.skill)
    used.add(p.skill)
  }
  const alloc: Allocation = {}
  rows.forEach((r, i) => {
    const k = rowSkill.get(i)
    if (k === undefined) {
      if (!r.grey) warnings.push(`スキル画面の${i + 1}行目「${r.name.trim()}」がどのスキルか分かりませんでした`)
      return
    }
    const s = skills[k]
    if (r.grey) return
    const d = r.digit.replace(/\s/g, '')
    let level: number | null = null
    if (/[*★☆]/.test(d)) level = s.maxLevel
    else if (/^[1-9]$/.test(d)) level = Number(d)
    if (level === null) {
      warnings.push(`${s.name}のレベル「${d}」を読み取れませんでした（Lv1 にしました）`)
      level = 1
    }
    alloc[s.id] = Math.min(level, s.maxLevel)
  })
  const missing = skills.filter((_, k) => !used.has(k))
  if (missing.length && rows.length >= skills.length) warnings.push(`見つからなかったスキル：${missing.map((s) => s.name).join('、')}`)
  return { skills: alloc, warnings }
}

/** 2枚の画面の文字から、メンバーに当てはめる値を作る */
export function readScreenshots(status: StatusText, skill: SkillText): ScreenshotResult {
  const warnings: string[] = []
  const job = matchJob(status.job, skill.job)
  if (job.warning) warnings.push(job.warning)
  const lvDigits = status.level.normalize('NFKC').replace(/\D/g, '')
  let level: number | null = lvDigits ? Number(lvDigits) : null
  if (level !== null && (level < 1 || level > rules.maxLevel)) {
    warnings.push(`Lv「${lvDigits}」は範囲外です`)
    level = null
  }
  if (level === null) warnings.push('レベルを読み取れませんでした')
  const name = stripNoise(status.name).replace(/\s/g, '').slice(0, 8) || null
  if (!job.jobId) return { name, jobId: null, level, weaponId: null, armorIds: [null, null, null], skills: {}, warnings }
  const eq = matchEquipment(status.equip, job.jobId)
  const sk = matchSkills(skill.rows, job.jobId)
  return { name, jobId: job.jobId, level, weaponId: eq.weaponId, armorIds: eq.armorIds, skills: sk.skills, warnings: [...warnings, ...eq.warnings, ...sk.warnings] }
}

/** 結果の説明（画面に出す） */
export function describeResult(r: ScreenshotResult): string[] {
  const out: string[] = []
  if (r.jobId) out.push(`ジョブ：${findJob(r.jobId).name}`)
  if (r.level !== null) out.push(`Lv${r.level}`)
  const eqName = (id: string | null) => (id ? (equipment.find((e) => e.id === id)?.name ?? id) : '空き')
  out.push(`装備：${[r.weaponId, ...r.armorIds].map(eqName).join('／')}`)
  const skills = r.jobId ? (skillsByJob[r.jobId] ?? []) : []
  const learned = skills.filter((s) => r.skills[s.id]).map((s) => `${s.name}${r.skills[s.id]}`)
  out.push(`スキル：${learned.length ? learned.join('、') : 'なし'}`)
  return out
}
