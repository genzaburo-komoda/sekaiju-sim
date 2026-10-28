// スキル振り分け（仕様書 A1・A3）。
// ＋ を押すと前提スキルも自動で取得し、必要な SP をボタンの横に出す。SP が足りなければ押せない（ゲームと同じ）。
import type { Skill } from '../data/schema'
import { prerequisitesMet, setSkillLevel, spCost, type Allocation } from '../logic/skills'

interface Props {
  skills: Skill[]
  alloc: Allocation
  spLeft: number
  onChange: (next: Allocation) => void
}

const WEAPON_LABEL: Record<string, string> = { sword: '剣', axe: '斧', bow: '弓', whip: '鞭', staff: '杖', katana: '刀', shield: '盾' }

const GROUPS: { label: string; match: (s: Skill) => boolean }[] = [
  { label: 'パッシブ', match: (s) => s.category === 'passive' },
  { label: 'アクティブ', match: (s) => s.category === 'active' },
  { label: '探索', match: (s) => s.category === 'exploration' },
]

export function SkillTree({ skills, alloc, spLeft, onChange }: Props) {
  const nameOf = (id: string) => skills.find((s) => s.id === id)?.name ?? id

  const renderRow = (skill: Skill) => {
    const lv = alloc[skill.id] ?? 0
    const upCost = lv < skill.maxLevel ? spCost(skills, alloc, skill.id, lv + 1) : 0
    const maxCost = spCost(skills, alloc, skill.id, skill.maxLevel)
    const canUp = lv < skill.maxLevel && upCost <= spLeft
    const locked = lv === 0 && !prerequisitesMet(skill, alloc)
    const tp = lv > 0 ? skill.levels?.[lv - 1]?.tp : undefined
    const set = (target: number) => onChange(setSkillLevel(skills, alloc, skill.id, target))

    return (
      <li key={skill.id} className={`skill-row${lv > 0 ? ' learned' : ''}${locked ? ' locked' : ''}`}>
        <div className="skill-info">
          <span className="skill-name">{skill.name}</span>
          {skill.weapons?.map((w) => (
            <span key={w} className="tag">{WEAPON_LABEL[w] ?? w}</span>
          ))}
          {skill.prerequisites.length > 0 && (
            <span className="skill-pre">
              前提：{skill.prerequisites.map((p) => `${nameOf(p.skillId)}Lv${p.level}`).join('、')}
            </span>
          )}
        </div>
        <div className="skill-control">
          {tp !== undefined && <span className="skill-tp">TP {tp}</span>}
          <button type="button" onClick={() => set(lv - 1)} disabled={lv === 0} aria-label={`${skill.name}を下げる`}>
            −
          </button>
          <span className="skill-lv" aria-label={`${skill.name}のレベル`}>
            {lv}<span className="skill-max">/{skill.maxLevel}</span>
          </span>
          <button
            type="button"
            onClick={() => set(lv + 1)}
            disabled={!canUp}
            title={upCost > 1 ? `前提スキル込みで SP ${upCost}` : undefined}
            aria-label={`${skill.name}を上げる`}
          >
            ＋
          </button>
          <button
            type="button"
            className="skill-maxbtn"
            onClick={() => set(skill.maxLevel)}
            disabled={lv === skill.maxLevel || maxCost > spLeft}
            title={`最大レベルまで（SP ${maxCost}）`}
          >
            最大
          </button>
          <span className="skill-cost">{upCost > 1 && canUp ? `SP${upCost}` : ''}</span>
        </div>
      </li>
    )
  }

  return (
    <div className="skill-tree">
      {GROUPS.map((g) => {
        const list = skills.filter(g.match)
        if (list.length === 0) return null
        return (
          <section key={g.label}>
            <h3>{g.label}</h3>
            <ul>{list.map(renderRow)}</ul>
          </section>
        )
      })}
    </div>
  )
}
