// レベル進行プラン（仕様書 B7）：選んだメンバーの、Lv1 から目標のレベルまでの振り順。計算は logic/levelplan.ts（Web Worker で行う）
import { useRef, useState } from 'react'
import { findJob, rules } from '../data/gameData'
import { startJob } from '../logic/battleJob'
import { planText, type LevelPlan } from '../logic/levelplan'
import type { Member, Party } from '../logic/party'
import { retireSpBonus } from '../logic/retire'
import { AXIS_LABELS, defaultRole, MEMBER_AXES, memberOptimum, type MemberAxis } from '../logic/score'
import { spTotal, spUsed } from '../logic/skills'
import { NumberField } from './NumberField'
import { Explain } from './Explain'

type TargetMode = 'free' | 'current' | 'optimum'
const TARGET_LABELS: Record<TargetMode, string> = {
  free: '目標なし（各レベルの評価値を大きく）',
  current: '今の振り方に向かう',
  optimum: '目標レベルでの最適構築に向かう',
}

const fmt = (axis: MemberAxis, v: number) =>
  axis === 'ailment' ? `${(v * 100).toFixed(1)}%` : axis === 'endurance' ? `${v.toFixed(1)}回` : axis === 'damage' ? v.toFixed(1) : String(v)

export function LevelPlanPanel({ party, member }: { party: Party; member: Member }) {
  const role = defaultRole(member.jobId)
  const [axis, setAxis] = useState<MemberAxis | null>(null)
  const [mode, setMode] = useState<TargetMode>('free')
  const [toLevel, setToLevel] = useState<number | null>(null)
  const [result, setResult] = useState<{ key: string; plan: LevelPlan; axis: MemberAxis } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const cancelRef = useRef<() => void>(() => {})

  const ax: MemberAxis = axis ?? (role === 'support' ? 'damage' : role)
  const level = toLevel ?? (mode === 'current' ? member.level : rules.maxLevel)
  const settings = { difficulty: party.difficulty, target: null, partySize: party.members.length }
  const key = JSON.stringify([member, ax, mode, level, party.difficulty, party.members.length])
  const stale = result !== null && result.key !== key
  // 「今の振り方に向かう」では、今の振り方の SP が足りるレベルより下にはできない
  const minLevel = mode === 'current' ? Math.max(1, Math.ceil((spUsed(member.skills) - spTotal(rules, 1, retireSpBonus(rules, member.retire))) / rules.spPerLevel) + 1) : 1

  const run = () => {
    const target = mode === 'free' ? null : mode === 'current' ? member.skills : memberOptimum({ ...member, level }, ax, settings).alloc
    setBusy(true)
    setMessage('')
    const { promise, cancel } = startJob({ kind: 'level-plan', member, axis: ax, target, toLevel: level, settings }, () => {})
    cancelRef.current = cancel
    promise
      .then((plan) => setResult({ key, plan, axis: ax }), (e: Error) => setMessage(e.message))
      .finally(() => setBusy(false))
  }

  return (
    <section className="measure-panel">
      <h2>レベル進行プラン（{member.name}・{findJob(member.jobId).name}）</h2>
      <Explain lead="Lv1 から目標のレベルまでの、スキルを振る順番を出します（途中の振り直しは不要）。">
        Lv1 から目標のレベルまで、どの順でスキルを振るかを出します。スキルは上げるだけで下げないので、途中で振り直しは要りません。
        各レベルで「SP 1 あたりの評価値の伸び」が最も大きい振り方を選び、もっと SP があれば大きく伸びる振り方があるときは SP を残します（近似解）。
        評価値は採点と同じで、敵は各レベルの標準敵です。武器・引退は今の設定のまま、レベルが上がっても変えません。
      </Explain>
      <div className="record-fields">
        <label>
          評価の軸
          <select value={ax} onChange={(e) => setAxis(e.target.value as MemberAxis)}>
            {MEMBER_AXES.map((a) => <option key={a} value={a}>{AXIS_LABELS[a]}</option>)}
          </select>
        </label>
        <label>
          目標
          <select value={mode} onChange={(e) => setMode(e.target.value as TargetMode)}>
            {(Object.keys(TARGET_LABELS) as TargetMode[]).map((m) => <option key={m} value={m}>{TARGET_LABELS[m]}</option>)}
          </select>
        </label>
        <NumberField label="目標のレベル" value={level} min={minLevel} max={rules.maxLevel} onChange={setToLevel} />
        <button type="button" disabled={busy} onClick={run}>計画する</button>
        {busy && <button type="button" onClick={() => cancelRef.current()}>中断</button>}
      </div>
      {message && <p className="danger" role="alert">{message}</p>}
      {result && (
        <div className={`optimize-result${stale ? ' stale' : ''}`}>
          {stale && <p className="danger">条件が変わりました。もう一度「計画する」を押してください。</p>}
          {result.plan.error ? (
            <p className="danger">{result.plan.error}</p>
          ) : (
            <>
              <div className="table-scroll">
                <table className="score-table">
                  <thead>
                    <tr>
                      <th>Lv</th>
                      <th>振るスキル</th>
                      <th>残りの SP</th>
                      <th>{AXIS_LABELS[result.axis]}の評価値</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.plan.steps.map((st) => (
                      <tr key={st.level}>
                        <td>{st.level}</td>
                        <td>{st.raised.length ? st.raised.map((r) => `${r.name} ${r.from}→${r.to}`).join('、') : '—'}</td>
                        <td>{st.banked}</td>
                        <td>{fmt(result.axis, st.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>テキストで見る</summary>
                <pre className="plan-text">{planText(`${member.name}（${findJob(member.jobId).name}）`, result.plan)}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </section>
  )
}
