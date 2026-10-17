// 全ジョブのデータで計算できるかのテスト（ステップ3-1）。2026-10-12 の実測値も、ゲームの画面と同じ条件で照合する
import { describe, expect, it } from 'vitest'
import { equipment, findEnemy, jobs, weaponsFor } from '../data/gameData'
import { optimizeMaxDamage } from './optimize'
import { newMember, type Member } from './party'
import { DEFAULT_ATTACK, predict, targetFromEnemy } from './predict'

const mole = targetFromEnemy(findEnemy('mole')!) // ひっかきモグラ Lv3・VIT15
const rat = targetFromEnemy(findEnemy('treerat')!) // 森ネズミ Lv2・VIT14

function member(jobId: string, over: Partial<Member>): Member {
  return { ...newMember([], jobId), ...over }
}

describe('実測値（2026-10-12、Steam版・EXPERT）との照合', () => {
  it('ダークハンター Lv14・後列・ワインドウィップ・鞭マスタリー4 のアナコンダLv1 → 森ネズミに 73・73・71', () => {
    const m = member('dark-hunter', {
      level: 14, row: 'back', weaponId: equipment.find((e) => e.name === 'ワインドウィップ')!.id,
      skills: { 'dark-hunter-whip-mastery': 4, 'dark-hunter-anaconda': 1, 'dark-hunter-arm-bondage': 8 },
    })
    const r = predict(m, { ...DEFAULT_ATTACK, attackId: 'dark-hunter-anaconda' }, rat, 'expert').result!
    for (const v of [73, 73, 71]) {
      expect(v).toBeGreaterThanOrEqual(r.min)
      expect(v).toBeLessThanOrEqual(r.max)
    }
  })

  it('カースメーカー Lv8・後列・幸運の杖の通常攻撃 → ひっかきモグラに 39', () => {
    const m = member('hexer', { level: 8, row: 'back', weaponId: equipment.find((e) => e.name === '幸運の杖')!.id })
    const r = predict(m, DEFAULT_ATTACK, mole, 'expert').result!
    expect(39).toBeGreaterThanOrEqual(r.min)
    expect(39).toBeLessThanOrEqual(r.max)
  })
})

describe('全ジョブで最適化が動く', () => {
  for (const job of jobs) {
    it(`${job.name}：装備できる一番強い武器・Lv50 で候補が出る`, () => {
      const weapons = weaponsFor(job.id)
      const best = weapons.reduce((a, b) => ((b.atk ?? 0) > (a.atk ?? 0) ? b : a), weapons[0])
      const m = member(job.id, { level: 50, weaponId: best?.id ?? null })
      const r = optimizeMaxDamage(m, { ...rat, level: 50 }, 'expert', { enemyCount: 3, preBuffed: true })
      expect(r.length).toBeGreaterThan(0)
      for (const c of r) expect(Number.isFinite(c.expected) && c.expected > 0).toBe(true)
    })
  }

  it('ブシドーの構えスキルは「構え済み」を選んだときだけ候補になる', () => {
    const m = member('bushido', { level: 50, weaponId: equipment.find((e) => e.name === 'モノホシ竿')!.id })
    const t = { ...rat, level: 50 }
    const off = optimizeMaxDamage(m, t, 'expert', { enemyCount: 1, preBuffed: false })
    const on = optimizeMaxDamage(m, t, 'expert', { enemyCount: 1, preBuffed: true })
    expect(off.some((c) => c.attackId === 'bushido-zanba')).toBe(false)
    expect(on.some((c) => c.attackId === 'bushido-zanba')).toBe(true)
  })

  it('アルケミストの全体術式は敵の数だけ当たる（敵3体なら1体のときの3倍）', () => {
    const m = member('alchemist', { level: 50 })
    const t = { ...rat, level: 50 }
    const one = optimizeMaxDamage(m, t, 'expert', { enemyCount: 1, preBuffed: false }).find((c) => c.attackId === 'alchemist-inferno')!
    const three = optimizeMaxDamage(m, t, 'expert', { enemyCount: 3, preBuffed: false }).find((c) => c.attackId === 'alchemist-inferno')!
    expect(three.expected).toBeCloseTo(one.expected * 3)
  })
})
