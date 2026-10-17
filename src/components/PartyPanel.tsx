// パーティの一覧：メンバーの追加・削除・選択、難易度（仕様書 C1）
import { findJob, rules } from '../data/gameData'
import { DIFFICULTY_LABELS, MAX_MEMBERS, removeError, type DifficultyId, type Party } from '../logic/party'
import { retireSpBonus } from '../logic/retire'
import { spTotal, spUsed } from '../logic/skills'

interface Props {
  party: Party
  selectedId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onDifficulty: (d: DifficultyId) => void
}

export function PartyPanel({ party, selectedId, onSelect, onAdd, onRemove, onDifficulty }: Props) {
  const front = party.members.filter((m) => m.row === 'front').length
  return (
    <aside className="party-panel">
      <label className="difficulty">
        難易度
        <select value={party.difficulty} onChange={(e) => onDifficulty(e.target.value as DifficultyId)}>
          {(Object.keys(DIFFICULTY_LABELS) as DifficultyId[]).map((d) => (
            <option key={d} value={d}>{DIFFICULTY_LABELS[d]}</option>
          ))}
        </select>
      </label>

      <h2>
        パーティ <span className="count">{party.members.length}/{MAX_MEMBERS}人（前列{front}・後列{party.members.length - front}）</span>
      </h2>
      <ul className="member-list">
        {party.members.map((m) => {
          const left = spTotal(rules, m.level, retireSpBonus(rules, m.retire)) - spUsed(m.skills)
          const cannotRemove = removeError(party.members, m.id)
          return (
            <li key={m.id} className={m.id === selectedId ? 'selected' : ''}>
              <button type="button" className="member-card" onClick={() => onSelect(m.id)} aria-pressed={m.id === selectedId}>
                <span className="member-name">{m.name}</span>
                <span className="member-meta">
                  {findJob(m.jobId).name} Lv{m.level}・{m.row === 'front' ? '前列' : '後列'}
                </span>
                <span className={`member-sp${left < 0 ? ' over' : ''}`}>残りSP {left}</span>
              </button>
              <button
                type="button"
                className="remove"
                onClick={() => onRemove(m.id)}
                disabled={cannotRemove !== null}
                title={cannotRemove ?? undefined}
                aria-label={`${m.name}を外す`}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="add" onClick={onAdd} disabled={party.members.length >= MAX_MEMBERS}>
        ＋ メンバーを追加
      </button>
    </aside>
  )
}
