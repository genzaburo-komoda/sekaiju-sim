// 選んだ敵の技と行動パターン（ステップ4-5）。FOE・ボスだけデータがある
import { findBehavior } from '../data/gameData'
import type { Enemy } from '../data/schema'
import { AIM_LABELS, choiceText, conditionText, ON_BOUND_LABELS, skillNamer, skillText } from '../logic/enemyai'

export function EnemyBehaviorView({ enemy }: { enemy: Enemy }) {
  const b = findBehavior(enemy.id)
  if (!b) return <p className="note">この敵の技と行動パターンのデータはありません（FOE・ボスだけ入れています）。</p>
  const name = skillNamer(b)
  return (
    <details>
      <summary>{enemy.name}の技と行動パターン</summary>
      <p className="note">
        技の数値は LP Archive（DS版のデータの解析）、技の名前と行動の条件は atwiki と LP Archive によるもので、未検証です。
        「仮置き」と書いた行は、資料に確率が無いため、使える技を等しい確率で選ぶなど仮に決めたものです。
      </p>
      <div className="table-scroll">
        <table className="score-table">
          <thead>
            <tr>
              <th>技</th>
              <th>部位</th>
              <th>効果</th>
              <th>命中・速度など</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>通常攻撃</td>
              <td>－</td>
              <td>単体に威力100%（{enemy.normalElement ? { slash: '斬', bash: '壊', pierce: '突' }[enemy.normalElement] : '属性不明'}）</td>
              <td>命中{enemy.accuracy}%{b.normalAim ? `・${AIM_LABELS[b.normalAim]}` : ''}</td>
            </tr>
            {b.skills.map((s) => {
              const t = skillText(s)
              return (
                <tr key={s.id}>
                  <td>{t.name}</td>
                  <td>{t.part}</td>
                  <td>{t.effect}{s.notes ? `（${s.notes}）` : ''}</td>
                  <td>{t.detail}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <h3 className="score-h">行動の選び方（上から順に、最初に当てはまった行）</h3>
      <ol className="optimize-list">
        {b.rules.map((r, i) => (
          <li key={i}>
            {conditionText(r.when, name)}：{choiceText(r.use, name)}
            {r.assumed && <strong>（仮置き）</strong>}
            {r.note && <span className="note">　{r.note}</span>}
          </li>
        ))}
        <li>
          それ以外：{choiceText(b.default, name)}
          {b.defaultAssumed && <strong>（仮置き）</strong>}
        </li>
      </ol>
      <p className="note">
        封じられた部位の技を選んだとき：{ON_BOUND_LABELS[b.onBound ?? 'normal']}
        {b.onBound ? '' : '（仮定）'}。{b.halveDamageChance ? `受ける攻撃ごとに ${b.halveDamageChance}% でダメージを半分にする。` : ''}
        {b.notes ?? ''}
      </p>
    </details>
  )
}
