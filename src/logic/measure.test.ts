// 実測記録のテスト：入力の読み取り、予測との比較、書き出し・読み込み
import { describe, expect, it } from 'vitest'
import { findEnemy } from '../data/gameData'
import { compare, exportMeasurements, importMeasurements, newMeasurement, parseValues, summarize } from './measure'
import { newMember } from './party'
import { DEFAULT_ATTACK, DEFAULT_TARGET, predict, targetFromEnemy } from './predict'

// ソードマン Lv10・素手。素の STR は Lv10 の表の値
const member = { ...newMember([], 'swordsman'), level: 10 }

describe('ダメージの入力', () => {
  it('スペース・カンマ・読点・全角数字で区切れる', () => {
    expect(parseValues('12 15,18、２０')).toEqual([12, 15, 18, 20])
  })
  it('数でないもの・空はだめ', () => {
    expect(parseValues('12 abc')).toBeNull()
    expect(parseValues('  ')).toBeNull()
    expect(parseValues('1.5')).toBeNull()
  })
})

describe('敵データ', () => {
  it('森ネズミ（Treerat）は Lv2・VIT14・炎200%', () => {
    const e = findEnemy('treerat')!
    expect(e.name).toBe('森ネズミ')
    expect([e.level, e.vit, e.resist.fire]).toEqual([2, 14, 200])
  })

  it('敵を選んだ記録は、記録した時点の値ではなく今の敵データで予測する', () => {
    const stale = { ...targetFromEnemy(findEnemy('treerat')!), vit: 999 }
    const fresh = targetFromEnemy(findEnemy('treerat')!)
    expect(predict(member, DEFAULT_ATTACK, stale, 'expert').result!.min).toBe(predict(member, DEFAULT_ATTACK, fresh, 'expert').result!.min)
  })
})

describe('予測との比較', () => {
  const target = { ...DEFAULT_TARGET, level: 10, vit: 10 }
  const r = predict(member, DEFAULT_ATTACK, target, 'expert').result!

  it('範囲内・範囲外を数える', () => {
    const rec = newMeasurement(member, DEFAULT_ATTACK, target, 'expert', [r.min, r.max, r.max + 1], '', '')
    const c = compare(rec)
    expect(c.inRange).toBe(2)
    expect(c.outside).toEqual([r.max + 1])
    expect(summarize([rec])).toEqual({ records: 1, values: 3, inRange: 2, recordsWithOutliers: 1 })
  })

  it('記録したあとでメンバーを変えても、記録の条件は変わらない', () => {
    const m = { ...member, skills: {} as Record<string, number> }
    const rec = newMeasurement(m, DEFAULT_ATTACK, target, 'expert', [r.min], '', '')
    m.skills['atk-boost'] = 10
    expect(rec.member.skills).toEqual({})
  })
})

describe('書き出し・読み込み', () => {
  const rec = newMeasurement(member, DEFAULT_ATTACK, DEFAULT_TARGET, 'basic', [10, 11], '1.0', 'メモ')

  it('書き出して読み込むと同じ記録に戻り、同じ記録は二重に足さない', () => {
    const json = exportMeasurements([rec])
    const a = importMeasurements(json, [])
    expect(a.ok && a.records).toEqual([rec])
    const b = importMeasurements(json, [rec])
    expect(b.ok && b.added).toBe(0)
  })

  it('形式が違うものははじく', () => {
    expect(importMeasurements('{"a":1}', []).ok).toBe(false)
    expect(importMeasurements('壊れた', []).ok).toBe(false)
  })

  it('今のデータに無いジョブの記録でも落ちない', () => {
    const odd = { ...rec, member: { ...rec.member, jobId: 'no-such-job' } }
    expect(compare(odd).prediction.result).toBeNull()
  })
})
