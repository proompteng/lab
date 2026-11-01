import { Clock, Exit, Tracer } from 'effect'

const phases = new Set([
  'bayn.backtest.source-preflight',
  'bayn.backtest.sessions',
  'bayn.backtest.source-tail',
  'bayn.backtest.report-evidence',
  'bayn.backtest.report-write',
])

export type ReplayPhaseRecord = {
  phase: string
  status: 'started' | 'completed' | 'failed' | 'interrupted'
  elapsedMs: number
}

// The acceptance entrypoint captures the host clock before the replay installs TestClock.
// Never export span attributes, events, exit values, causes, identifiers or source data.
export const makeReplayPhaseTracer = (
  clock: Pick<Clock.Clock, 'monotonicTimeNanosUnsafe'>,
  write: (record: ReplayPhaseRecord) => void,
) => {
  let admitted = 0
  return Tracer.make({
    span(options) {
      if (!phases.has(options.name) || admitted >= 32) return new Tracer.NativeSpan(options)
      admitted++
      const startedAt = clock.monotonicTimeNanosUnsafe()
      write({ phase: options.name, status: 'started', elapsedMs: 0 })
      return new (class extends Tracer.NativeSpan {
        override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
          if (this.status._tag === 'Ended') return
          super.end(endTime, exit)
          write({
            phase: options.name,
            status: Exit.isSuccess(exit) ? 'completed' : Exit.hasInterrupts(exit) ? 'interrupted' : 'failed',
            elapsedMs: Number(clock.monotonicTimeNanosUnsafe() - startedAt) / 1_000_000,
          })
        }
      })(options)
    },
  })
}
