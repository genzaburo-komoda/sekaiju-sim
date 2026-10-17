// 最大ダメージの最適化（仕様書 C2・B1）。
// ダメージ計算欄で選んだ敵に対して、このメンバーの「1ターンの総ダメージの期待値」が最大になるスキルの振り方と行動を探す。
import { useState } from 'react'
import { findJob, skillsByJob } from '../data/gameData'
import { optimizeMaxDamage, optimizePartyMaxDamage, type Candidate } from '../logic/optimize'
import type { DifficultyId, Member } from '../logic/party'
import type { TargetSettings } from '../logic/predict'
import type { Allocation } from '../logic/skills'

interface Props {
  member: Member
  members: Member[]
  target: TargetSettings
  difficulty: DifficultyId
  /** 結果をこのメンバーに当てはめる（スキルの振り方と、ダメージ計算欄の攻撃・自己強化） */
  onApply: (alloc: Allocation, attackId: string, buffId: string) => void
}

interface Result {
  /** 計算したときの条件（条件が変わったら結果が古いと知らせる） */
  key: string
  candidates: Candidate[]
  party: { total: number; count: number } | null
}

export function OptimizePanel({ member, members, target, difficulty, onApply }: Props) {
  const [enemyCount, setEnemyCount] = useState(1)
  const [preBuffed, setPreBuffed] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const skills = skillsByJob[member.jobId] ?? []
  const name = (id: string) => skills.find((s) => s.id === id)?.name ?? id
  // 結果に関係する条件（スキルの振り方は結果で置き換えるので含めない）
  const key = JSON.stringify([member.id, member.jobId, member.level, member.row, member.weaponId, member.retire, target, difficulty, enemyCount, preBuffed])
  const stale = result !== null && result.key !== key

  const run = () => {
    const opts = { enemyCount, preBuffed }
    const candidates = optimizeMaxDamage(member, target, difficulty, opts)
    const party = members.length > 1 ? optimizePartyMaxDamage(members, target, difficulty, opts) : null
    setResult({ key, candidates, party: party && { total: party.total, count: members.length } })
  }

  return (
    <details className="optimize">
      <summary>この敵への最大ダメージの振り方を探す</summary>
      <p className="note">
        上で選んだ敵に、{member.name}（{findJob(member.jobId).name} Lv{member.level}・今の武器・今の隊列）が1ターンで与えるダメージの期待値が最大になるスキルの振り方を、攻撃ごとに探します。
        命中率は入れていません（命中した場合の期待値）。通常攻撃はクリティカル（5%）とダブルアタックを含みます。
      </p>
      <div className="record-fields">
        <label>
          敵の数
          <select value={enemyCount} onChange={(e) => setEnemyCount(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}体</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={preBuffed} onChange={(e) => setPreBuffed(e.target.checked)} />
          自己強化（ウォークライなど）・構え（ブシドー）を前のターンに済ませてある
        </label>
        <button type="button" onClick={run}>探す</button>
      </div>

      {result && (
        <div className={`optimize-result${stale ? ' stale' : ''}`}>
          {stale && <p className="danger">条件が変わりました。もう一度「探す」を押してください。</p>}
          {result.candidates.length === 0 ? (
            <p className="note">この武器で使える攻撃がありません。</p>
          ) : (
            <ol className="optimize-list">
              {result.candidates.slice(0, 3).map((c) => (
                <li key={`${c.attackId}|${c.buffId}`}>
                  <div className="measure-head">
                    <strong>{c.attackName}</strong>
                    <span className="damage-expected">期待値 {c.expected.toFixed(1)}</span>
                    <span className="damage-expected">（1回 {c.hitMin}〜{c.hitMax}）</span>
                  </div>
                  <div className="measure-cond">{c.breakdown}</div>
                  <div className="measure-cond">
                    振り方（SP {c.spUsed}）：
                    {Object.entries(c.alloc)
                      .map(([id, lv]) => `${name(id)} ${lv}`)
                      .join(' / ')}
                  </div>
                  <button type="button" disabled={stale} onClick={() => onApply(c.alloc, c.attackId, c.buffId)}>
                    この振り方にする
                  </button>
                </li>
              ))}
            </ol>
          )}
          {result.party && (
            <p className="note">
              パーティ全員（{result.party.count}人）をそれぞれ最大にした場合の合計：<strong>{result.party.total.toFixed(1)}</strong>
              （各メンバーの最大の和。バードの歌など味方への強化の相乗はまだ考えない）
            </p>
          )}
          <p className="note">「この振り方にする」を押すと、このメンバーのスキルは表示の振り方に置き換わります（ほかのスキルは 0 になります）。</p>
        </div>
      )}
    </details>
  )
}
