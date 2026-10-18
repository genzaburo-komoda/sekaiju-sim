// Web Worker の受け答えのテスト（ブラウザの Worker の代わりに、受け取り口と送り口を差しかえて確かめる）
import { describe, expect, it, vi } from 'vitest'
import { simulateKill } from './battle'
import { newMember } from './party'
import { DEFAULT_TARGET } from './predict'
import type { BattleSetup } from './sim'

describe('戦闘シミュレーションの Worker', () => {
  it('計算の依頼を受けて、進み具合と結果を返す（結果は Worker を使わない計算と同じ）', async () => {
    let handler: ((e: { data: unknown }) => void) | null = null
    const posted: { id: number; progress?: number; result?: unknown }[] = []
    vi.stubGlobal('addEventListener', (type: string, fn: (e: { data: unknown }) => void) => {
      if (type === 'message') handler = fn
    })
    vi.stubGlobal('postMessage', (m: { id: number }) => posted.push(m))
    await import('./battle.worker')
    const m = { ...newMember([], 'swordsman'), level: 10 }
    const setup: BattleSetup = { members: [m], difficulty: 'expert', enemy: null, target: { ...DEFAULT_TARGET, level: 10 }, manual: { hp: 200, str: 0, tec: 0, agi: 0 }, enemyActions: [] }
    const plan = [{ [m.id]: 'normal' }, { [m.id]: 'normal' }]
    handler!({ data: { id: 5, job: { kind: 'kill', setup, plan, trials: 500, seed: 2 } } })
    expect(posted.some((p) => p.id === 5 && p.progress !== undefined)).toBe(true)
    expect(posted.at(-1)).toEqual({ id: 5, result: simulateKill(setup, plan, 500, 2) })
    vi.unstubAllGlobals()
  })
})
