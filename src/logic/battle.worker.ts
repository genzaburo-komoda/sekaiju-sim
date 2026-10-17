// 戦闘シミュレーション・レベル進行プラン・編成の探索を画面と別のスレッド（Web Worker）で計算する（仕様書 6.1「重い計算は Web Worker」）。
// 画面から { id, kind, args } を受け取り、進み具合 { id, progress } と結果 { id, result } を返す
import { runJob, type BattleJob } from './battleJob'

const post = (msg: unknown) => (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

globalThis.addEventListener('message', (e: Event) => {
  const { id, job } = (e as MessageEvent<{ id: number; job: BattleJob }>).data
  const progress = (done: number, total: number) => post({ id, progress: done / total })
  try {
    post({ id, result: runJob(job, progress) })
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) })
  }
})
