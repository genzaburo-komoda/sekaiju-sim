// 共有コード・テキスト書き出し・引退ボーナスのテスト
import { describe, expect, it } from 'vitest'
import { equipment, findJob, jobs, rules, skillsByJob } from '../data/gameData'
import { newMember, type Party } from './party'
import { retireSpBonus, retireStatBonus } from './retire'
import { decodeParty, encodeParty, partyToText } from './share'
import { setSkillLevel, spTotal } from './skills'
import { displayStats } from './stats'

const ctx = { jobs, skillsByJob, rules, equipment }
const skills = skillsByJob['swordsman']

function sampleParty(): Party {
  const a = { ...newMember([], 'swordsman'), name: 'アキラ', level: 66, skills: setSkillLevel(skills, { 'hp-boost': 10 }, 'hayabusa', 5), weaponId: 'sword-19' }
  const b = { ...newMember([a], 'swordsman'), name: 'ベル', level: 30, row: 'back' as const, retire: { level: 70, jobId: 'swordsman' } }
  return { difficulty: 'basic', members: [a, b] }
}

describe('引退ボーナス（A2）', () => {
  it('引退レベルに応じた SP ボーナス（Lv30 で+2〜Lv70 で+6）', () => {
    expect(retireSpBonus(rules, null)).toBe(0)
    expect(retireSpBonus(rules, { level: 30, jobId: 'swordsman' })).toBe(2)
    expect(retireSpBonus(rules, { level: 45, jobId: 'swordsman' })).toBe(3)
    expect(retireSpBonus(rules, { level: 70, jobId: 'swordsman' })).toBe(6)
    expect(spTotal(rules, 70, 6)).toBe(78)
  })

  it('ソードマンで引退すると STR が上がる（Lv30〜49 で+1、70 で+3）', () => {
    expect(retireStatBonus(rules, { level: 40, jobId: 'swordsman' }, findJob)).toEqual({ stat: 'str', value: 1 })
    expect(retireStatBonus(rules, { level: 70, jobId: 'swordsman' }, findJob)).toEqual({ stat: 'str', value: 3 })
    const job = findJob('swordsman')
    const bonus = retireStatBonus(rules, { level: 70, jobId: 'swordsman' }, findJob)
    expect(displayStats(job, 1, skills, {}, bonus, rules.statCap).str).toBe(9 + 3)
  })
})

describe('共有コード（A4）', () => {
  it('コードにして戻すと、同じ構築に戻る', () => {
    const party = sampleParty()
    const result = decodeParty(encodeParty(party), ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual([])
    expect(result.party.difficulty).toBe('basic')
    const strip = (p: Party) => p.members.map(({ id: _id, ...rest }) => rest)
    expect(strip(result.party)).toEqual(strip(party))
  })

  it('コードは URL に使える文字だけでできている', () => {
    expect(encodeParty(sampleParty())).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
  })

  it('壊れたコード・途中で切れたコードはエラーにする', () => {
    expect(decodeParty('abc', ctx).ok).toBe(false)
    const code = encodeParty(sampleParty())
    expect(decodeParty(code.slice(0, code.length - 10), ctx).ok).toBe(false)
  })

  it('存在しないスキルは外して警告する', () => {
    const party = sampleParty()
    party.members[0].skills = { ...party.members[0].skills, 'no-such-skill': 3 }
    const result = decodeParty(encodeParty(party), ctx)
    expect(result.ok && result.warnings.some((w) => w.includes('no-such-skill'))).toBe(true)
  })

  it('装備できない武器・存在しない武器は外して警告する', () => {
    const party = sampleParty()
    party.members[0].weaponId = 'staff-1'
    party.members[1].weaponId = 'no-such-weapon'
    const result = decodeParty(encodeParty(party), ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.party.members.map((m) => m.weaponId)).toEqual([null, null])
    expect(result.warnings).toHaveLength(2)
  })

  it('防具（装備2〜4）も戻り、枠に合わない防具は外して警告する', () => {
    const party = sampleParty()
    const mail = equipment.find((e) => e.name === 'バーサーカーメイル')!.id
    const shield = equipment.find((e) => e.name === 'タージェ')!.id
    party.members[0].armorIds = [mail, shield, null] // 盾は3枠目に付けられない
    const result = decodeParty(encodeParty(party), ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.party.members[0].armorIds).toEqual([mail, null, null])
    expect(result.warnings).toHaveLength(1)
    expect(partyToText(result.party, ctx)).toContain('防具：バーサーカーメイル（防52）')
  })

  it('武器の項目が無い古いコードも読める（素手になる）', () => {
    const old = 'v1.' + btoa(JSON.stringify({ d: 'expert', m: [{ n: 'A', j: 'swordsman', l: 1, r: 'f', s: {}, t: null }] })).replace(/=+$/, '')
    const result = decodeParty(old, ctx)
    expect(result.ok && result.party.members[0].weaponId).toBe(null)
  })

  it('隊列の決まりを満たさないコードはエラーにする', () => {
    const party = sampleParty()
    party.members.forEach((m) => (m.row = 'back'))
    const result = decodeParty(encodeParty(party), ctx)
    expect(result.ok).toBe(false)
  })
})

describe('テキスト書き出し（A5）', () => {
  it('隊列・ジョブ・レベル・引退・SP・スキルが入る', () => {
    const text = partyToText(sampleParty(), ctx)
    expect(text).toContain('難易度：BASIC')
    expect(text).toContain('[前列] アキラ：ソードマン Lv66')
    expect(text).toContain('武器：ドヴェルグの魔剣（攻200）')
    expect(text).toContain('HPブースト10')
    expect(text).toContain('ハヤブサ駆け5')
    expect(text).toContain('[後列] ベル：ソードマン Lv30・引退Lv70（ソードマン、SP+6・STR+3）　SP 0/38')
  })
})
