// 採点・改善案・次に振るスキル・役割バランス（仕様書 C5・C6・B6・B8）。
// 基準（重み・役割・標準敵・探索のチェックリスト）は仮のもの（D13、Claude の案）。
import { useState } from 'react'
import { findJob } from '../data/gameData'
import type { Member, Party } from '../logic/party'
import {
  AXES,
  AXIS_LABELS,
  defaultRole,
  MEMBER_AXES,
  ROLE_LABELS,
  ROLES,
  scoreAll,
  SHORTAGE_THRESHOLD,
  WEIGHT_PRESETS,
  type Axis,
  type MemberAxis,
  type Role,
  type ScoreAll,
  type Weights,
} from '../logic/score'
import type { Allocation } from '../logic/skills'

interface Props {
  party: Party
  selectedId: string
  onApply: (memberId: string, alloc: Allocation) => void
}

type Result = ScoreAll & { key: string }

const pts = (v: number | null) => (v === null ? '—' : `${Math.floor(v)}点`)

/** 役割バランスのレーダーチャート（B8）。値は 0〜100、null は点数のない軸 */
function Radar({ values }: { values: Record<Axis, number | null> }) {
  const size = 240
  const c = size / 2
  const r = 80
  const point = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length
    return [c + Math.cos(a) * r * (v / 100), c + Math.sin(a) * r * (v / 100)] as const
  }
  const ring = (v: number) => AXES.map((_, i) => point(i, v).join(',')).join(' ')
  const shape = AXES.map((a, i) => point(i, values[a] ?? 0).join(',')).join(' ')
  return (
    <svg className="radar" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="役割バランス">
      {[25, 50, 75, 100].map((v) => (
        <polygon key={v} points={ring(v)} className={v === SHORTAGE_THRESHOLD ? 'radar-threshold' : 'radar-grid'} />
      ))}
      {AXES.map((a, i) => {
        const [x, y] = point(i, 100)
        const [lx, ly] = point(i, 124)
        return (
          <g key={a}>
            <line x1={c} y1={c} x2={x} y2={y} className="radar-grid" />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className={values[a] === null ? 'radar-label off' : 'radar-label'}>
              {AXIS_LABELS[a]}
            </text>
            <text x={lx} y={ly + 14} textAnchor="middle" dominantBaseline="middle" className="radar-value">
              {values[a] === null ? '—' : Math.floor(values[a]!)}
            </text>
          </g>
        )
      })}
      <polygon points={shape} className="radar-shape" />
    </svg>
  )
}

