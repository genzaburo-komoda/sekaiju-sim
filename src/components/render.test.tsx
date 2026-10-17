// 画面の部品が表示まで通るか（エラーで止まらないか）の検査。
// この環境ではブラウザで確かめられないことがあるので、サーバー側で HTML にしてみて、文言が出ることを確かめる
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { jobs } from '../data/gameData'
import { newMember } from '../logic/party'
import { MemberEditor } from './MemberEditor'
import { ScorePanel, ScoreResultView } from './ScorePanel'
import { scoreAll, WEIGHT_PRESETS } from '../logic/score'

describe('メンバー編集画面の表示', () => {
  it.each(jobs.map((j) => j.id))('%s Lv30 で表示できる（状態異常・回復の最適化の欄を含む）', (jobId) => {
    const member = { ...newMember([], jobId), level: 30 }
    const html = renderToString(
      <MemberEditor member={member} members={[member]} difficulty="expert" onChange={() => {}} onRecord={() => {}} lastGameVersion="" />,
    )
    expect(html).toContain('状態異常・封じを付ける確率が最大の振り方を探す')
    expect(html).toContain('回復の効率が最大の振り方を探す')
  })
})

describe('採点の欄の表示', () => {
  it('全ジョブ5人のパーティで表示できる', () => {
    const members = jobs.slice(0, 5).map((j) => ({ ...newMember([], j.id), level: 30 }))
    const html = renderToString(<ScorePanel party={{ difficulty: 'expert', members }} selectedId={members[0].id} onApply={() => {}} />)
    expect(html).toContain('採点（仮の基準）')
    expect(html).toContain('採点する')
  })

  it('採点の結果（総合点・改善案・次に振るスキル・役割バランス）を表示できる', () => {
    const members = jobs.slice(0, 5).map((j) => ({ ...newMember([], j.id), level: 30 }))
    const party = { difficulty: 'expert' as const, members }
    const weights = WEIGHT_PRESETS[0].weights
    const result = scoreAll(party, {}, weights, members[0].id)
    const html = renderToString(
      <ScoreResultView result={result} stale={false} weights={weights} selected={members[0]} axisForNext="damage" onAxis={() => {}} onApply={() => {}} />,
    )
    for (const text of ['総合', '点数が低い理由', '改善案', '次に振るスキル', '役割バランス']) expect(html).toContain(text)
  })
})
