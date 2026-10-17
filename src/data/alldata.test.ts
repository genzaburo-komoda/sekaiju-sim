// 実際のゲームデータ全体の検査（ステップ3-1 の完了条件「全ジョブで検証エラー0件」）
import { describe, expect, it } from 'vitest'
import { rawData } from './index'
import { validateData } from './validate'

describe('ゲームデータ全体', () => {
  it('検証エラーが0件', () => {
    expect(validateData(rawData)).toEqual([])
  })

  it('9ジョブ・各21スキル', () => {
    expect(rawData.jobs).toHaveLength(9)
    for (const f of rawData.skillFiles as { skills: unknown[] }[]) expect(f.skills).toHaveLength(21)
  })
})
