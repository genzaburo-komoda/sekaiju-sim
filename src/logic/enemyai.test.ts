// 敵の技と行動パターン（ステップ4-5）のデータと説明文
import { describe, expect, it } from 'vitest'
import { enemies, enemyBehaviors, findBehavior } from '../data/gameData'
import { rawData } from '../data/index'
import { validateData } from '../data/validate'
import { choiceText, conditionText, effectText, skillNamer } from './enemyai'

describe('敵の技と行動パターン（4-5）', () => {
  it('FOE・ボス46体すべてにデータがあり、検査エラーが0件', () => {
    expect(validateData(rawData)).toEqual([])
    const foes = enemies.filter((e) => e.kind !== 'normal')
    expect(foes).toHaveLength(46)
    for (const e of foes) expect(findBehavior(e.id), e.name).toBeDefined()
  })

  it('検査は、存在しない技を表に書いたら見つける', () => {
    const broken = structuredClone(rawData.enemyBehaviors) as { items: { default: { skill: string; weight: number }[] }[] }
    broken.items[0].default.push({ skill: 'no-such-skill', weight: 1 })
    expect(validateData({ ...rawData, enemyBehaviors: broken }).some((m) => m.includes('no-such-skill'))).toBe(true)
  })

  it('全員の通常攻撃の属性が入っている', () => {
    for (const e of enemies) expect(e.normalElement, e.name).toBeDefined()
  })

  it('偉大なる赤竜：開幕と 4n+1 ターン目にファイアブレス（atwiki）', () => {
    const b = findBehavior('wyrm')!
    const r = b.rules[0]
    expect(r.when.turnMod).toEqual([4, 1])
    expect(choiceText(r.use, skillNamer(b))).toBe('ファイアブレス 100%')
    expect(conditionText(r.when, skillNamer(b))).toBe('1・5・9…ターン目（4n+1）')
  })

  it('フォレスト・セル：固定の属性攻撃はエクスプロウド＞フリージング＞サンダーストームの順（atwiki 744）', () => {
    const b = findBehavior('primevil')!
    const fixed = b.rules.filter((r) => r.when.turnMod).map((r) => r.use[0].skill)
    expect(fixed).toEqual(['explode', 'frigid', 'storm'])
    // 王の威厳は強化10以上、続けては使わない
    expect(b.rules.find((r) => r.use[0].skill === 'resolve')!.when).toEqual({ partyBuffsAtLeast: 10, notPrev: 'resolve' })
  })

  it('世界樹の王：atwiki の行動パターン表どおりで、仮置きでない', () => {
    const b = findBehavior('etreant')!
    expect(b.defaultAssumed).toBeUndefined()
    expect(b.rules.every((r) => !r.assumed)).toBe(true)
    expect(choiceText(b.rules.find((r) => r.when.boundExactly?.join() === 'leg')!.use, skillNamer(b))).toBe('サウザンドネイル 50%・千樹の守り 50%')
  })

  it('説明文：複合属性・付与・弱体', () => {
    const lance = findBehavior('drake')!.skills.find((s) => s.id === 'icelance')!
    expect(effectText(lance.effects[0])).toBe('単体に突165%＋氷100%')
    const venom = findBehavior('assassin')!.skills.find((s) => s.id === 'venom')!
    expect(effectText(venom.effects[0])).toBe('単体に突 威力70%（＋毒か麻痺（50%、毒ダメージ113））')
    const gaze = findBehavior('cotrangl')!.skills.find((s) => s.id === 'ice-gaze')!
    expect(effectText(gaze.effects[0])).toBe('5ターン、味方全体の攻撃力 -25%')
  })

  it('仮置きの行は印が付いている（確率が資料にある雷竜クローンは付かない）', () => {
    expect(findBehavior('dragoid')!.defaultAssumed).toBeUndefined()
    expect(findBehavior('kuyutha')!.defaultAssumed).toBe(true)
    expect(enemyBehaviors.filter((b) => b.defaultAssumed).length).toBeGreaterThan(30)
  })
})
