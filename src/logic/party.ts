// パーティ編成の状態（仕様書 C1）
import type { z } from 'zod'
import type { Difficulty } from '../data/schema'
import type { Retirement } from './retire'
import type { Allocation } from './skills'

export type Row = 'front' | 'back'
export type DifficultyId = z.infer<typeof Difficulty>

export interface Member {
  id: string
  name: string
  jobId: string
  level: number
  row: Row
  skills: Allocation
  /** 引退ボーナスの元になった引退（null は引退なし） */
  retire: Retirement | null
  /** 装備している武器の ID（null は素手） */
  weaponId: string | null
}

export interface Party {
  difficulty: DifficultyId
  members: Member[]
}

/** パーティの人数（1〜5人）と隊列の人数（前列1〜3人、後列0〜3人）。2026-09-30 にゲーム内で本人が確認 */
export const MIN_MEMBERS = 1
export const MAX_MEMBERS = 5
export const MIN_FRONT = 1
export const MAX_FRONT = 3
export const MAX_BACK = 3

function countRow(members: Member[], row: Row): number {
  return members.filter((m) => m.row === row).length
}

/** 隊列の決まりを満たしているか。満たさない理由を返す（満たしていれば null） */
export function formationError(members: Member[]): string | null {
  if (members.length < MIN_MEMBERS) return `パーティは${MIN_MEMBERS}人以上必要です`
  if (members.length > MAX_MEMBERS) return `パーティは${MAX_MEMBERS}人までです`
  const front = countRow(members, 'front')
  if (front < MIN_FRONT) return `前列は${MIN_FRONT}人以上必要です`
  if (front > MAX_FRONT) return `前列は${MAX_FRONT}人までです`
  if (countRow(members, 'back') > MAX_BACK) return `後列は${MAX_BACK}人までです`
  return null
}

/** メンバーの隊列を変えられるか。変えられない理由を返す（変えられれば null） */
export function rowChangeError(members: Member[], memberId: string, row: Row): string | null {
  return formationError(members.map((m) => (m.id === memberId ? { ...m, row } : m)))
}

/** メンバーを外せるか。外せない理由を返す（外せれば null） */
export function removeError(members: Member[], memberId: string): string | null {
  return formationError(members.filter((m) => m.id !== memberId))
}

/** 新しく加えるメンバーの隊列：前列に空きがあれば前列、なければ後列 */
export function defaultRow(members: Member[]): Row {
  return countRow(members, 'front') < MAX_FRONT ? 'front' : 'back'
}

export const DIFFICULTY_LABELS: Record<DifficultyId, string> = {
  expert: 'EXPERT（オリジナル版相当）',
  basic: 'BASIC',
  picnic: 'PICNIC',
}

let serial = 0
export function newMember(members: Member[], jobId: string): Member {
  serial += 1
  return {
    id: `m${Date.now().toString(36)}${serial}`,
    name: `メンバー${members.length + 1}`,
    jobId,
    level: 1,
    row: defaultRow(members),
    skills: {},
    retire: null,
    weaponId: null,
  }
}
