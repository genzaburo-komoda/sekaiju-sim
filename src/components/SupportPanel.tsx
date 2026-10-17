// 状態異常・回復の最適化（仕様書 C3・C4）。
// 状態異常はダメージ計算欄で選んだ敵の耐性を使う。回復は敵に関係しない。
import { useState } from 'react'
import { findEnemy, findJob, skillsByJob } from '../data/gameData'
import type { DifficultyId, Member } from '../logic/party'
import {
  HEAL_CRITERION_LABELS,
  INFLICT_IDS,
  INFLICT_LABELS,
  inflictVuln,
  optimizeAilment,
  optimizeHeal,
  optimizePartyAilment,
  optimizePartyHeal,
  type HealCriterion,
  type InflictId,
  type SupportCandidate,
} from '../logic/support'
import type { Allocation } from '../logic/skills'

interface Props {
  member: Member
  members: Member[]
  /** ダメージ計算欄で選んだ敵（null は手入力） */
  enemyId: string | null
  difficulty: DifficultyId
  onApply: (alloc: Allocation) => void
}

const percent = (p: number) => `${(Math.round(p * 1000) / 10).toFixed(1)}%`

/** 候補の一覧（状態異常・回復で共通） */
function CandidateList({ candidates, format, stale, skillName, onApply }: {
  candidates: SupportCandidate[]
  format: (c: SupportCandidate) => string
  stale: boolean
  skillName: (id: string) => string
  onApply: (alloc: Allocation) => void
}) {
  if (candidates.length === 0) return <p className="note">このジョブ・武器で使えるスキルがありません。</p>
  return (
    <ol className="optimize-list">
      {candidates.slice(0, 3).map((c) => (
        <li key={c.skillId}>
          <div className="measure-head">
            <strong>{c.skillName}</strong>
            <span className="damage-expected">{format(c)}</span>
            <span className="damage-expected">（消費TP {c.tp}{c.requires ? `・${c.requires}` : ''}）</span>
          </div>
          <div className="measure-cond">{c.breakdown}</div>
          <div className="measure-cond">
            振り方（SP {c.spUsed}）：
            {Object.entries(c.alloc)
              .map(([id, lv]) => `${skillName(id)} ${lv}`)
              .join(' / ')}
          </div>
          <button type="button" disabled={stale} onClick={() => onApply(c.alloc)}>
            この振り方にする
          </button>
        </li>
      ))}
    </ol>
  )
}

