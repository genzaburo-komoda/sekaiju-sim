// 戦闘シミュレーション（仕様書 B2・B3・B9）：撃破までの最小ターン数、確率分布、耐久。条件付きの編成の探索（B10）もここに置く。
// 敵は1体。計算の中身は logic/sim.ts・logic/battle.ts。重い計算は Web Worker で行う（logic/battleJob.ts）
import { useRef, useState } from 'react'
import { findBehavior, findEnemy } from '../data/gameData'
import { ELEMENT_LABELS } from '../logic/attack'
import { defaultPolicy, runPlan, type EnduranceResult, type KillDistribution, type Plan, type SafeSearchResult } from '../logic/battle'
import { startJob, type BattleJob, type JobResult } from '../logic/battleJob'
import type { ElementId } from '../logic/damage'
import type { Member, Party } from '../logic/party'
import { DEFAULT_TARGET, targetFromEnemy } from '../logic/predict'
import { armorDefense } from '../logic/equip'
import { partyActions, type BattleSetup, type EnemyAction, type SimAction, type TurnLog } from '../logic/sim'
import { INFLICT_LABELS, type InflictId } from '../logic/support'
import { EnemyBehaviorView } from './EnemyBehaviorView'
import { EnemySelect } from './EnemySelect'
import { NumberField } from './NumberField'
import { PartySearchSection } from './PartySearchSection'

const ELEMENTS: ElementId[] = ['slash', 'bash', 'pierce', 'fire', 'ice', 'volt']
const TARGET_LABELS: Record<EnemyAction['target'], string> = { single: '単体', row: '一列', all: '全体' }
const KIND_LABELS: Record<SimAction['kind'], string> = { attack: '攻撃', buff: '強化', debuff: '弱体', heal: '回復', ailment: '状態異常', defend: '', cure: '治療', step: '補助' }

const pct = (p: number) => `${(p * 100).toFixed(1)}%`

interface Manual {
  level: number
  vit: number
  hp: number
  str: number
  tec: number
  agi: number
}
const DEFAULT_MANUAL: Manual = { level: 10, vit: 10, hp: 500, str: 30, tec: 10, agi: 20 }

const normalAttack = (accuracy: number): EnemyAction => ({ name: '通常攻撃', attack: 'str', element: 'bash', power: 100, target: 'single', weight: 100, accuracy, normal: true })

