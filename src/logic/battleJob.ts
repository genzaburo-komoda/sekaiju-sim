// 戦闘シミュレーションの計算を Web Worker に頼む。Worker が使えない環境（テストなど）では、その場で計算する
import { findMinTurns, sampleEndurance, simulateEndurance, simulateKill, type EnduranceResult, type KillDistribution, type MinTurnsResult, type Plan } from './battle'
import type { BattleSetup, TurnLog } from './sim'

export type BattleJob =
  | { kind: 'min-turns'; setup: BattleSetup; maxTurns: number }
  | { kind: 'kill'; setup: BattleSetup; plan: Plan; trials: number; seed: number }
  | { kind: 'endurance'; setup: BattleSetup; policies: Record<string, string>; turns: number; trials: number; seed: number }

export type JobResult<J extends BattleJob> = J extends { kind: 'min-turns' }
  ? MinTurnsResult
  : J extends { kind: 'kill' }
    ? KillDistribution
    : { result: EnduranceResult; sample: TurnLog[] }

function runHere(job: BattleJob): unknown {
  if (job.kind === 'min-turns') return findMinTurns(job.setup, job.maxTurns)
  if (job.kind === 'kill') return simulateKill(job.setup, job.plan, job.trials, job.seed)
  return { result: simulateEndurance(job.setup, job.policies, job.turns, job.trials, job.seed), sample: sampleEndurance(job.setup, job.policies, job.turns, job.seed) }
}

let serial = 0

/** 計算を始める。cancel で中断できる（Worker を止める） */
export function startJob<J extends BattleJob>(job: J, onProgress: (p: number) => void): { promise: Promise<JobResult<J>>; cancel: () => void } {
  if (typeof Worker === 'undefined') {
    return { promise: Promise.resolve(runHere(job) as JobResult<J>), cancel: () => {} }
  }
  const worker = new Worker(new URL('./battle.worker.ts', import.meta.url), { type: 'module' })
  const id = ++serial
  let settle: ((v: JobResult<J>) => void) | null = null
  let fail: ((e: Error) => void) | null = null
  const promise = new Promise<JobResult<J>>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  worker.onmessage = (e: MessageEvent<{ id: number; progress?: number; result?: unknown; error?: string }>) => {
    if (e.data.id !== id) return
    if (e.data.progress !== undefined) onProgress(e.data.progress)
    else {
      worker.terminate()
      if (e.data.error !== undefined) fail?.(new Error(e.data.error))
      else settle?.(e.data.result as JobResult<J>)
    }
  }
  worker.onerror = (e) => {
    worker.terminate()
    fail?.(new Error(e.message))
  }
  worker.postMessage({ id, job })
  return {
    promise,
    cancel: () => {
      worker.terminate()
      fail?.(new Error('中断しました'))
    },
  }
}
