// 数値の入力欄（ダメージ計算・戦闘シミュレーションで使う）

/** 数値の入力欄。空や範囲外は受け付けない */
export function NumberField({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.valueAsNumber
          if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, Math.round(v))))
        }}
      />
    </label>
  )
}
