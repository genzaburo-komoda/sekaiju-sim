// 構築の共有（仕様書 A4・A5）。
// - URL：パーティを短い文字列にして URL の「#」以降に入れる。開くと復元される
// - テキスト：「ジョブ Lv / スキル名 Lv…」の形にしてコピーできるようにする
import { z } from 'zod'
import type { Equipment, Job, ProgressionRules, Skill } from '../data/schema'
import { validArmorIds } from './equip'
import { DIFFICULTY_LABELS, formationError, MAX_MEMBERS, newMember, type Member, type Party } from './party'
import { retireSpBonus, retireStatBonus } from './retire'
import { setSkillLevel, spTotal, spUsed, type Allocation } from './skills'

/** 共有コードの形式の版。形式を変えたら上げ、古い版も読めるようにする */
const CODE_VERSION = 1
const PREFIX = `v${CODE_VERSION}.`

/** 共有コードの中身。キーを短くして URL を短くする */
const CodeMember = z.object({
  n: z.string().max(20), // 名前
  j: z.string(), // ジョブ ID
  l: z.number().int(), // レベル
  r: z.enum(['f', 'b']), // 隊列（前列／後列）
  s: z.record(z.string(), z.number().int()), // スキル ID → レベル
  t: z.tuple([z.number().int(), z.string()]).nullable(), // 引退（レベル、ジョブ ID）
  w: z.string().nullable().optional(), // 武器 ID（ステップ2-1 で追加。古いコードには無い）
  a: z.array(z.string().nullable()).max(3).optional(), // 装備2〜4枠目の防具 ID（ステップ4-4 で追加。古いコードには無い）
})
const Code = z.object({
  d: z.enum(['expert', 'basic', 'picnic']),
  m: z.array(CodeMember).min(1).max(MAX_MEMBERS),
})

// ---- 文字列 ⇔ URL に使える文字（base64url） ----
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** パーティを共有コードにする */
export function encodeParty(party: Party): string {
  const code: z.infer<typeof Code> = {
    d: party.difficulty,
    m: party.members.map((m) => ({
      n: m.name,
      j: m.jobId,
      l: m.level,
      r: m.row === 'front' ? 'f' : 'b',
      s: m.skills,
      t: m.retire ? [m.retire.level, m.retire.jobId] : null,
      w: m.weaponId,
      ...((m.armorIds ?? []).some(Boolean) ? { a: m.armorIds } : {}),
    })),
  }
  return PREFIX + toBase64Url(JSON.stringify(code))
}

/** 共有用の URL（今のページの URL の「#」以降に共有コードを付ける） */
export function shareUrl(party: Party, base = `${location.origin}${location.pathname}`): string {
  return `${base}#${encodeParty(party)}`
}

export interface DecodeContext {
  jobs: Job[]
  skillsByJob: Record<string, Skill[]>
  rules: ProgressionRules
  equipment: Equipment[]
}

export type DecodeResult = { ok: true; party: Party; warnings: string[] } | { ok: false; error: string }

/**
 * 共有コードをパーティに戻す。
 * 壊れたコードはエラーにし、読めたが今のデータと合わない部分（存在しないスキルなど）は直して警告を返す。
 */