export function SupportPanel({ member, members, enemyId, difficulty, onApply }: Props) {
  const skills = skillsByJob[member.jobId] ?? []
  const skillName = (id: string) => skills.find((s) => s.id === id)?.name ?? id
  const enemy = findEnemy(enemyId)
  const who = `${member.name}（${findJob(member.jobId).name} Lv${member.level}・今の武器）`
  const memberKey = [member.id, member.jobId, member.level, member.weaponId, member.retire, difficulty]

  // 状態異常
  const [inflict, setInflict] = useState<InflictId>('sleep')
  const [ailmentResult, setAilmentResult] = useState<{ key: string; candidates: SupportCandidate[]; party: number | null } | null>(null)
  const ailmentKey = JSON.stringify([...memberKey, enemyId, inflict, members.length > 1 ? members : null])
  const runAilment = () =>
    setAilmentResult({
      key: ailmentKey,
      candidates: optimizeAilment(member, enemyId, inflict, difficulty),
      party: members.length > 1 ? optimizePartyAilment(members, enemyId, inflict, difficulty).chance : null,
    })

  // 回復
  const [criterion, setCriterion] = useState<HealCriterion>('total')
  const [damage, setDamage] = useState(100)
  const [allMembers, setAllMembers] = useState(false)
  const [healResult, setHealResult] = useState<{ key: string; candidates: SupportCandidate[]; party: number | null } | null>(null)
  const healOpts = { criterion, damage, targets: allMembers ? members.length : 1 }
  const healKey = JSON.stringify([...memberKey, members.length, healOpts, criterion === 'total' && members.length > 1 ? members : null])
  const runHeal = () =>
    setHealResult({
      key: healKey,
      candidates: optimizeHeal(member, members.length, difficulty, healOpts),
      party: criterion === 'total' && members.length > 1 ? optimizePartyHeal(members, difficulty, healOpts).total : null,
    })
  const healFormat = (c: SupportCandidate) =>
    criterion === 'total' ? `回復量 ${c.value}` : criterion === 'per-tp' ? `TP1 あたり ${c.value.toFixed(2)}` : `合計 ${-c.value} TP`

  return (
    <>
      <details className="optimize">
        <summary>状態異常・封じを付ける確率が最大の振り方を探す</summary>
        <p className="note">
          上で選んだ敵に、{who}が1回の行動で狙いの状態異常を付ける確率が最大になるスキルの振り方を、スキルごとに探します。
          付与率 ＝ 判定値 × 呪言マスタリー × 敵の耐性 × 難易度（100% で頭打ち。LUC は関係しない）。命中率は入れていません（当たった場合の確率）。
          封じの「失敗するたびに +25%」（HD版）は、1回目なので入れていません。
        </p>
        <div className="record-fields">
          <label>
            狙う状態異常
            <select value={inflict} onChange={(e) => setInflict(e.target.value as InflictId)}>
              {INFLICT_IDS.map((id) => (
                <option key={id} value={id}>{INFLICT_LABELS[id]}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={runAilment}>探す</button>
        </div>
        <p className="note">
          敵の耐性：{enemy ? `${enemy.name} ${inflictVuln(enemy, inflict)}%（DS版の解析値。未検証）` : '敵データを選んでいないので 100%'}
          {inflict === 'petrify' && '。石化の耐性は資料に列が無いため、仮に「状態異常」の耐性を使っています（未確認）'}
        </p>
        {ailmentResult && (
          <div className={`optimize-result${ailmentResult.key !== ailmentKey ? ' stale' : ''}`}>
            {ailmentResult.key !== ailmentKey && <p className="danger">条件が変わりました。もう一度「探す」を押してください。</p>}
            <CandidateList
              candidates={ailmentResult.candidates}
              format={(c) => `付与率 ${percent(c.value)}`}
              stale={ailmentResult.key !== ailmentKey}
              skillName={skillName}
              onApply={onApply}
            />
            {ailmentResult.party !== null && (
              <p className="note">
                パーティ全員（{members.length}人）がそれぞれ最善のスキルを1回ずつ使ったとき、少なくとも1回付く確率：<strong>{percent(ailmentResult.party)}</strong>
                （それぞれ独立で、全員が同じ敵を狙うと仮定）
              </p>
            )}
          </div>
        )}
      </details>

      <details className="optimize">
        <summary>回復の効率が最大の振り方を探す</summary>
        <p className="note">
          {who}の回復スキルについて、選んだ基準で最も良い振り方をスキルごとに探します。回復量はステータスに依存せず、メディックの回復マスタリーと難易度だけで変わります。
          メディックの回復スキルの、マスタリーの途中のレベルでの回復量は、資料の2つの値（前提のレベルと Lv10）の間をマスタリーの倍率で補間した推定です。
          継続回復（癒しの子守唄・リジェネレート）と蘇生（リザレクション）は対象外です。
        </p>
        <div className="record-fields">
          <label>
            基準
            <select value={criterion} onChange={(e) => setCriterion(e.target.value as HealCriterion)}>
              {(Object.keys(HEAL_CRITERION_LABELS) as HealCriterion[]).map((c) => (
                <option key={c} value={c}>{HEAL_CRITERION_LABELS[c]}</option>
              ))}
            </select>
          </label>
          {criterion === 'min-tp' && (
            <>
              <label>
                回復したいダメージ（1人あたり）
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={damage}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber
                    if (!Number.isNaN(v)) setDamage(Math.max(1, Math.min(9999, Math.round(v))))
                  }}
                />
              </label>
              <label className="check">
                <input type="checkbox" checked={allMembers} onChange={(e) => setAllMembers(e.target.checked)} />
                パーティ全員（{members.length}人）分
              </label>
            </>
          )}
          <button type="button" onClick={runHeal}>探す</button>
        </div>
        {criterion !== 'total' && (
          <p className="note">
            {criterion === 'min-tp' ? '同じスキルを繰り返し使う場合の TP です（スキルを混ぜた組み合わせは考えていません）。' : ''}
            味方全員に回復するスキルは、パーティの人数（{members.length}人）分の回復量で数えます。
          </p>
        )}
        {healResult && (
          <div className={`optimize-result${healResult.key !== healKey ? ' stale' : ''}`}>
            {healResult.key !== healKey && <p className="danger">条件が変わりました。もう一度「探す」を押してください。</p>}
            <CandidateList candidates={healResult.candidates} format={healFormat} stale={healResult.key !== healKey} skillName={skillName} onApply={onApply} />
            {healResult.party !== null && (
              <p className="note">
                パーティ全員がそれぞれ最大の回復スキルを1回ずつ使ったときの合計：<strong>{healResult.party}</strong>（最大HPを超える分も数えています）
              </p>
            )}
          </div>
        )}
      </details>
    </>
  )
}