/** 縦棒のグラフ（確率や割合。値は 0〜1） */
function Bars({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const w = Math.max(240, data.length * 22)
  const h = 120
  const bw = w / Math.max(1, data.length)
  const max = Math.max(1e-9, ...data.map((d) => d.value))
  return (
    <div className="table-scroll">
      <svg className="bars" viewBox={`0 0 ${w} ${h + 30}`} width={w} role="img" aria-label={label}>
        {data.map((d, i) => {
          const bh = (d.value / max) * h
          return (
            <g key={i}>
              <rect x={i * bw + 2} y={h - bh} width={Math.max(1, bw - 4)} height={bh} className="bar">
                <title>{`${d.label}：${pct(d.value)}`}</title>
              </rect>
              {(data.length <= 12 || i % Math.ceil(data.length / 12) === 0) && (
                <text x={i * bw + bw / 2} y={h + 14} textAnchor="middle" className="bar-label">{d.label}</text>
              )}
            </g>
          )
        })}
        <line x1={0} y1={h} x2={w} y2={h} className="bar-axis" />
      </svg>
    </div>
  )
}

type EnemyMode = 'ai' | 'table' | 'none'
const ENEMY_MODE_LABELS: Record<EnemyMode, string> = {
  ai: '行動パターン（データ）で行動する',
  table: '耐久の欄の表（手入力）で行動する',
  none: '行動しない（撃破ターンだけを見る）',
}

/** ターンごとの記録の表。showHp：味方の HP を出す（耐久）。both：敵の HP と味方の HP・TP を出す（敵が行動する撃破の計算） */
function TurnTable({ logs, members, showHp, both = false }: { logs: TurnLog[]; members: Member[]; showHp: boolean; both?: boolean }) {
  return (
    <div className="table-scroll">
      <table className="score-table battle-table">
        <thead>
          <tr>
            <th>ターン</th>
            <th>行動（行動した順）</th>
            {!showHp && <th>敵の残りHP</th>}
            {members.map((m) => <th key={m.id}>{m.name}{both ? ' HP／TP' : showHp ? ' HP' : ' TP'}</th>)}
            <th>強化・弱体（ターンの終わり）</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.turn}>
              <td>{l.turn}</td>
              <td>
                <ol className="battle-entries">
                  {l.entries.map((e, i) => (
                    <li key={i}>
                      {e.actor}：{e.action}
                      {e.target ? `→${e.target}` : ''}
                      {e.damage !== undefined ? ` ${Math.round(e.damage * 10) / 10}` : ''}
                      {e.healed !== undefined ? ` 回復 ${e.healed}` : ''}
                      {e.note ? `（${e.note}）` : ''}
                      {e.fallback && <span className="danger">（{e.fallback}）</span>}
                    </li>
                  ))}
                </ol>
              </td>
              {!showHp && <td>{Math.ceil(l.enemyHp)}</td>}
              {members.map((m) => <td key={m.id}>{both ? `${Math.ceil(l.hp[m.id])}／${l.tp[m.id]}` : showHp ? l.hp[m.id] : l.tp[m.id]}</td>)}
              <td>
                {members
                  .filter((m) => l.effects[m.id]?.length)
                  .map((m) => `${m.name}：${l.effects[m.id].join('・')}`)
                  .concat(l.effects.enemy?.length ? [`敵：${l.effects.enemy.map((x) => INFLICT_LABELS[x as InflictId] ?? x).join('・')}`] : [])
                  .join(' ／ ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BattlePanel({ party, onApplyParty }: { party: Party; onApplyParty: (members: Member[]) => void }) {
  const members = party.members
  const [enemyId, setEnemyId] = useState<string | null>(null)
  const [manual, setManual] = useState<Manual>(DEFAULT_MANUAL)
  const [plan, setPlan] = useState<Plan>([{}, {}, {}])
  const [maxTurns, setMaxTurns] = useState(15)
  const [message, setMessage] = useState('')
  const [trials, setTrials] = useState(10000)
  const [seed, setSeed] = useState(1)
  const [kill, setKill] = useState<{ key: string; r: KillDistribution } | null>(null)
  const [enemyActions, setEnemyActions] = useState<EnemyAction[] | null>(null)
  const [enemyModeSel, setEnemyModeSel] = useState<EnemyMode | null>(null)
  const [wipeLimit, setWipeLimit] = useState(5)
  const [safeTrials, setSafeTrials] = useState(300)
  const [safe, setSafe] = useState<{ key: string; r: SafeSearchResult } | null>(null)
  const [policies, setPolicies] = useState<Record<string, string>>({})
  const [endTurns, setEndTurns] = useState(10)
  const [endTrials, setEndTrials] = useState(3000)
  const [endurance, setEndurance] = useState<{ key: string; r: EnduranceResult; sample: TurnLog[] } | null>(null)
  const [busy, setBusy] = useState<{ label: string; progress: number } | null>(null)
  const cancelRef = useRef<() => void>(() => {})

  const enemy = findEnemy(enemyId) ?? null
  const actions = enemyActions ?? [normalAttack(enemy?.accuracy ?? 90)]
  const hasBehavior = !!findBehavior(enemy?.id)
  // 敵の行動：行動パターンのデータがあればそれを、なければ行動しない（撃破ターンだけ）を初期値にする
  const enemyMode: EnemyMode = enemyModeSel === 'ai' && !hasBehavior ? 'none' : (enemyModeSel ?? (hasBehavior ? 'ai' : 'none'))
  const enemyActs = enemyMode !== 'none'
  const setup: BattleSetup = {
    members,
    difficulty: party.difficulty,
    enemy,
    target: enemy ? targetFromEnemy(enemy) : { ...DEFAULT_TARGET, level: manual.level, vit: manual.vit },
    manual: { hp: manual.hp, str: manual.str, tec: manual.tec, agi: manual.agi },
    enemyActions: enemyMode === 'table' ? actions : [],
    enemyAi: enemyMode === 'ai',
  }
  const actionsOf = partyActions(members)
  // メンバーが変わって無くなった行動は通常攻撃にする
  const fullPlan: Plan = plan.map((turn) => Object.fromEntries(members.map((m) => [m.id, actionsOf.get(m.id)!.some((a) => a.id === turn[m.id]) ? turn[m.id] : 'normal'])))
  const run = runPlan(setup, fullPlan)
  const planKey = JSON.stringify([setup, fullPlan])
  const policyOf = (m: Member) => (actionsOf.get(m.id)!.some((a) => a.id === policies[m.id]) ? policies[m.id] : defaultPolicy(m))
  // 耐久は敵が行動しないと意味が無いので、「行動しない」のときは表（手入力）を使う
  const endSetup: BattleSetup = { ...setup, enemyActions: actions, enemyAi: enemyMode === 'ai' }
  const endPolicies = Object.fromEntries(members.map((m) => [m.id, policyOf(m)]))
  const endKey = JSON.stringify([endSetup, endPolicies, endTurns, endTrials, seed])

  function launch<J extends BattleJob>(label: string, job: J, done: (r: JobResult<J>) => void) {
    setBusy({ label, progress: 0 })
    setMessage('')
    const { promise, cancel } = startJob(job, (progress) => setBusy({ label, progress }))
    cancelRef.current = cancel
    promise.then(done, (e: Error) => setMessage(e.message)).finally(() => setBusy(null))
  }

  const setTurnAction = (t: number, memberId: string, actionId: string) => setPlan(plan.map((turn, i) => (i === t ? { ...turn, [memberId]: actionId } : turn)))
  const setAction = (i: number, patch: Partial<EnemyAction>) => setEnemyActions(actions.map((a, k) => (k === i ? { ...a, ...patch } : a)))

  return (
    <section className="measure-panel battle-panel">
      <h2>戦闘シミュレーション</h2>
      <p className="note">
        敵1体との戦いを、ターンごとに計算します。行動順（AGI × 行動の速度補正）、強化・弱体の持続（使ったターンを含めて数える。バードの歌は戦闘終了まで）と3つまでの枠、TP の消費を追跡します。
        味方の攻撃の命中率は入れていません（味方の基礎命中が分からないため、当たった場合）。
      </p>

      <fieldset className="battle-enemy">
        <legend>敵</legend>
        <EnemySelect
          value={enemyId}
          onChange={(id) => {
            setEnemyId(id)
            setEnemyActions(null)
            setEnemyModeSel(null)
          }}
        />
        {enemy ? (
          <p className="note wide">
            Lv{enemy.level}・HP {enemy.hp}・STR {enemy.str}・TEC {enemy.tec}・VIT {enemy.vit}・AGI {enemy.agi}
          </p>
        ) : null}
        <label className="wide">
          敵の行動（撃破ターン・確率分布・耐久）
          <select value={enemyMode} onChange={(e) => setEnemyModeSel(e.target.value as EnemyMode)}>
            {(Object.keys(ENEMY_MODE_LABELS) as EnemyMode[])
              .filter((m) => m !== 'ai' || hasBehavior)
              .map((m) => <option key={m} value={m}>{ENEMY_MODE_LABELS[m]}</option>)}
          </select>
        </label>
        {enemy ? (
          <div className="wide">
            <EnemyBehaviorView enemy={enemy} />
          </div>
        ) : (
          <div className="record-fields">
            {(['level', 'hp', 'str', 'tec', 'vit', 'agi'] as const).map((k) => (
              <NumberField key={k} label={k === 'level' ? 'レベル' : k.toUpperCase()} value={manual[k]} min={k === 'hp' || k === 'level' ? 1 : 0} max={k === 'hp' ? 999999 : 999} onChange={(v) => setManual({ ...manual, [k]: v })} />
            ))}
          </div>
        )}
      </fieldset>

      {busy && (
        <p className="battle-busy" role="status">
          {busy.label}… {Math.round(busy.progress * 100)}%
          <progress value={busy.progress} max={1} />
          <button type="button" onClick={() => cancelRef.current()}>中断</button>
        </p>
      )}
      {message && <p className="danger" role="alert">{message}</p>}

      <details open>
        <summary>撃破までのターン数と行動の計画</summary>
        <p className="note">
          表の行動を選ぶと、その計画を期待値で計算します。「最小ターン数を探す」は、期待値で最も早く倒せる計画を探します（近似解：1ターンに1〜2人の行動を変えた候補を試し、よいものを残して進める）。
          攻撃に効く強化・弱体（攻撃力・与ダメージ・敵の防御力）と攻撃だけを候補にします。TP が足りない・構えがない・封じられたときは通常攻撃になります。
          敵が行動するとき、期待値の計算では、敵は条件に当てはまった表の中で最も選ばれやすい技を使い、ダメージは狙われる確率で割り振り、状態異常は付けません（状態異常・封じ・即死は下の確率分布と耐久で乱数で判定します）。
        </p>
        <div className="record-fields">
          <NumberField label="探すターン数の上限" value={maxTurns} min={1} max={50} onChange={setMaxTurns} />
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              launch('最小ターン数を探しています', { kind: 'min-turns', setup, maxTurns }, (r) => {
                if (r.plan.length) setPlan(r.plan)
                setMessage(r.killTurn === null ? `${maxTurns}ターン以内には倒せませんでした（期待値）。一番 HP を削れた計画を表に入れました。` : '')
              })
            }
          >
            最小ターン数を探す
          </button>
          <button type="button" onClick={() => setPlan([...plan, { ...(plan.at(-1) ?? {}) }])}>ターンを足す</button>
          <button type="button" disabled={plan.length <= 1} onClick={() => setPlan(plan.slice(0, -1))}>最後のターンを消す</button>
        </div>
        {enemyActs && (
          <div className="optimize-result">
            <h3 className="score-h">全滅率の上限つきで最短を探す</h3>
            <p className="note">
              敵が行動するときは、最短の計画が危ないことがあります。「味方の危なさ」をどれだけ重く見るかを5通りに変えて計画を作り（重いほど防御・回復・守りの強化を使う）、
              それぞれを乱数で戦わせて、全滅率が上限以下のうち倒すまでのターン数の期待値が最も短い計画を選びます（倒せなかった回は上限＋1 ターンとして数えます）。近似解です。
            </p>
            <div className="record-fields">
              <NumberField label="全滅率の上限（%）" value={wipeLimit} min={0} max={100} onChange={setWipeLimit} />
              <NumberField label="試行回数（1計画あたり）" value={safeTrials} min={50} max={5000} onChange={setSafeTrials} />
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  const key = JSON.stringify([setup, maxTurns, wipeLimit, safeTrials, seed])
                  launch('全滅率の上限つきで探しています', { kind: 'safe-min-turns', setup, maxTurns, wipeLimit: wipeLimit / 100, trials: safeTrials, seed }, (r) => {
                    setSafe({ key, r })
                    if (r.best >= 0) setPlan(r.candidates[r.best].plan)
                  })
                }}
              >
                探す
              </button>
            </div>
            {safe && (
              <>
                {safe.key !== JSON.stringify([setup, maxTurns, wipeLimit, safeTrials, seed]) && <p className="danger">条件が変わりました。もう一度「探す」を押してください。</p>}
                {!safe.r.satisfied && <p className="danger">全滅率が上限以下の計画は見つかりませんでした。全滅率が最も低い計画を表に入れました。</p>}
                <div className="table-scroll">
                  <table className="score-table">
                    <thead>
                      <tr>
                        <th>危なさの重み</th>
                        <th>撃破（期待値の計算）</th>
                        <th>倒すまでの期待値</th>
                        <th>{maxTurns}ターン以内に倒せる</th>
                        <th>全滅率</th>
                        <th>だれかが倒れる</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {safe.r.candidates.map((c, i) => (
                        <tr key={i} className={i === safe.r.best ? 'best' : undefined}>
                          <td>{c.risk === 0 ? '0（最短だけ）' : c.risk}{i === safe.r.best ? '（選んだ計画）' : ''}</td>
                          <td>{c.killTurn !== null ? `${c.killTurn}ターン` : '倒せない'}</td>
                          <td>{c.check.expectedTurns.toFixed(2)}ターン</td>
                          <td>{pct(c.check.killRate)}</td>
                          <td className={c.check.wipeRate > safe.r.wipeLimit ? 'danger' : undefined}>{pct(c.check.wipeRate)}</td>
                          <td>{pct(c.check.anyDownRate)}</td>
                          <td><button type="button" onClick={() => setPlan(c.plan)}>この計画にする</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <div className="table-scroll">
          <table className="score-table battle-plan">
            <thead>
              <tr>
                <th>ターン</th>
                {members.map((m) => <th key={m.id}>{m.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {fullPlan.map((turn, t) => (
                <tr key={t}>
                  <td>{t + 1}</td>
                  {members.map((m) => (
                    <td key={m.id}>
                      <select value={turn[m.id]} onChange={(e) => setTurnAction(t, m.id, e.target.value)} aria-label={`${t + 1}ターン目の${m.name}の行動`}>
                        {actionsOf.get(m.id)!.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {a.kind !== 'defend' && a.kind !== 'attack' ? `（${KIND_LABELS[a.kind]}）` : ''}
                            {a.tp ? ` TP${a.tp}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="score-total">
          {run.killTurn !== null ? (
            <>
              期待値で <strong>{run.killTurn}ターン目</strong> に撃破
            </>
          ) : (
            <>計画のターン数では倒せません（残りHP {Math.ceil(run.state.enemy.hp)} ／ {run.state.enemy.maxHp}）</>
          )}
        </p>
        <TurnTable logs={run.logs} members={members} showHp={false} both={enemyActs} />
      </details>

      <details>
        <summary>確率分布（乱数・クリティカル・状態異常の成否）</summary>
        <p className="note">
          上の計画どおりに、乱数を引いて何度も戦います（モンテカルロ法）。同じシード・同じ条件なら同じ結果になります。
          状態異常は付与率で判定し、睡眠中の敵は物理攻撃を 1.5倍受け、攻撃を受けると起きるとしています。敵を倒したあとも計画のターン数まで続けて総ダメージを数えます。
        </p>
        <div className="record-fields">
          <NumberField label="試行回数" value={trials} min={100} max={100000} onChange={setTrials} />
          <NumberField label="シード" value={seed} min={0} max={2147483647} onChange={setSeed} />
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              const key = JSON.stringify([planKey, trials, seed])
              launch('試行しています', { kind: 'kill', setup, plan: fullPlan, trials, seed }, (r) => setKill({ key, r }))
            }}
          >
            試行する
          </button>
        </div>
        {kill && (
          <div className={`optimize-result${kill.key !== JSON.stringify([planKey, trials, seed]) ? ' stale' : ''}`}>
            {kill.key !== JSON.stringify([planKey, trials, seed]) && <p className="danger">条件が変わりました。もう一度「試行する」を押してください。</p>}
            <h3 className="score-h">n ターン目までに倒せる確率（{kill.r.trials}回、シード {kill.r.seed}）</h3>
            <Bars data={kill.r.killBy.map((p, i) => ({ label: String(i + 1), value: p }))} label="n ターン目までに倒せる確率" />
            <p className="note">{kill.r.killBy.map((p, i) => `${i + 1}T ${pct(p)}`).join('　')}</p>
            <h3 className="score-h">{kill.r.turns}ターンの総ダメージの分布</h3>
            <Bars data={kill.r.histogram.map((b) => ({ label: String(b.lo), value: b.p }))} label="総ダメージの分布" />
            <p className="note">
              平均 {kill.r.mean.toFixed(1)}・最小 {kill.r.min}・最大 {kill.r.max}（敵の HP {run.state.enemy.maxHp}）
              {Object.keys(kill.r.inflicted).length > 0 &&
                `。計画の間に付いた状態異常：${Object.entries(kill.r.inflicted).map(([id, p]) => `${INFLICT_LABELS[id as InflictId]} ${pct(p!)}`).join('・')}`}
            </p>
          </div>
        )}
      </details>

      <details>
        <summary>耐久（敵の攻撃に何ターン耐えるか）</summary>
        <p className="note">
          各メンバーが倒れるまでのターン数と全滅する確率を、乱数で何度も戦って出します。敵の HP が 0 になっても敵は行動を続けます。
          敵の行動は、上の「敵の行動」で行動パターンを選んでいればそれを使い、それ以外は下の表（手入力。初期値は通常攻撃だけ）を使います。
          状態異常：睡眠は行動できず攻撃を 1.5倍受け、攻撃されると起きるがそのターンは行動できない。スタンはそのターンの残りだけ行動できない。麻痺・テラーは 50% で行動できない。混乱は 50% で敵に通常攻撃（残りは味方を攻撃するが、そのダメージは入れていない）。毒はターンの終わりにダメージ、呪いは与えたダメージの半分が返る、即死・石化は戦闘不能。
          状態異常は同時に1つで、優先順位（石化＞テラー＞呪い＞毒＞睡眠＞混乱＞麻痺＞盲目）が下のものは上のものを置き換えない（暫定）。封じた部位のスキルは使えず、頭封じは命中 −30%（敵だけ）、腕封じは物理の攻撃 ×0.7、脚封じは速さ −30%。
          強化と弱体はそれぞれ3つまでで、同じ能力値の強化と弱体は打ち消し合って両方なくなる。
          序曲・バインドリカバリ・アザーズステップは対象の味方を選べます（「→名前」）。パリング・一寸の見切り・チェイス・トラッピングはそのターンだけ、医術防御II は5ターン、序曲・子守唄は戦闘終了まで効きます。
          狙われ方は「前列 90%・後列 10%、列の中は HP が多い順に 60%／30%／10%」、挑発中は狙われ率の確率でその味方（EO Wiki の値。出典が確かめられていない）。
          防具の防御力と属性の耐性は、メンバーの装備から入れます（防具の耐性は属性倍率から引く）。蘇生と、味方の回避の強化は入れていません。
        </p>
        <div className="table-scroll">
          <table className="score-table">
            <thead>
              <tr>
                <th>敵の行動</th>
                <th>種類</th>
                <th>属性</th>
                <th>威力（%）</th>
                <th>対象</th>
                <th>選ばれる重み</th>
                <th>基礎命中（%）</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {actions.map((a, i) => (
                <tr key={i}>
                  <td><input value={a.name} maxLength={20} onChange={(e) => setAction(i, { name: e.target.value })} aria-label="行動の名前" /></td>
                  <td>
                    <select value={a.attack} onChange={(e) => setAction(i, { attack: e.target.value as EnemyAction['attack'], normal: false })} aria-label="種類">
                      <option value="str">物理（STR）</option>
                      <option value="tec">属性（TEC）</option>
                    </select>
                  </td>
                  <td>
                    <select value={a.element} onChange={(e) => setAction(i, { element: e.target.value as ElementId })} aria-label="属性">
                      {ELEMENTS.map((el) => <option key={el} value={el}>{ELEMENT_LABELS[el]}</option>)}
                    </select>
                  </td>
                  <td><input type="number" min={0} max={2000} value={a.power} onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && setAction(i, { power: Math.max(0, Math.round(e.target.valueAsNumber)) })} aria-label="威力" /></td>
                  <td>
                    <select value={a.target} onChange={(e) => setAction(i, { target: e.target.value as EnemyAction['target'] })} aria-label="対象">
                      {(Object.keys(TARGET_LABELS) as EnemyAction['target'][]).map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
                    </select>
                  </td>
                  <td><input type="number" min={0} max={1000} value={a.weight} onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && setAction(i, { weight: Math.max(0, Math.round(e.target.valueAsNumber)) })} aria-label="重み" /></td>
                  <td><input type="number" min={0} max={200} value={a.accuracy} onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && setAction(i, { accuracy: Math.max(0, Math.round(e.target.valueAsNumber)) })} aria-label="基礎命中" /></td>
                  <td><button type="button" disabled={actions.length <= 1} onClick={() => setEnemyActions(actions.filter((_, k) => k !== i))}>消す</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="record-fields">
          <button type="button" onClick={() => setEnemyActions([...actions, { ...normalAttack(100), name: `スキル${actions.length}`, power: 150, normal: false }])}>敵の行動を足す</button>
        </div>
        <div className="record-fields">
          {members.map((m) => (
            <span key={m.id} className="battle-member">
              <label>
                {m.name}の行動
                <select value={policyOf(m)} onChange={(e) => setPolicies({ ...policies, [m.id]: e.target.value })}>
                  {actionsOf.get(m.id)!.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}{a.kind !== 'defend' && a.kind !== 'attack' ? `（${KIND_LABELS[a.kind]}）` : ''}</option>
                  ))}
                </select>
              </label>
              <span className="note">防具の防御力 {armorDefense(m)}（装備から）</span>
            </span>
          ))}
        </div>
        <p className="note">
          毎ターン選んだ行動をします。ただし、回復スキルは HP が 70% を下回る味方がいるときだけ、強化・弱体はかかっていないか切れるときだけ使い、それ以外と TP が足りないときは防御します。
        </p>
        <div className="record-fields">
          <NumberField label="ターン数" value={endTurns} min={1} max={50} onChange={setEndTurns} />
          <NumberField label="試行回数" value={endTrials} min={100} max={50000} onChange={setEndTrials} />
          <NumberField label="シード" value={seed} min={0} max={2147483647} onChange={setSeed} />
          <button
            type="button"
            disabled={!!busy || (!enemy && manual.str === 0 && manual.tec === 0)}
            onClick={() =>
              launch('耐久を試しています', { kind: 'endurance', setup: endSetup, policies: endPolicies, turns: endTurns, trials: endTrials, seed }, (r) =>
                setEndurance({ key: endKey, r: r.result, sample: r.sample }),
              )
            }
          >
            試行する
          </button>
        </div>
        {endurance && (
          <div className={`optimize-result${endurance.key !== endKey ? ' stale' : ''}`}>
            {endurance.key !== endKey && <p className="danger">条件が変わりました。もう一度「試行する」を押してください。</p>}
            <div className="table-scroll">
              <table className="score-table">
                <thead>
                  <tr>
                    <th>メンバー</th>
                    <th>倒れるまでの平均ターン数</th>
                    <th>{endurance.r.turns}ターン生き残る確率</th>
                  </tr>
                </thead>
                <tbody>
                  {endurance.r.members.map((x) => (
                    <tr key={x.id}>
                      <td>{x.name}</td>
                      <td>{x.meanTurns.toFixed(1)}{x.survive > 0 ? `（生き残った回は ${endurance.r.turns} として数える）` : ''}</td>
                      <td>{pct(x.survive)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="score-h">n ターン目までに全滅する確率（{endurance.r.trials}回、シード {endurance.r.seed}）</h3>
            <Bars data={endurance.r.wipeBy.map((p, i) => ({ label: String(i + 1), value: p }))} label="n ターン目までに全滅する確率" />
            <p className="note">{endurance.r.wipeBy.map((p, i) => `${i + 1}T ${pct(p)}`).join('　')}</p>
            <details>
              <summary>1回分の戦いの様子（シード {endurance.r.seed}）</summary>
              <TurnTable logs={endurance.sample} members={members} showHp />
            </details>
          </div>
        )}
      </details>

      <PartySearchSection
        party={party}
        setup={endSetup}
        maxTurns={maxTurns}
        enduranceTurns={endTurns}
        seed={seed}
        busy={!!busy}
        launch={launch}
        onApply={onApplyParty}
      />
    </section>
  )
}
