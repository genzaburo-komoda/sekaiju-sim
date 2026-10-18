// ダメージ計算と計算根拠（仕様書 C2・B4）、実測の記録（B5）。
// 選んだメンバーの攻撃を、敵データから選んだ敵（または手入力の敵）に当てたときのダメージを出し、
// 計算の手順を開いて見られるようにする。ゲームで実際に出た値をこの条件のまま記録できる。
import { useEffect, useState } from 'react'
import { findEnemy, findEquipment, skillsByJob } from '../data/gameData'
import { attackOptions, ELEMENT_LABELS, selfBuffOptions } from '../logic/attack'
import { hasShield } from '../logic/equip'
import type { ConfidenceId, ElementId } from '../logic/damage'
import { parseValues } from '../logic/measure'
import type { DifficultyId, Member } from '../logic/party'
import { DEFAULT_ATTACK, DEFAULT_TARGET, predict, targetFromEnemy, type AttackSettings, type TargetSettings } from '../logic/predict'
import type { Allocation } from '../logic/skills'
import { EnemySelect } from './EnemySelect'
import { NumberField } from './NumberField'
import { OptimizePanel } from './OptimizePanel'
import { SupportPanel } from './SupportPanel'

interface Props {
  member: Member
  /** パーティ全員（最適化でパーティの合計を出すため） */
  members: Member[]
  difficulty: DifficultyId
  /** 最適化の結果をスキルの振り方に当てはめる */
  onApplySkills: (alloc: Allocation) => void
  /** 実測を記録する（値・ゲームのバージョン・メモ） */
  onRecord: (attack: AttackSettings, target: TargetSettings, values: number[], gameVersion: string, note: string) => void
  /** 前回入力したゲームのバージョン */
  lastGameVersion: string
}

const ELEMENTS: ElementId[] = ['slash', 'bash', 'pierce', 'fire', 'ice', 'volt']
const CONFIDENCE_LABELS: Record<ConfidenceId, string> = { confirmed: '確認済み', estimated: '推定', unverified: '未検証' }

// 攻撃と敵の設定は、再読み込みしても続きから測れるようにこのブラウザに覚えておく
const SETTINGS_KEY = 'sekaiju-sim:damage-settings'
function loadSettings(): { attack: AttackSettings; target: TargetSettings } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      return { attack: { ...DEFAULT_ATTACK, ...v.attack }, target: { ...DEFAULT_TARGET, ...v.target, vuln: { ...DEFAULT_TARGET.vuln, ...v.target?.vuln } } }
    }
  } catch {
    // 読めなければ初期値
  }
  return { attack: DEFAULT_ATTACK, target: DEFAULT_TARGET }
}