/** 採点の結果の表示 */
export function ScoreResultView({ result, stale, weights, selected, axisForNext, onAxis, onApply }: {
  result: ScoreAll
  stale: boolean
  weights: Weights
  selected: Member
  axisForNext: MemberAxis
  onAxis: (axis: MemberAxis) => void
  onApply: (memberId: string, alloc: Allocation) => void
}) {
  const apply = onApply
  return (
      <div className={`optimize-result${stale ? ' stale' : ''}`}>
        {stale && <p className="danger">条件が変わりました。もう一度「採点する」を押してください。</p>}
        <p className="score-total">
          総合 <strong>{pts(result.score.total)}</strong>
          {AXES.map((a) => (
            <span key={a} className="damage-expected">
              {AXIS_LABELS[a]} {pts(result.score.axes[a])}
              {weights[a] > 0 ? `（重み ${weights[a]}）` : '（重み 0）'}
            </span>
          ))}
        </p>

        <div className="table-scroll">
          <table className="score-table">
            <thead>
              <tr>
                <th>メンバー</th>
                <th>役割</th>
                {MEMBER_AXES.map((a) => <th key={a}>{AXIS_LABELS[a]}</th>)}
                <th>役割の最適な振り方</th>
              </tr>
            </thead>
            <tbody>
              {result.score.members.map((x) => (
                <tr key={x.member.id}>
                  <td>{x.member.name}（{findJob(x.member.jobId).name} Lv{x.member.level}）</td>
                  <td>{ROLE_LABELS[x.role]}</td>
                  {MEMBER_AXES.map((a) => (
                    <td key={a} className={x.role === a ? 'own-role' : undefined}>{pts(x.axes[a].score)}</td>
                  ))}
                  <td>
                    {x.role !== 'support' ? (
                      x.axes[x.role].optimum.value > 0 ? (
                        <button type="button" disabled={stale} onClick={() => apply(x.member.id, x.axes[x.role as MemberAxis].optimum.alloc)}>
                          {x.axes[x.role].optimum.label} にする
                        </button>
                      ) : '—'
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {result.score.reasons.length > 0 && (
          <>
            <h3 className="score-h">点数が低い理由</h3>
            <ul className="score-reasons">{result.score.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </>
        )}

        <h3 className="score-h">改善案（少ない振り替えで点数が上がる順）</h3>
        {Object.keys(result.ideas).length === 0 && <p className="note">採点できるメンバーがいません。</p>}
        {result.score.members
          .filter((x) => result.ideas[x.member.id])
          .map((x) => {
            const list = result.ideas[x.member.id]
            return (
              <div key={x.member.id} className="score-ideas">
                <strong>{x.member.name}</strong>
                {list.length === 0 ? (
                  <span className="note">　改善案はありません（今の振り方が最適）。</span>
                ) : (
                  <ol className="optimize-list">
                    {list.map((idea) => (
                      <li key={`${idea.fromId}|${idea.toId}`}>
                        {idea.fromId ? `${idea.fromName}から` : '残りの SP で'}
                        {idea.toName}へ{idea.moved > 0 ? `${idea.moved}SP 振り替える` : '振る'}と
                        <strong>
                          {' '}+{(idea.after - idea.before).toFixed(1)}点
                        </strong>
                        （{Math.floor(idea.before)} → {Math.floor(idea.after)}）
                        <button type="button" disabled={stale} onClick={() => apply(x.member.id, idea.alloc)}>当てはめる</button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )
          })}

        <h3 className="score-h">次に振るスキル（{selected.name}）</h3>
        <label>
          基準{' '}
          <select value={axisForNext} onChange={(e) => onAxis(e.target.value as MemberAxis)}>
            {MEMBER_AXES.map((a) => (
              <option key={a} value={a}>{AXIS_LABELS[a]}</option>
            ))}
          </select>
        </label>
        {(() => {
          const list = result.next
            .filter((n) => (n.gains[axisForNext] ?? 0) > 1e-6)
            .sort((a, b) => b.gains[axisForNext]! - a.gains[axisForNext]! || a.cost - b.cost)
            .slice(0, 5)
          if (list.length === 0) return <p className="note">残りの SP で{AXIS_LABELS[axisForNext]}の点数が上がるスキルはありません。</p>
          return (
            <ol className="optimize-list">
              {list.map((n) => (
                <li key={n.skillId}>
                  {n.name} を Lv{n.level} に（{n.cost}SP{n.cost > 1 ? '、前提スキルを含む' : ''}）：
                  <strong> +{n.gains[axisForNext]!.toFixed(1)}点</strong>
                  <button type="button" disabled={stale} onClick={() => apply(selected.id, n.alloc)}>振る</button>
                </li>
              ))}
            </ol>
          )
        })()}

        <h3 className="score-h">役割バランス</h3>
        <div className="radar-wrap">
          <Radar values={result.score.balance} />
          <div>
            <p className="note">
              各軸の、メンバーの中で最も高い点数（その軸の最適構築に対する割合）。探索はチェックリストの達成率。{SHORTAGE_THRESHOLD}点未満を「不足」とします（仮）。
            </p>
            {(() => {
              const short = AXES.filter((a) => result.score.balance[a] !== null && result.score.balance[a]! < SHORTAGE_THRESHOLD)
              return short.length ? <p className="danger">不足：{short.map((a) => AXIS_LABELS[a]).join('・')}</p> : <p className="note">不足している軸はありません。</p>
            })()}
            <ul className="score-reasons">
              {result.score.explore.map((e) => (
                <li key={e.id}>{e.label}：{e.have ? `${e.have}が持っている` : e.possible ? 'まだ誰も振っていない' : 'このパーティのジョブでは覚えられない'}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
  )
}

export function ScorePanel({ party, selectedId, onApply }: Props) {
  const [weights, setWeights] = useState<Weights>(WEIGHT_PRESETS[0].weights)
  const [roles, setRoles] = useState<Record<string, Role>>({})
  const [nextAxis, setNextAxis] = useState<MemberAxis | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const members = party.members
  const selected = members.find((m) => m.id === selectedId) ?? members[0]
  const roleOf = (m: Member) => roles[m.id] ?? defaultRole(m.jobId)
  const presetId = WEIGHT_PRESETS.find((p) => AXES.every((a) => p.weights[a] === weights[a]))?.id ?? ''
  const key = JSON.stringify([party, members.map(roleOf), weights, selected.id])
  const stale = result !== null && result.key !== key

  const run = () => setResult({ key, ...scoreAll(party, Object.fromEntries(members.map((m) => [m.id, roleOf(m)])), weights, selected.id) })

  const apply = (memberId: string, alloc: Allocation) => onApply(memberId, alloc)
  const selRole = roleOf(selected)
  const axisForNext: MemberAxis = nextAxis ?? (selRole === 'support' ? 'damage' : selRole)

  return (
    <section className="measure-panel score-panel">
      <h2>採点（仮の基準）</h2>
      <p className="note">
        メンバーごとに役割を決め、今の振り方の評価値を「同じジョブ・レベル・武器での最適値」で割って 100 点満点にします（火力＝最大ダメージ、状態異常＝最も付けやすい状態異常の付与率、回復＝1ターンの総回復量、耐久＝標準敵の通常攻撃を何回耐えられるか）。
        敵は標準敵（メンバーと同じレベル、耐性はすべて等倍、VIT・STR・AGI は近いレベルの敵の中央値）。耐久は防具を入れていません。総合点は軸ごとの点数の重み付き平均です。
        重み・役割・標準敵・探索の項目は仮のもので、あとで見直します。
      </p>

      <div className="record-fields">
        <label>
          重み
          <select
            value={presetId}
            onChange={(e) => {
              const p = WEIGHT_PRESETS.find((x) => x.id === e.target.value)
              if (p) setWeights(p.weights)
            }}
          >
            {presetId === '' && <option value="">手動</option>}
            {WEIGHT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {AXES.map((a) => (
          <label key={a} className="weight-field">
            {AXIS_LABELS[a]}
            <input
              type="number"
              min={0}
              max={100}
              value={weights[a]}
              onChange={(e) => {
                const v = e.target.valueAsNumber
                if (!Number.isNaN(v)) setWeights({ ...weights, [a]: Math.max(0, Math.min(100, Math.round(v))) })
              }}
            />
          </label>
        ))}
      </div>

      <div className="record-fields">
        {members.map((m) => (
          <label key={m.id}>
            {m.name}（{findJob(m.jobId).name}）の役割
            <select value={roleOf(m)} onChange={(e) => setRoles({ ...roles, [m.id]: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </label>
        ))}
        <button type="button" onClick={run}>採点する</button>
      </div>

      {result && (
        <ScoreResultView
          result={result}
          stale={stale}
          weights={weights}
          selected={selected}
          axisForNext={axisForNext}
          onAxis={setNextAxis}
          onApply={apply}
        />
      )}
    </section>
  )
}
