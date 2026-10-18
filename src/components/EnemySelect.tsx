// 敵データから敵を選ぶ欄（階層ごとにまとめる）。ダメージ計算と戦闘シミュレーションで使う
import { enemies } from '../data/gameData'

const STRATA = [1, 2, 3, 4, 5, 6]
const KIND_LABELS = { normal: '', foe: '・FOE', boss: '・ボス' } as const

export function EnemySelect({ value, onChange, label = '敵データ' }: { value: string | null; onChange: (enemyId: string | null) => void; label?: string }) {
  return (
    <label className="wide">
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">手入力</option>
        {STRATA.map((s) => (
          <optgroup key={s} label={`第${s}階層`}>
            {enemies
              .filter((en) => en.stratum === s)
              .map((en) => (
                <option key={en.id} value={en.id}>{`${en.name}（Lv${en.level}${KIND_LABELS[en.kind]}）`}</option>
              ))}
          </optgroup>
        ))}
        <optgroup label="クエストなどで戦う敵（特殊FOE・特殊な敵）">
          {enemies
            .filter((en) => en.stratum === undefined)
            .map((en) => (
              <option key={en.id} value={en.id}>{`${en.name}（Lv${en.level}${KIND_LABELS[en.kind]}）`}</option>
            ))}
        </optgroup>
      </select>
    </label>
  )
}
