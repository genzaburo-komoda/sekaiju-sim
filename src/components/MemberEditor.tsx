// 選んだメンバーの編集：名前・ジョブ・レベル・隊列・引退・武器、ステータス、SP、スキル振り分け、ダメージ計算（仕様書 C1・C2・A1・A2・B4）
import { findEquipment, findJob, jobs, rules, skillsByJob, weaponsFor } from '../data/gameData'
import { weaponLabel } from '../logic/attack'
import { rowChangeError, type DifficultyId, type Member, type Row } from '../logic/party'
import type { AttackSettings, TargetSettings } from '../logic/predict'
import { RETIRE_LEVEL_CHOICES, retireSpBonus, retireStatBonus } from '../logic/retire'
import { spTotal, spUsed } from '../logic/skills'
import { displayStats, STAT_KEYS } from '../logic/stats'
import { DamagePanel } from './DamagePanel'
import { SkillTree } from './SkillTree'

interface Props {
  member: Member
  /** パーティ全員（隊列の人数の決まりを確かめるため） */
  members: Member[]
  difficulty: DifficultyId
  onChange: (next: Member) => void
  onRecord: (attack: AttackSettings, target: TargetSettings, values: number[], gameVersion: string, note: string) => void
  lastGameVersion: string
}

const STAT_LABEL = { hp: 'HP', tp: 'TP', str: 'STR', vit: 'VIT', agi: 'AGI', luc: 'LUC', tec: 'TEC' } as const

export function MemberEditor({ member, members, difficulty, onChange, onRecord, lastGameVersion }: Props) {
  const job = findJob(member.jobId)
  const skills = skillsByJob[member.jobId] ?? []
  const bonusSp = retireSpBonus(rules, member.retire)
  const bonusStat = retireStatBonus(rules, member.retire, findJob)
  const total = spTotal(rules, member.level, bonusSp)
  const used = spUsed(member.skills)
  const left = total - used
  const weapon = findEquipment(member.weaponId)
  const weapons = weaponsFor(member.jobId)
  const stats = displayStats(job, member.level, skills, member.skills, bonusStat, rules.statCap, weapon?.bonuses)

  const setLevel = (value: number) => {
    if (Number.isNaN(value)) return
    onChange({ ...member, level: Math.max(1, Math.min(rules.maxLevel, Math.round(value))) })
  }

  return (
    <div className="member-editor">
      <div className="member-fields">
        <label>
          名前
          <input value={member.name} maxLength={8} onChange={(e) => onChange({ ...member, name: e.target.value })} />
        </label>
        <label>
          ジョブ
          <select
            value={member.jobId}
            onChange={(e) => {
              // 新しいジョブが装備できない武器は外す
              const keep = weapon?.jobs.includes(e.target.value)
              onChange({ ...member, jobId: e.target.value, skills: {}, weaponId: keep ? member.weaponId : null })
            }}
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.name}</option>
            ))}
          </select>
        </label>
        <label>
          レベル
          <input
            type="number"
            min={1}
            max={rules.maxLevel}
            value={member.level}
            onChange={(e) => setLevel(e.target.valueAsNumber)}
          />
        </label>
        <fieldset className="row-toggle">
          <legend>隊列</legend>
          {(['front', 'back'] as Row[]).map((r) => {
            // 前列1〜3人・後列0〜3人の決まりを破る移動はできない
            const error = member.row === r ? null : rowChangeError(members, member.id, r)
            return (
              <label key={r} title={error ?? undefined} className={error ? 'disabled' : undefined}>
                <input
                  type="radio"
                  name={`row-${member.id}`}
                  checked={member.row === r}
                  disabled={error !== null}
                  onChange={() => onChange({ ...member, row: r })}
                />
                {r === 'front' ? '前列' : '後列'}
              </label>
            )
          })}
        </fieldset>
        <label>
          武器
          <select value={member.weaponId ?? ''} onChange={(e) => onChange({ ...member, weaponId: e.target.value || null })}>
            <option value="">素手</option>
            {weapons.map((w) => (
              <option key={w.id} value={w.id}>
                {`[${weaponLabel(w.weaponType!)}] ${w.name}（攻${w.atk}）`}
              </option>
            ))}
          </select>
        </label>
        <label>
          引退（ボーナス）
          <select
            value={member.retire?.level ?? ''}
            onChange={(e) =>
              onChange({
                ...member,
                retire: e.target.value ? { level: Number(e.target.value), jobId: member.retire?.jobId ?? member.jobId } : null,
              })
            }
          >
            <option value="">引退なし</option>
            {RETIRE_LEVEL_CHOICES.map((lv) => (
              <option key={lv} value={lv}>
                {lv < rules.maxLevel ? `Lv${lv}〜${lv + 9}` : `Lv${lv}`}で引退
              </option>
            ))}
          </select>
        </label>
        {member.retire && (
          <label>
            引退前のジョブ
            <select value={member.retire.jobId} onChange={(e) => onChange({ ...member, retire: { ...member.retire!, jobId: e.target.value } })}>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {member.retire && (
        <p className="note">
          引退ボーナス：SP+{bonusSp}
          {bonusStat && `・${STAT_LABEL[bonusStat.stat]}+${bonusStat.value}`}（値は資料からの引用で、ゲーム内で未確認）
        </p>
      )}

      <table className="stats">
        <thead>
          <tr>{STAT_KEYS.map((k) => <th key={k}>{STAT_LABEL[k]}</th>)}</tr>
        </thead>
        <tbody>
          <tr>{STAT_KEYS.map((k) => <td key={k}>{stats[k]}</td>)}</tr>
        </tbody>
      </table>
      {weapon && (
        <p className="note">
          {weapon.name}：攻撃力 {weapon.atk}
          {weapon.bonuses && `・${Object.entries(weapon.bonuses).map(([k, v]) => `${k.toUpperCase()}${v >= 0 ? '+' : ''}${v}`).join(' ')}`}
          {weapon.notes && `（${weapon.notes}）`}
        </p>
      )}
      <p className="note">HP・TP はブーストスキル込み。武器の能力補正を含む（防具は未対応）。武器の数値は資料からの引用で、ゲーム内で未確認。</p>

      <div className={`sp-counter${left < 0 ? ' over' : ''}`}>
        <span>SP</span>
        <strong>{used}</strong> / {total}
        <span className="sp-left">{left >= 0 ? `残り ${left}` : `${-left} 足りない（レベルを下げたため）`}</span>
        <button type="button" onClick={() => onChange({ ...member, skills: {} })} disabled={used === 0}>
          振り直す
        </button>
      </div>

      <SkillTree skills={skills} alloc={member.skills} spLeft={left} onChange={(next) => onChange({ ...member, skills: next })} />

      <DamagePanel
        member={member}
        members={members}
        difficulty={difficulty}
        onRecord={onRecord}
        lastGameVersion={lastGameVersion}
        onApplySkills={(skills) => onChange({ ...member, skills })}
      />
    </div>
  )
}
