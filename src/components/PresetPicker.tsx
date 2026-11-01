// おすすめの編成（Lv10〜60）をワンクリックで読み込むボタン。左の列と「はじめに」に置く
import { PRESET_LEVELS, type PresetLevel } from '../logic/presets'

export function PresetPicker({ onPick, busy }: { onPick: (level: PresetLevel) => void; busy: PresetLevel | null }) {
  return (
    <div className="preset-picker">
      <div className="preset-buttons">
        {PRESET_LEVELS.map((l) => (
          <button key={l} type="button" onClick={() => onPick(l)} disabled={busy !== null}>
            Lv{l}
          </button>
        ))}
      </div>
      <p className="note" aria-live="polite">
        {busy !== null ? `Lv${busy} の編成を作っています…` : 'そのレベルで手に入る装備と、自動で選んだスキルの5人です。今のパーティと入れ替わります。'}
      </p>
    </div>
  )
}
