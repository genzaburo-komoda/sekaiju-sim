// 機能の説明（開発計画 U9）：要点を1行だけ出し、詳しい説明は「詳しく」を開いたときだけ出す
import type { ReactNode } from 'react'

export function Explain({ lead, children }: { lead: ReactNode; children?: ReactNode }) {
  return (
    <div className="note explain">
      <p>{lead}</p>
      {children && (
        <details className="explain-more">
          <summary>詳しく</summary>
          <p>{children}</p>
        </details>
      )}
    </div>
  )
}
