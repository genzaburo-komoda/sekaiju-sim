// 条件付き最適化・編成の探索（仕様書 B10）。戦闘シミュレーションの欄の中に置き、同じ敵・敵の行動・ターン数を使う
import { useState } from 'react'
import { findJob, jobs, skillsByJob } from '../data/gameData'
import type { BattleJob, JobResult } from '../logic/battleJob'
import type { Member, Party } from '../logic/party'
import { DEFAULT_CONDITIONS, describeMember, type SearchResult } from '../logic/partysearch'
import type { BattleSetup } from '../logic/sim'
import { NumberField } from './NumberField'

interface Props {
  party: Party
  /** 敵・敵の行動（耐久の表）・防具を入れた戦闘の設定 */
  setup: BattleSetup
  maxTurns: number
  enduranceTurns: number
  seed: number
  busy: boolean
  launch: <J extends BattleJob>(label: string, job: J, done: (r: JobResult<J>) => void) => void
  /** 見つけた編成をパーティに当てはめる */
  onApply: (members: Member[]) => void
}

const ALL_SKILLS = jobs.flatMap((j) => (skillsByJob[j.id] ?? []).map((s) => ({ id: s.id, label: `${s.name}（${j.name}）` })))
const pct = (p: number) => `${(p * 100).toFixed(0)}%`

export function PartySearchSection({ party, setup, maxTurns, enduranceTurns, seed, busy, launch, onApply }: Props) {
  const members = party.members
  const [fixed, setFixed] = useState<Record<string, boolean>>({})
  const [noDup, setNoDup] = useState(DEFAULT_CONDITIONS.noDuplicateJobs)
  const [excluded, setExcluded] = useState<string[]>([])
  const [required, setRequired] = useState<string[]>([])
  const [weights, setWeights] = useState(DEFAULT_CONDITIONS.weights)
  const [trials, setTrials] = useState(DEFAULT_CONDITIONS.trials)
  const [beamWidth, setBeamWidth] = useState(DEFAULT_CONDITIONS.beamWidth)
  const [result, setResult] = useState<{ key: string; r: SearchResult } | null>(null)

  const cond = {
    ...DEFAULT_CONDITIONS,
    fixed: members.map((m) => fixed[m.id] ?? false),
    noDuplicateJobs: noDup,
    excludedJobs: excluded,
    requiredSkills: required,
    weights,
    maxTurns,
    enduranceTurns,
    trials,
    seed,
    beamWidth,
  }
  const key = JSON.stringify([setup, cond])
  const stale = result !== null && result.key !== key
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  return (
    <details>
      <summary>最適な編成を探す（条件付き）</summary>
      <p className="note">
        上の敵に対して、「撃破までのターン数（期待値）」と「耐久（上の敵の行動に、決めたターン数のあと生き残る確率のメンバー平均）」の重み付き平均が最も高い編成を探します。
        固定しないメンバーは、ジョブ・振り方（火力・支援・回復・盾の候補）・武器を探します。武器は入手時期に関係なく、そのジョブが持てる最も強いもの、防具は装備2〜4の枠ごとに、まだ使っていない種類で防御力が最も高いものです。隊列とレベルは今の枠のままです。
        枠を1つずつ埋めていく近似解です。耐久を見るターン数は上の「耐久」の欄、撃破のターン数の上限は上の「探すターン数の上限」を使います。
      </p>
      <div className="record-fields">
        {members.map((m) => (
          <label key={m.id} className="check">
            <input type="checkbox" checked={fixed[m.id] ?? false} onChange={(e) => setFixed({ ...fixed, [m.id]: e.target.checked })} />
            {m.name}（{findJob(m.jobId).name}）を固定
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={noDup} onChange={(e) => setNoDup(e.target.checked)} />
          ジョブの重複なし
        </label>
      </div>
      <fieldset>
        <legend>使わないジョブ</legend>
        <div className="record-fields">
          {jobs.map((j) => (
            <label key={j.id} className="check">
              <input type="checkbox" checked={excluded.includes(j.id)} onChange={() => setExcluded(toggle(excluded, j.id))} />
              {j.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="record-fields">
        <label>
          必須のスキル（パーティの誰かが持つ）
          <select value="" onChange={(e) => e.target.value && setRequired(toggle(required, e.target.value))}>
            <option value="">足す…</option>
            {ALL_SKILLS.filter((s) => !required.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        {required.map((id) => (
          <button key={id} type="button" onClick={() => setRequired(required.filter((x) => x !== id))}>
            {ALL_SKILLS.find((s) => s.id === id)?.label} ×
          </button>
        ))}
      </div>
      <div className="record-fields">
        <NumberField label="撃破の重み" value={weights.kill} min={0} max={100} onChange={(kill) => setWeights({ ...weights, kill })} />
        <NumberField label="耐久の重み" value={weights.endurance} min={0} max={100} onChange={(endurance) => setWeights({ ...weights, endurance })} />
        <NumberField label="耐久の試行回数（1編成あたり）" value={trials} min={50} max={5000} onChange={setTrials} />
        <NumberField label="残す編成の数" value={beamWidth} min={1} max={20} onChange={setBeamWidth} />
        <button type="button" disabled={busy} onClick={() => launch('編成を探しています', { kind: 'party-search', setup, cond }, (r) => setResult({ key, r }))}>
          編成を探す
        </button>
      </div>
      {result && (
        <div className={`optimize-result${stale ? ' stale' : ''}`}>
          {stale && <p className="danger">条件が変わりました。もう一度「編成を探す」を押してください。</p>}
          {result.r.error ? (
            <p className="danger">{result.r.error}</p>
          ) : (
            <>
              <p className="note">{result.r.evaluated}通りの編成を評価しました。</p>
              <ol className="optimize-list">
                {result.r.best.map((p, i) => (
                  <li key={i}>
                    <strong>{(p.score * 100).toFixed(1)}点</strong>
                    （撃破 {p.killTurn !== null ? `${p.killTurn}ターン` : `${maxTurns}ターンで倒せない（HP の ${pct(p.hpDealt)} を削る）`}・{enduranceTurns}ターン後の生存 {pct(p.survive)}）
                    <br />
                    {p.members.map((m, k) => describeMember(m, p.kinds[k])).join(' ／ ')}
                    <button type="button" disabled={stale} onClick={() => onApply(p.members)}>この編成にする</button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </details>
  )
}
