// データ検査のテスト。`npm test` で実行される。
// 前半：実際のデータファイルにエラーがないこと。
// 後半：わざと壊したデータを渡して、検査が正しくエラーを見つけること。
import { describe, expect, it } from 'vitest'
import { rawData } from './index'
import { validateData, type DataSet } from './validate'

describe('実データ', () => {
  it('全データファイルに形式・整合性のエラーがない', () => {
    expect(validateData(rawData)).toEqual([])
  })

  it('ソードマンのスキルが読み込まれている', () => {
    const file = rawData.skillFiles.find((f) => (f as { jobId: string }).jobId === 'swordsman') as { skills: unknown[] }
    expect(file.skills.length).toBe(21)
  })
})

// ---- 検査の動作確認用の最小データ ----

const job = { id: 'test-job', name: 'テスト職', skillWeapons: ['sword'], retireBonusStat: 'str', stats: [], sources: [{ kind: 'other', confidence: 'unverified' }] }
const src = [{ kind: 'other', confidence: 'unverified' }]

/** 数値入力済みの攻撃スキル（Lv1〜3） */
function attackSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'slash', jobId: 'test-job', name: '斬撃', status: 'entered', category: 'active', maxLevel: 3,
    bodyPart: 'arm', prerequisites: [], speed: { kind: 'agi', factor: 0.8 }, boostable: false,
    params: [{ id: 'dmg', label: 'ダメージ倍率', unit: 'percent' }],
    effects: [{ type: 'damage', attack: 'str', element: 'slash', target: 'enemy-single', powerParam: 'dmg' }],
    levels: [1, 2, 3].map((lv) => ({ lv, tp: 5, values: { dmg: 100 + lv * 10 } })),
    sources: src,
    ...overrides,
  }
}

function dataWith(skills: unknown[]): DataSet {
  return { jobs: [job], skillFiles: [{ jobId: 'test-job', skills }] }
}

/** エラーのうち、指定した文字列を含むものがあるか */
function expectError(data: DataSet, fragment: string) {
  const errors = validateData(data)
  expect(errors.some((e) => e.includes(fragment)), `「${fragment}」を含むエラーがない：\n${errors.join('\n')}`).toBe(true)
}

describe('検査の動作', () => {
  it('正しいデータではエラーが出ない', () => {
    expect(validateData(dataWith([attackSkill()]))).toEqual([])
  })

  it('必須項目の欠け・値の範囲外を見つける', () => {
    expectError(dataWith([attackSkill({ name: '' })]), 'name')
    expectError(dataWith([attackSkill({ maxLevel: 20 })]), 'maxLevel')
  })

  it('存在しない前提スキルを見つける', () => {
    expectError(dataWith([attackSkill({ prerequisites: [{ skillId: 'nothing', level: 1 }] })]), '前提スキル「nothing」が存在しません')
  })

  it('前提スキルの循環を見つける', () => {
    const a = attackSkill({ id: 'a', prerequisites: [{ skillId: 'b', level: 1 }] })
    const b = attackSkill({ id: 'b', prerequisites: [{ skillId: 'a', level: 1 }] })
    expectError(dataWith([a, b]), '循環')
  })

  it('前提レベルが最大レベルを超えているのを見つける', () => {
    const a = attackSkill({ id: 'a' })
    const b = attackSkill({ id: 'b', prerequisites: [{ skillId: 'a', level: 5 }] })
    expectError(dataWith([a, b]), '最大レベル 3 を超えています')
  })

  it('レベル数の不一致・値の抜けを見つける', () => {
    expectError(dataWith([attackSkill({ maxLevel: 4 })]), 'levels の数（3）が最大レベル（4）と一致しません')
    const broken = attackSkill()
    ;(broken.levels as { values: Record<string, number> }[])[1].values = {}
    expectError(dataWith([broken]), '項目「dmg」の値がありません')
  })

  it('効果が参照する項目の定義漏れを見つける', () => {
    expectError(dataWith([attackSkill({ params: [] })]), '項目「dmg」が params に定義されていません')
  })

  it('アクティブスキルの消費TPの抜けを見つける', () => {
    expectError(dataWith([attackSkill({ levels: [1, 2, 3].map((lv) => ({ lv, values: { dmg: 100 } })) })]), '消費TPがありません')
  })

  it('status と levels の食い違いを見つける', () => {
    expectError(dataWith([attackSkill({ status: 'skeleton' })]), 'skeleton なのに levels があります')
    expectError(dataWith([attackSkill({ levels: undefined })]), 'entered なのに levels がありません')
  })

  it('スキル ID の重複と、存在しないジョブを見つける', () => {
    expectError(dataWith([attackSkill(), attackSkill()]), 'スキル ID「slash」が重複しています')
    expectError({ jobs: [], skillFiles: [{ jobId: 'test-job', skills: [] }] }, 'ジョブ「test-job」が jobs に存在しません')
  })

  it('引退ボーナスの範囲の重なりと、ステータス表のレベル重複を見つける', () => {
    const rules = {
      maxLevel: 70, initialSp: 3, spPerLevel: 1, retireMinLevel: 30, statCap: 127, sources: src,
      retireSpBonus: [{ minLevel: 30, maxLevel: 45, value: 2 }, { minLevel: 40, maxLevel: 49, value: 3 }],
      retireStatBonus: [],
    }
    expectError({ jobs: [job], skillFiles: [], rules }, '範囲が重なっています')
    const stat = { lv: 20, hp: 1, tp: 1, str: 1, vit: 1, agi: 1, luc: 1, tec: 1, confidence: 'unverified' }
    expectError({ jobs: [{ ...job, stats: [stat, stat] }], skillFiles: [] }, 'Lv20 が重複しています')
  })

  it('レベル差補正の表の抜けを見つける', () => {
    const rows = Array.from({ length: 41 }, (_, i) => ({ levelDiff: i - 20, playerDealt: 100, enemyDealt: 100 }))
    rows[5].levelDiff = 0 // −15 が抜けて 0 が重複
    const m = { damageDealt: 100, damageTaken: 100, ailmentInflict: 100, ailmentVulnerability: 100, healing: 100, partyAccuracy: 100, enemyAccuracy: 100, partySpeed: 100 }
    const formula = { id: 'f', name: 'f', levelCorrection: rows, difficulty: { expert: m, basic: m, picnic: m }, sources: src }
    expectError({ jobs: [job], skillFiles: [], formulaSets: [formula] }, 'レベル差補正の表に抜けか重複があります')
  })
})
