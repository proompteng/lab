import { Clock, Exit, Tracer } from 'effect'

const phases = new Set([
  'bayn.backtest.source-preflight',
  'bayn.backtest.sessions',
  'bayn.backtest.source-tail',
  'bayn.backtest.report-evidence',
  'bayn.backtest.report-write',
])

const timedStages = new Set([
  'bayn.execution.cycle-pass',
  'bayn.reconciliation.run',
  'bayn.reconciliation.broker-snapshot',
  'bayn.reconciliation.persist',
  'bayn.reconciliation.cash-settlement',
  'bayn.reconciliation.fee-posting',
  'bayn.reconciliation.accrual-read',
  'bayn.reconciliation.accounting-verify',
  'bayn.reconciliation.compare',
  'bayn.reconciliation.record',
  'bayn.reconciliation.risk-context',
  'bayn.postgres.connection-acquire',
  'bayn.postgres.begin',
  'bayn.postgres.writer-lease.acquire',
  'bayn.postgres.writer-lease.check',
  'bayn.postgres.commit',
  'bayn.postgres.rollback',
])

export type ReplayPhaseRecord = {
  phase: string
  status: 'started' | 'completed' | 'failed' | 'interrupted'
  elapsedMs: number
}

export type ReplayStageTimingRecord = {
  reason: 'checkpoint' | 'completed' | 'failed' | 'interrupted'
  reconciliationCount: number
  stages: readonly {
    stage: string
    completed: number
    failed: number
    interrupted: number
    totalInclusiveMs: number
    maximumInclusiveMs: number
  }[]
}

type StageTiming = {
  completed: number
  failed: number
  interrupted: number
  totalNanos: bigint
  maximumNanos: bigint
}

// The acceptance entrypoint captures the host clock before the replay installs TestClock.
// Never export span attributes, events, exit values, causes, identifiers or source data.
export const makeReplayPhaseTracer = (
  clock: Pick<Clock.Clock, 'monotonicTimeNanosUnsafe'>,
  write: (record: ReplayPhaseRecord) => void,
  writeTiming: (record: ReplayStageTimingRecord) => void,
) => {
  let admitted = 0
  let reconciliationCount = 0
  let timingReports = 0
  const timings = new Map<string, StageTiming>()
  // Cumulative, inclusive timings: nested stages overlap and must not be added together.
  // Keep a fixed set of counters, emit at most 31 checkpoints, and reserve one terminal summary.
  const reportTiming = (reason: ReplayStageTimingRecord['reason']) => {
    if (timings.size === 0 || timingReports >= (reason === 'checkpoint' ? 31 : 32)) return
    timingReports++
    writeTiming({
      reason,
      reconciliationCount,
      stages: Array.from(timings, ([stage, timing]) => ({
        stage,
        completed: timing.completed,
        failed: timing.failed,
        interrupted: timing.interrupted,
        totalInclusiveMs: Number(timing.totalNanos) / 1_000_000,
        maximumInclusiveMs: Number(timing.maximumNanos) / 1_000_000,
      })),
    })
  }
  class ReplaySpan extends Tracer.NativeSpan {
    readonly hostStartedAt: bigint
    readonly phase: boolean
    readonly timed: boolean

    constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], phase: boolean, timed: boolean) {
      super(options)
      this.hostStartedAt = clock.monotonicTimeNanosUnsafe()
      this.phase = phase
      this.timed = timed
      if (this.phase) {
        admitted++
        write({ phase: this.name, status: 'started', elapsedMs: 0 })
      }
    }

    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      if (this.status._tag === 'Ended') return
      super.end(endTime, exit)
      const status = Exit.isSuccess(exit) ? 'completed' : Exit.hasInterrupts(exit) ? 'interrupted' : 'failed'
      const elapsed = clock.monotonicTimeNanosUnsafe() - this.hostStartedAt
      if (this.timed) {
        const timing = timings.get(this.name) ?? {
          completed: 0,
          failed: 0,
          interrupted: 0,
          totalNanos: 0n,
          maximumNanos: 0n,
        }
        timing[status]++
        timing.totalNanos += elapsed
        if (elapsed > timing.maximumNanos) timing.maximumNanos = elapsed
        timings.set(this.name, timing)
        if (this.name === 'bayn.reconciliation.run' && ++reconciliationCount % 1024 === 0) reportTiming('checkpoint')
      }
      if (this.phase) {
        write({ phase: this.name, status, elapsedMs: Number(elapsed) / 1_000_000 })
        if (this.name === 'bayn.backtest.sessions') reportTiming(status)
      }
    }
  }
  return Tracer.make({
    span(options) {
      const phase = phases.has(options.name) && admitted < 32
      const timed = timedStages.has(options.name)
      return phase || timed ? new ReplaySpan(options, phase, timed) : new Tracer.NativeSpan(options)
    },
  })
}
