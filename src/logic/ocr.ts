// スクリーンショットの文字を読む（ブラウザの中の OCR）。2026-11-01
// tesseract.js（Apache-2.0）を使う。読み取りはすべてこのブラウザの中で行い、画像はどこにも送らない。
// ただし、初めて使うときに OCR のプログラムと日本語・英語の文字のデータを CDN（cdn.jsdelivr.net）から読み込む（数 MB〜十数 MB）。
// 読み取った文字をアプリのデータに当てはめるのは screenshot.ts
import { gameArea, isGreyBadge, SKILL_LAYOUT, STATUS_LAYOUT, toImageRect, type Rect, type SkillText, type StatusText } from './screenshot'

type Progress = (done: number, total: number) => void

async function loadCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = bitmap.width
  c.height = bitmap.height
  c.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return c
}

/** 画像の中のゲーム画面の範囲（黒い帯を除く） */
function areaOf(c: HTMLCanvasElement): Rect {
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  return gameArea(c.width, c.height, (x, y) => {
    const i = (y * c.width + x) * 4
    return data[i] + data[i + 1] + data[i + 2] > 3 * 24
  })
}

/** 基準の座標の範囲を切り出し、基準の大きさ（1920×1080 の画面のときの大きさ）に拡大・縮小した画像 */
function crop(c: HTMLCanvasElement, area: Rect, r: Rect): HTMLCanvasElement {
  const src = toImageRect(area, r)
  const out = document.createElement('canvas')
  out.width = Math.round(r.w)
  out.height = Math.round(r.h)
  out.getContext('2d')!.drawImage(c, src.x, src.y, src.w, src.h, 0, 0, out.width, out.height)
  return out
}

/** 範囲の平均の色 */
function meanColor(c: HTMLCanvasElement, area: Rect, r: Rect): [number, number, number] {
  const src = toImageRect(area, r)
  const x = Math.max(0, Math.round(src.x))
  const y = Math.max(0, Math.round(src.y))
  const w = Math.max(1, Math.min(c.width - x, Math.round(src.w)))
  const h = Math.max(1, Math.min(c.height - y, Math.round(src.h)))
  const d = c.getContext('2d')!.getImageData(x, y, w, h).data
  let r0 = 0
  let g0 = 0
  let b0 = 0
  for (let i = 0; i < d.length; i += 4) {
    r0 += d[i]
    g0 += d[i + 1]
    b0 += d[i + 2]
  }
  const n = d.length / 4
  return [r0 / n, g0 / n, b0 / n]
}

/** ステータス画面とスキル画面の2枚から文字を読む */
export async function readScreenshotFiles(statusFile: File, skillFile: File, onProgress?: Progress): Promise<{ status: StatusText; skill: SkillText }> {
  const { createWorker, PSM } = await import('tesseract.js')
  const [statusImg, skillImg] = await Promise.all([loadCanvas(statusFile), loadCanvas(skillFile)])
  for (const c of [statusImg, skillImg]) {
    // 横長すぎ・縦長すぎの画像は、ゲームの画面ではないと考える
    const ratio = c.width / c.height
    if (ratio < 1.2 || ratio > 2.4) throw new Error('画像の縦横の比がゲームの画面と合いません。スクリーンショットをそのまま選んでください')
  }
  // 進み具合：OCR の準備2つ、ステータス画面 3＋装備4、スキル画面のジョブ1、行ごとに名前と札
  const total = 2 + 3 + STATUS_LAYOUT.equip.length + 1 + SKILL_LAYOUT.rows.length * 2
  let done = 0
  const step = () => onProgress?.(++done, total)
  const jpn = await createWorker('jpn')
  const eng = await createWorker('eng')
  step()
  step()
  try {
    await eng.setParameters({ tessedit_char_whitelist: '0123456789*★-', tessedit_pageseg_mode: PSM.SINGLE_LINE })
    const read = async (w: typeof jpn, c: HTMLCanvasElement, area: Rect, r: Rect) => {
      const text = (await w.recognize(crop(c, area, r))).data.text
      step()
      return text
    }
    const sa = areaOf(statusImg)
    const status: StatusText = {
      name: await read(jpn, statusImg, sa, STATUS_LAYOUT.name),
      level: await read(jpn, statusImg, sa, STATUS_LAYOUT.level),
      job: await read(jpn, statusImg, sa, STATUS_LAYOUT.job),
      equip: [],
    }
    for (const r of STATUS_LAYOUT.equip) status.equip.push(await read(jpn, statusImg, sa, r))
    const ka = areaOf(skillImg)
    const skill: SkillText = { job: await read(jpn, skillImg, ka, SKILL_LAYOUT.job), rows: [] }
    for (const row of SKILL_LAYOUT.rows) {
      const grey = isGreyBadge(...meanColor(skillImg, ka, row.badge))
      const name = await read(jpn, skillImg, ka, row.name)
      const digit = grey ? (step(), '') : await read(eng, skillImg, ka, row.digit)
      skill.rows.push({ name, digit, grey })
    }
    return { status, skill }
  } finally {
    await jpn.terminate()
    await eng.terminate()
  }
}