export function decodeParty(text: string, ctx: DecodeContext): DecodeResult {
  if (!text.startsWith(PREFIX)) return { ok: false, error: '共有コードの形式が違います（対応していない版か、コードが途中で切れています）' }
  let parsed: z.infer<typeof Code>
  try {
    const r = Code.safeParse(JSON.parse(fromBase64Url(text.slice(PREFIX.length))))
    if (!r.success) return { ok: false, error: '共有コードの中身が読めません' }
    parsed = r.data
  } catch {
    return { ok: false, error: '共有コードが壊れています（途中で切れている可能性があります）' }
  }

  const warnings: string[] = []
  const members: Member[] = []
  for (const cm of parsed.m) {
    const label = cm.n || `メンバー${members.length + 1}`
    const job = ctx.jobs.find((j) => j.id === cm.j)
    if (!job) {
      warnings.push(`${label}：ジョブ「${cm.j}」がないため外しました`)
      continue
    }
    const level = Math.max(1, Math.min(ctx.rules.maxLevel, cm.l))
    if (level !== cm.l) warnings.push(`${label}：レベルを ${level} に直しました`)
    const retireJob = cm.t && ctx.jobs.find((j) => j.id === cm.t![1])
    const retire = cm.t && retireJob ? { level: cm.t[0], jobId: cm.t[1] } : null
    if (cm.t && !retireJob) warnings.push(`${label}：引退前のジョブ「${cm.t[1]}」がないため引退の設定を外しました`)

    // スキルは存在するものだけ、前提スキルの自動取得と同じ手順で振り直す
    const skills = ctx.skillsByJob[job.id] ?? []
    let alloc: Allocation = {}
    for (const [id, lv] of Object.entries(cm.s)) {
      if (!skills.some((s) => s.id === id)) {
        warnings.push(`${label}：スキル「${id}」がないため外しました`)
        continue
      }
      alloc = setSkillLevel(skills, alloc, id, Math.max(lv, alloc[id] ?? 0))
    }
    // 武器は存在して、そのジョブが装備できるものだけ
    let weaponId: string | null = null
    if (cm.w) {
      const weapon = ctx.equipment.find((e) => e.id === cm.w)
      if (!weapon) warnings.push(`${label}：武器「${cm.w}」がないため外しました`)
      else if (!weapon.jobs.includes(job.id)) warnings.push(`${label}：${job.name}は「${weapon.name}」を装備できないため外しました`)
      else weaponId = weapon.id
    }

    // 防具は存在して、その枠とジョブに合うものだけ
    const armorIds = validArmorIds(cm.a, job.id)
    ;(cm.a ?? []).forEach((id, i) => {
      if (id && armorIds[i] !== id) warnings.push(`${label}：装備${i + 2}の「${ctx.equipment.find((e) => e.id === id)?.name ?? id}」は付けられないため外しました`)
    })

    const base = newMember(members, job.id)
    members.push({ ...base, name: cm.n.slice(0, 8) || base.name, level, row: cm.r === 'f' ? 'front' : 'back', skills: alloc, retire, weaponId, armorIds })
  }
  if (members.length === 0) return { ok: false, error: '読み込めるメンバーがいませんでした' }
  const formation = formationError(members)
  if (formation) return { ok: false, error: `隊列の決まりを満たしていません（${formation}）` }
  return { ok: true, party: { difficulty: parsed.d, members }, warnings }
}

const STAT_LABEL = { hp: 'HP', tp: 'TP', str: 'STR', vit: 'VIT', agi: 'AGI', luc: 'LUC', tec: 'TEC' } as const

/** 構築をテキストにする（仕様書 A5） */
export function partyToText(party: Party, ctx: DecodeContext): string {
  const lines = [`世界樹の迷宮Ⅰ HD REMASTER パーティ構築（難易度：${DIFFICULTY_LABELS[party.difficulty]}）`]
  const findJob = (id: string) => ctx.jobs.find((j) => j.id === id)!
  for (const row of ['front', 'back'] as const) {
    for (const m of party.members.filter((x) => x.row === row)) {
      const job = findJob(m.jobId)
      const bonusSp = retireSpBonus(ctx.rules, m.retire)
      const bonusStat = retireStatBonus(ctx.rules, m.retire, findJob)
      const retireText = m.retire
        ? `・引退Lv${m.retire.level}（${findJob(m.retire.jobId).name}、SP+${bonusSp}${bonusStat ? `・${STAT_LABEL[bonusStat.stat]}+${bonusStat.value}` : ''}）`
        : ''
      lines.push(
        `[${row === 'front' ? '前列' : '後列'}] ${m.name}：${job.name} Lv${m.level}${retireText}　SP ${spUsed(m.skills)}/${spTotal(ctx.rules, m.level, bonusSp)}`,
      )
      const weapon = ctx.equipment.find((e) => e.id === m.weaponId)
      lines.push(`  武器：${weapon ? `${weapon.name}（攻${weapon.atk}）` : '素手'}`)
      const armor = (m.armorIds ?? []).map((id) => ctx.equipment.find((e) => e.id === id)).filter((e) => !!e)
      if (armor.length) lines.push(`  防具：${armor.map((e) => `${e.name}（防${e.def ?? 0}）`).join('、')}`)
      const skills = (ctx.skillsByJob[m.jobId] ?? []).filter((s) => (m.skills[s.id] ?? 0) > 0)
      lines.push(skills.length ? '  ' + skills.map((s) => `${s.name}${m.skills[s.id]}`).join(' / ') : '  （スキルなし）')
    }
  }
  return lines.join('\n')
}
