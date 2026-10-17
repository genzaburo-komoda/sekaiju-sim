// 実測記録の一覧と予測との比較（仕様書 B5）。書き出し・読み込みもここで行う。
import { useRef, useState } from 'react'
import { findEnemy, findEquipment, jobs } from '../data/gameData'
import { compare, exportMeasurements, importMeasurements, summarize, type Measurement } from '../logic/measure'
import { DIFFICULTY_LABELS } from '../logic/party'

interface Props {
  records: Measurement[]
  onChange: (next: Measurement[]) => void
}

const FILE_NAME = 'sekaiju-sim-実測記録.json'

export function MeasurementPanel({ records, onChange }: Props) {
  const [message, setMessage] = useState('')
  const [manualCopy, setManualCopy] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const sum = summarize(records)

  const copyJson = async () => {
    const text = exportMeasurements(records)
    try {
      await navigator.clipboard.writeText(text)
      setManualCopy(null)
      setMessage('記録を JSON でコピーしました')
    } catch {
      setManualCopy(text)
      setMessage('自動でコピーできませんでした。下の欄から手でコピーしてください')
    }
  }

  const download = () => {
    const blob = new Blob([exportMeasurements(records)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = FILE_NAME
    a.click()
    URL.revokeObjectURL(url)
    setMessage(`「${FILE_NAME}」を保存しました（ブラウザのダウンロード先）`)
  }

  const load = (text: string) => {
    const r = importMeasurements(text, records)
    if (!r.ok) {
      setMessage(`読み込めませんでした：${r.error}`)
      return
    }
    onChange(r.records)
    setImportText('')
    setMessage(r.added > 0 ? `${r.added}件の記録を読み込みました` : '新しい記録はありませんでした（すべて読み込み済み）')
  }

  const remove = (id: string) => {
    onChange(records.filter((r) => r.id !== id))
    setMessage('記録を1件削除しました')
  }

  return (
    <section className="measure-panel">
      <h2>実測記録</h2>
      <p className="measure-summary">
        {sum.records === 0 ? (
          'まだ記録がありません。メンバー編集の「ダメージ計算」→「この条件で実測を記録する」から記録します。'
        ) : (
          <>
            記録 {sum.records} 件・ダメージ {sum.values} 個。予測範囲に入ったもの <strong>{sum.inRange}</strong> / {sum.values}
            {sum.recordsWithOutliers > 0 && <span className="danger">（範囲外を含む記録 {sum.recordsWithOutliers} 件）</span>}
          </>
        )}
      </p>

      {records.length > 0 && (
        <ul className="measure-list">
          {[...records].reverse().map((rec) => {
            const c = compare(rec)
            const r = c.prediction.result
            const jobName = jobs.find((j) => j.id === rec.member.jobId)?.name ?? rec.member.jobId
            const weapon = findEquipment(rec.member.weaponId)
            const enemy = findEnemy(rec.target.enemyId)
            const flags = [rec.attack.boosted && 'BOOST', rec.attack.critical && 'クリティカル', rec.target.guarding && '防御中', rec.member.row === 'back' && '後列']
              .filter(Boolean)
              .join('・')
            return (
              <li key={rec.id} className={c.outside.length > 0 ? 'has-outlier' : undefined}>
                <div className="measure-head">
                  <strong>{c.prediction.attackName}</strong>
                  <span>→ {enemy ? `${enemy.name}（Lv${enemy.level}）` : `手入力の敵（Lv${rec.target.level}・VIT${rec.target.vit}）`}</span>
                  <button type="button" onClick={() => remove(rec.id)} aria-label="この記録を削除">×</button>
                </div>
                <div className="measure-cond">
                  {jobName} Lv{rec.member.level}・{weapon ? weapon.name : '素手'}
                  {flags && `・${flags}`}・{DIFFICULTY_LABELS[rec.difficulty]}
                  {rec.gameVersion && `・ver ${rec.gameVersion}`}・{new Date(rec.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
                <div className="measure-values">
                  予測 {r ? `${r.min}〜${r.max}` : '計算できない'}／実測{' '}
                  {rec.values.map((v, i) => (
                    <span key={i} className={c.outside.includes(v) ? 'value outside' : 'value'}>{v}</span>
                  ))}
                </div>
                {rec.note && <div className="measure-note">{rec.note}</div>}
              </li>
            )
          })}
        </ul>
      )}

      <div className="share-buttons">
        <button type="button" onClick={copyJson} disabled={records.length === 0}>JSON をコピー</button>
        <button type="button" onClick={download} disabled={records.length === 0}>ファイルに保存</button>
        <button type="button" onClick={() => fileInput.current?.click()}>ファイルから読み込む</button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) load(await file.text())
            e.target.value = ''
          }}
        />
      </div>
      <details className="import-box">
        <summary>JSON を貼り付けて読み込む</summary>
        <textarea rows={4} value={importText} onChange={(e) => setImportText(e.target.value)} aria-label="読み込む JSON" />
        <button type="button" onClick={() => load(importText)} disabled={!importText.trim()}>読み込む</button>
      </details>
      <p className="share-message" aria-live="polite">{message}</p>
      {manualCopy !== null && (
        <textarea className="manual-copy" readOnly value={manualCopy} rows={4} onFocus={(e) => e.target.select()} aria-label="コピー用の文字列" />
      )}
      <p className="note">記録はこのブラウザにだけ保存されます。消えないように、ときどき「ファイルに保存」してください。</p>
    </section>
  )
}
