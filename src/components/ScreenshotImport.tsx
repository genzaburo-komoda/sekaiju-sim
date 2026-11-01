// スクリーンショットからメンバーを設定する（2026-11-01 本人の依頼）。
// ステータス画面とスキル画面（ステータス画面でスペースキー）の2枚を選ぶと、名前・ジョブ・レベル・装備・スキルを読み取って設定する。
// 隊列（前列・後列）と引退は読み取らない（利用者が入れる）
import { useState } from 'react'
import { rules } from '../data/gameData'
import type { Member } from '../logic/party'
import { retireSpBonus } from '../logic/retire'
import { describeResult, readScreenshots, type ScreenshotResult } from '../logic/screenshot'
import { spTotal, spUsed } from '../logic/skills'
import { Explain } from './Explain'

interface Props {
  member: Member
  onChange: (next: Member) => void
}

export function ScreenshotImport({ member, onChange }: Props) {
  const [statusFile, setStatusFile] = useState<File | null>(null)
  const [skillFile, setSkillFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ScreenshotResult | null>(null)
  const [error, setError] = useState('')

  async function run() {
    if (!statusFile || !skillFile) return
    setError('')
    setResult(null)
    setProgress(0)
    try {
      const { readScreenshotFiles } = await import('../logic/ocr')
      const text = await readScreenshotFiles(statusFile, skillFile, (done, total) => setProgress(done / total))
      setResult(readScreenshots(text.status, text.skill))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  function apply(r: ScreenshotResult) {
    if (!r.jobId) return
    onChange({
      ...member,
      name: r.name ?? member.name,
      jobId: r.jobId,
      level: r.level ?? member.level,
      weaponId: r.weaponId,
      armorIds: r.armorIds,
      skills: r.skills,
    })
    setResult(null)
  }

  // SP が足りないとき（引退ボーナスがあるかもしれない）
  const spWarning = (r: ScreenshotResult) => {
    const level = r.level ?? member.level
    const total = spTotal(rules, level, retireSpBonus(rules, member.retire))
    const used = spUsed(r.skills)
    return used > total ? `スキルに使った SP（${used}）が Lv${level} の SP（${total}）より多くなります。引退ボーナスがあれば、設定したあとで「引退」を入れてください` : null
  }

  return (
    <details className="screenshot-import">
      <summary>スクリーンショットから設定する</summary>
      <Explain lead="ステータス画面とスキル画面の2枚から、名前・ジョブ・レベル・装備・スキルを読み取ります。">
        ゲームのステータス画面と、そこでスペースキーを押して出るスキル画面のスクリーンショット（同じメンバーの2枚）を選んでください。
        読み取りはこのブラウザの中で行い、画像はどこにも送りません。初めて使うときは、文字を読むプログラムとデータ（十数 MB 程度）を cdn.jsdelivr.net から読み込むので時間がかかります。
        隊列（前列・後列）と引退は読み取らないので、設定したあとで入れてください。Steam 版の 1920×1200 の画面で作りました。ほかの大きさの画面でも、黒い帯を除いて同じ比率なら読めるはずですが、確かめていません。
      </Explain>
      <div className="record-fields">
        <label>
          ステータス画面
          <input type="file" accept="image/*" onChange={(e) => setStatusFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          スキル画面
          <input type="file" accept="image/*" onChange={(e) => setSkillFile(e.target.files?.[0] ?? null)} />
        </label>
        <button type="button" disabled={!statusFile || !skillFile || progress !== null} onClick={run}>
          読み取る
        </button>
      </div>
      {progress !== null && (
        <p className="note">
          読み取っています… {Math.round(progress * 100)}% <progress value={progress} max={1} />
        </p>
      )}
      {error && <p className="danger">{error}</p>}
      {result && (
        <div className="optimize-result">
          {result.jobId ? (
            <>
              <ul>
                {result.name && <li>名前：{result.name}</li>}
                {describeResult(result).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {[...result.warnings, spWarning(result)].filter(Boolean).length > 0 && (
                <ul className="danger">
                  {[...result.warnings, spWarning(result)].filter(Boolean).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <button type="button" onClick={() => apply(result)}>
                {member.name}に設定する
              </button>
              <p className="note">今のジョブ・レベル・装備・スキルは置き換わります。隊列と引退はそのままです。</p>
            </>
          ) : (
            <ul className="danger">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  )
}
