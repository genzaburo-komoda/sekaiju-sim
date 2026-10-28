// ダメージ計算（仕様書 C2）。
// 選んだメンバーの攻撃を、敵データから選んだ敵（または手入力の敵）に当てたときのダメージの範囲と期待値を出す。
// 計算根拠の表示と実測の記録は、2026-10-28 に画面から外した（本人決定。冗長で使う人の役に立たないため。開発計画 U8）
import { useEffect, useState } from 'react'
import { findEnemy, findEquipment, skillsByJob } from '../data/gameData'
import { attackOptions, ELEMENT_LABELS, selfBuffOptions } from '../logic/attack'
import { hasShield } from '../logic/equip'
import type { ElementId } from '../logic/damage'
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
  /** 選んでいる敵（戦闘シミュレーションと共通。開発計画 U10）。null は手入力 */
  enemyId: string | null
  onEnemyChange: (id: string | null) => void
}

const ELEMENTS: ElementId[] = ['slash', 'bash', 'pierce', 'fire', 'ice', 'volt']

// 攻撃と敵の設定は、再読み込みしても続きから使えるようにこのブラウザに覚えておく
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

export function DamagePanel({ member, members, difficulty, onApplySkills, enemyId, onEnemyChange }: Props) {
  const skills = skillsByJob[member.jobId] ?? []
  const weapon = findEquipment(member.weaponId)
  const options = attackOptions(skills, member.skills, weapon, hasShield(member))
  const buffs = selfBuffOptions(skills, member.skills)

  const [initial] = useState(loadSettings)
  const [attack, setAttack] = useState<AttackSettings>(initial.attack)
  // 手入力の敵の値と「防御中」はここで持ち、敵データを選んでいればその値を使う
  const [manualTarget, setTarget] = useState<TargetSettings>(initial.target)
  const picked = findEnemy(enemyId)
  const target: TargetSettings = picked ? targetFromEnemy(picked, manualTarget.guarding) : { ...manualTarget, enemyId: null }
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ attack, target: manualTarget }))
    } catch {
      // 保存できなくても計算はできる
    }
  }, [attack, manualTarget])

  // メンバーを切り替えて選んでいた攻撃・強化が無くなったら、通常攻撃・強化なしとして扱う
  const option = options.find((o) => o.id === attack.attackId) ?? options[0]
  const isNormal = option.skill === null
  const buff = buffs.find((b) => b.id === attack.buffId)
  const effective: AttackSettings = { ...attack, attackId: option.id, buffId: buff?.id ?? '', critical: isNormal && attack.critical }
  const enemy = picked
  const prediction = predict(member, effective, target, difficulty)
  const result = prediction.result

  const setA = (patch: Partial<AttackSettings>) => setAttack({ ...attack, ...patch })


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
            onChange={onEnemyChange}
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
            <input type="checkbox" checked={target.guarding} onChange={(e) => setTarget({ ...manualTarget, guarding: e.target.checked })} />
            防御中
          </label>
          {enemy && (
            <p className="note wide">
              値を変えるときは「手入力」にする。
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
    </section>
  )
}
