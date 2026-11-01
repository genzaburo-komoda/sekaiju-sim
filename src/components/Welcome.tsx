// 最初の画面の道案内（開発計画 U11）。閉じるまで右側の上に出す
import type { PresetLevel } from '../logic/presets'
import { PresetPicker } from './PresetPicker'

export function Welcome({ onPreset, busy, onClose, onGoDamage }: { onPreset: (level: PresetLevel) => void; busy: PresetLevel | null; onClose: () => void; onGoDamage: () => void }) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title">はじめに</h2>
      <ol>
        <li>左の「パーティ」でメンバーを選び、ジョブ・レベル・装備を決める</li>
        <li>「編成・スキル」で、＋／− でスキルを振る</li>
        <li>
          <button type="button" className="link-button" onClick={onGoDamage}>ダメージ計算</button>
          で敵を選ぶと、ダメージが出る
        </li>
      </ol>
      <p>まずは、おすすめの編成を読み込んで試すこともできます（左の列の「おすすめの編成」からも読み込めます）。</p>
      <PresetPicker onPick={onPreset} busy={busy} />
      <div className="welcome-buttons">
        <button type="button" onClick={onClose}>閉じる</button>
      </div>
    </section>
  )
}
