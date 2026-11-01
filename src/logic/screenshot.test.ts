// スクリーンショットからメンバーを設定する（screenshot.ts）のテスト。
// 読み取った文字は、2026-10-18 のスクリーンショット 59・60・62 を tesseract.js（jpn・eng）で実際に読んだ結果（2026-11-01）
import { describe, expect, it } from 'vitest'
import { gameArea, isGreyBadge, matchEquipment, matchSkills, normalize, readScreenshots, similarity, stripNoise, type SkillRowText } from './screenshot'

// [読んだ名前, 札の文字, 灰色か]
const rows = (xs: [string, string, boolean][]): SkillRowText[] => xs.map(([name, digit, grey]) => ({ name, digit, grey }))

const SWORDSMAN_ROWS = rows([
  ['HPブースト', '*', false],
  ['TPブースト', '*', false],
  ['ATKブースト', '*', false],
  ['DEFブースト', '*', false],
  ['疹マスタリーーー', '5', false],
  ['創マスタリー', '*', false],
  ['ダブルアタック', '2', false],
  ['ウォークライ', '5', true],
  ['ヘルズクライ', '5', true],
  ['アームリカバリー', '5', true],
  ['猛進逃走', '5', true],
  ['レイジングエッジ', '5', true],
  ['トルネード', '5', true],
  ['ハヤブサ駆け', '5', true],
  ['チェイスファイア', '*', false],
  ['チェイスフリーズ', '1', false],
  ['チェイスショック', '5', true],
  ['パワークラフラッシュ', '5', true],
  ['スタンスマッシュ', '5', true],
  ['ヘッドバッシュ', '5', true],
  ['採掘', '5', true],
])

const PALADIN_ROWS = rows([
  ['HPブースト', '5', false],
  ['TPブースト', '7', false],
  ['DEFブースト', '*', false],
  ['盾マスタリーーー', '9', false],
  ['決死の覚悟', '*', false],
  ['ブオートガードニーニー', '*', false],
  ['挑発', '5', true],
  ['猛進逃走', '5', true],
  ['パリング', '5', true],
  ['澤身ディフェンス', '5', true],
  ['防御陣形', '5', true],
  ['フロントガード', '1', false],
  ['バックガードニー', '1', false],
  ['ファイアガードニーー', '1', false],
  ['フリーズガードニー', '1', false],
  ['ショックガードニー', '*', false],
  ['シールドスマイト', '5', true],
  ['キュア', '5', true],
  ['キュア間', '5', true],
  ['警戒歩行', '5', true],
  ['採掘', '5', true],
])

describe('スクリーンショットからメンバーを設定する', () => {
  it('文字をそろえる：長音の似た字・続く長音・空白', () => {
    expect(normalize('盾 マスタリーーー')).toBe('盾マスタリー')
    expect(normalize('ソー ド マ ン')).toBe('ソードマン')
    expect(similarity('ド ヴ ェ ル グ の 魔 剣', 'ドヴェルグの魔剣')).toBe(1)
  })

  it('ステータス画面とスキル画面（ソードマン、実際に読んだ文字）から設定できる', () => {
    const r = readScreenshots(
      { name: 'ムルソー', level: 'Lv66\n', job: 'ーー 一 一 一 一 ニニ ーー = 竹生 へ\n_ ソー ド マ ン\n', equip: ['ド ヴ ェ ル グ の 魔 剣', 'コン ポジ ッ ト ア ー マ ー', '天使 の 盾', 'エト リア の 勲章'] },
      { job: 'ソードマン', rows: SWORDSMAN_ROWS },
    )
    expect(r.jobId).toBe('swordsman')
    expect(r.level).toBe(66)
    expect(r.name).toBe('ムルソー')
    expect(r.weaponId).toBe('sword-19')
    // 防具はどの枠にも付けられる（2026-11-01 本人確認）ので、画面の並びのまま
    expect(r.armorIds).toEqual(['armor-36', 'shield-11', 'accessory-39'])
    // 画面：HP・TP・ATK・DEF ブースト ★、斧マスタリー 5、剣マスタリー ★、ダブルアタック 2、チェイスファイア ★、チェイスフリーズ 1
    expect(r.skills).toEqual({
      'hp-boost': 10,
      'tp-boost': 10,
      'atk-boost': 10,
      'def-boost': 10,
      'axe-mastery': 5,
      'sword-mastery': 10,
      'double-attack': 2,
      'chase-fire': 10,
      'chase-freeze': 1,
    })
  })

  it('並びがデータと違っても名前で当てはめる（パラディン：フリーズガードとショックガードが逆）', () => {
    const { skills } = matchSkills(PALADIN_ROWS, 'paladin')
    expect(skills['paladin-freeze-guard']).toBe(1)
    expect(skills['paladin-shock-guard']).toBe(10)
    expect(skills['paladin-auto-guard']).toBe(10)
    expect(skills['paladin-shield-mastery']).toBe(9)
    expect(skills['paladin-cure-2']).toBeUndefined()
  })

  it('枠の縁の読み違い（「|」「_」、行末の数字）を除いて装備を当てはめる（実際に読んだ文字）', () => {
    expect(stripNoise('_ シ ルル バー シー ルド 1')).toBe('シ ルル バー シー ルド')
    const r = matchEquipment(['バス ター ド ソ ー ド |', '_ ブラ ッ ド チェ イン |', '_ シ ルル バー シー ルド 1', '鮮血 の ガン ト レッ ト'], 'paladin')
    expect(r.warnings).toEqual([])
  })

  it('札の色：灰色は未習得、水色は習得', () => {
    expect(isGreyBadge(128, 128, 130)).toBe(true)
    expect(isGreyBadge(150, 210, 240)).toBe(false)
  })

  it('ゲーム画面の範囲：上下の黒い帯（1920×1200 の上下 60）を除く', () => {
    const area = gameArea(1920, 1200, (_, y) => y >= 60 && y < 1140)
    expect(area).toEqual({ x: 0, y: 60, w: 1920, h: 1080 })
  })

  it('読めないときは理由を返す', () => {
    const r = readScreenshots({ name: '', level: '', job: '', equip: [] }, { job: '', rows: [] })
    expect(r.jobId).toBeNull()
    expect(r.warnings).toContain('ジョブを読み取れませんでした')
  })
})