export function DamagePanel({ member, members, difficulty, onRecord, lastGameVersion, onApplySkills }: Props) {
  const skills = skillsByJob[member.jobId] ?? []
  const weapon = findEquipment(member.weaponId)
  const options = attackOptions(skills, member.skills, weapon, hasShield(member))
  const buffs = selfBuffOptions(skills, member.skills)

  const [initial] = useState(loadSettings)
  const [attack, setAttack] = useState<AttackSettings>(initial.attack)
  const [target, setTarget] = useState<TargetSettings>(initial.target)
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ attack, target }))
    } catch {
      // 保存できなくても計算はできる
    }
  }, [attack, target])
  const [valuesText, setValuesText] = useState('')
  const [gameVersion, setGameVersion] = useState(lastGameVersion)
  const [note, setNote] = useState('')
  const [recordMessage, setRecordMessage] = useState('')

  // メンバーを切り替えて選んでいた攻撃・強化が無くなったら、通常攻撃・強化なしとして扱う
  const option = options.find((o) => o.id === attack.attackId) ?? options[0]
  const isNormal = option.skill === null
  const buff = buffs.find((b) => b.id === attack.buffId)
  const effective: AttackSettings = { ...attack, attackId: option.id, buffId: buff?.id ?? '', critical: isNormal && attack.critical }
  const enemy = findEnemy(target.enemyId)
  const prediction = predict(member, effective, target, difficulty)
  const result = prediction.result

  const setA = (patch: Partial<AttackSettings>) => setAttack({ ...attack, ...patch })

  const record = () => {
    const values = parseValues(valuesText)
    if (!values) {
      setRecordMessage('ダメージを数字で入れてください（複数はスペースか「,」で区切る）')
      return
    }
    onRecord(effective, target, values, gameVersion.trim(), note.trim())
    setValuesText('')
    setNote('')
    setRecordMessage(`${values.length}件を記録しました`)
  }

  return (
    <section className="damage-panel">
      <h2>ダメージ計算</h2>

      <div className="damage-grid">
        <fieldset>
          <legend>攻撃</legend>
          <label>
            攻撃
            <select value={option.id} onChange={(e) => setA({ attackId: e.target.value })}>
              {options.map((o) => (
                <option key={o.id} value={o.id} disabled={o.unusable !== null}>
                  {o.skill ? `${o.name} Lv${o.level}` : o.name}
                  {o.unusable ? `（${o.unusable}）` : o.requires ? `（${o.requires}）` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={attack.boosted} onChange={(e) => setA({ boosted: e.target.checked })} />
            BOOST
          </label>
          <label className={`check${isNormal ? '' : ' disabled'}`} title={isNormal ? undefined : 'クリティカルは通常攻撃のみ'}>
            <input type="checkbox" checked={effective.critical} disabled={!isNormal} onChange={(e) => setA({ critical: e.target.checked })} />
            クリティカル
          </label>
          <label>
            自己強化
            <select value={effective.buffId} onChange={(e) => setA({ buffId: e.target.value })}>
              <option value="">なし</option>
              {buffs.map((b) => (
                <option key={b.id} value={b.id}>{`${b.name} Lv${b.level}（与ダメージ ${b.rate}%）`}</option>
              ))}
            </select>
          </label>
          <NumberField label="その他の攻撃強化（%）" value={attack.otherBuff} min={0} max={1000} onChange={(otherBuff) => setA({ otherBuff })} />
        </fieldset>

        <fieldset>
          <legend>敵</legend>
          <EnemySelect
            value={target.enemyId}
            onChange={(id) => {
              const picked = findEnemy(id)
              setTarget(picked ? targetFromEnemy(picked, target.guarding) : { ...target, enemyId: null })
            }}
          />
          <NumberField label="レベル" value={target.level} min={1} max={99} disabled={!!enemy} onChange={(level) => setTarget({ ...target, level })} />
          <NumberField label="VIT" value={target.vit} min={0} max={999} disabled={!!enemy} onChange={(vit) => setTarget({ ...target, vit })} />
          <div className="vuln-grid">
            {ELEMENTS.map((el) => (
              <NumberField
                key={el}
                label={`${ELEMENT_LABELS[el]}（%）`}
                value={target.vuln[el]}
                min={0}
                max={500}
                disabled={!!enemy}
                onChange={(v) => setTarget({ ...target, vuln: { ...target.vuln, [el]: v } })}
              />
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={target.guarding} onChange={(e) => setTarget({ ...target, guarding: e.target.checked })} />
            防御中
          </label>
          {enemy && (
            <p className="note wide">
              敵データは DS版の解析値（未検証）。値を変えるときは「手入力」にする。
              {enemy.notes && ` ${enemy.notes}`}
            </p>
          )}
        </fieldset>
      </div>

      {result ? (
        <div className="damage-result">
          <p className="damage-main">
            <span className="damage-range">{result.min === result.max ? result.min : `${result.min} 〜 ${result.max}`}</span>
            <span className="damage-expected">期待値 {result.expected.toFixed(1)}</span>
            <span className="damage-element">
              属性：{ELEMENT_LABELS[prediction.element]}
              {prediction.elemElement ? `＋${ELEMENT_LABELS[prediction.elemElement]}` : ''}
            </span>
          </p>
          <details className="basis">
            <summary>計算根拠を見る</summary>
            <ol>
              {result.steps.map((s, i) => (
                <li key={i}>
                  <div className="basis-head">
                    <strong>{s.label}</strong>
                    <span className={`badge ${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span>
                  </div>
                  <div className="basis-formula">
                    {s.formula} ＝ <strong>{s.value}</strong>
                  </div>
                  {s.note && <div className="basis-note">{s.note}</div>}
                </li>
              ))}
            </ol>
            <p className="note">
              式は英語版 Etrian Odyssey Wiki（DS版の解析）による。物理の通常攻撃とスキルの一部は Steam版での実測33発と一致した（「推定」）。術式・難易度補正などは未検証。
            </p>
          </details>
        </div>
      ) : (
        <p className="note">この攻撃は計算できません。</p>
      )}

      <OptimizePanel
        member={member}
        members={members}
        target={target}
        difficulty={difficulty}
        onApply={(alloc, attackId, buffId) => {
          onApplySkills(alloc)
          setAttack({ ...attack, attackId, buffId })
        }}
      />

      <SupportPanel member={member} members={members} enemyId={target.enemyId} difficulty={difficulty} onApply={onApplySkills} />

      <details className="record-form">
        <summary>この条件で実測を記録する</summary>
        <p className="note">
          ゲームで上と同じ条件（メンバー・武器・スキル・敵・難易度）で攻撃し、出たダメージを入れます。1回の攻撃につき1つの値。複数回分はスペースか「,」で区切ります。
        </p>
        <div className="record-fields">
          <label className="wide">
            ダメージ
            <input value={valuesText} placeholder="例：123 130 127" onChange={(e) => setValuesText(e.target.value)} />
          </label>
          <label>
            ゲームのバージョン
            <input value={gameVersion} maxLength={40} placeholder="例：1.0.3" onChange={(e) => setGameVersion(e.target.value)} />
          </label>
          <label className="wide">
            メモ
            <input value={note} maxLength={200} placeholder="例：中断再開で同じ乱数" onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" onClick={record}>記録</button>
        </div>
        <p className="share-message" aria-live="polite">{recordMessage}</p>
      </details>
    </section>
  )
}
