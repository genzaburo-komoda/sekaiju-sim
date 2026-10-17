// 保存・共有（仕様書 A4・A5）：URL のコピー、テキストのコピー、名前を付けてブラウザに保存・読み込み
import { useState } from 'react'
import type { Party } from '../logic/party'
import { encodeParty, partyToText, shareUrl, type DecodeContext } from '../logic/share'
import { deleteBuild, loadSaved, saveBuild, type SavedBuild } from '../logic/storage'

interface Props {
  party: Party
  ctx: DecodeContext
  /** 保存した構築を読み込む（共有コードを渡す） */
  onLoadCode: (code: string) => void
}

export function ShareTools({ party, ctx, onLoadCode }: Props) {
  const [message, setMessage] = useState('')
  // クリップボードが使えないときに、手でコピーしてもらう文字列
  const [manualCopy, setManualCopy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<SavedBuild[]>(() => loadSaved())

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setManualCopy(null)
      setMessage(`${label}をコピーしました`)
    } catch {
      setManualCopy(text)
      setMessage(`${label}を自動でコピーできませんでした。下の欄から手でコピーしてください`)
    }
  }

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setMessage('保存する名前を入れてください')
      return
    }
    if (saveBuild(trimmed, encodeParty(party))) {
      setSaved(loadSaved())
      setMessage(`「${trimmed}」として保存しました`)
    } else {
      setMessage('このブラウザでは保存できませんでした（プライベートブラウズなど）。URL のコピーを使ってください')
    }
  }

  const remove = (target: string) => {
    deleteBuild(target)
    setSaved(loadSaved())
    setMessage(`「${target}」を削除しました`)
  }

  return (
    <section className="share-tools">
      <h2>保存・共有</h2>
      <div className="share-buttons">
        <button type="button" onClick={() => copy(shareUrl(party), 'URL')}>URL をコピー</button>
        <button type="button" onClick={() => copy(partyToText(party, ctx), 'テキスト')}>テキストをコピー</button>
      </div>

      <div className="save-row">
        <input value={name} maxLength={20} placeholder="保存名" aria-label="保存名" onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={save}>保存</button>
      </div>

      <p className="share-message" aria-live="polite">{message}</p>
      {manualCopy !== null && (
        <textarea className="manual-copy" readOnly value={manualCopy} rows={4} onFocus={(e) => e.target.select()} aria-label="コピー用の文字列" />
      )}

      {saved.length > 0 && (
        <ul className="saved-list">
          {saved.map((b) => (
            <li key={b.name}>
              <span className="saved-name">{b.name}</span>
              <span className="saved-date">{new Date(b.savedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <button type="button" onClick={() => onLoadCode(b.code)}>読み込む</button>
              <button type="button" onClick={() => remove(b.name)} aria-label={`${b.name}を削除`}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
