import { NodeRuntime } from '@effect/platform-node'
import { Clock, Effect, Tracer } from 'effect'
import { backtestCommand } from '../backtest-command'
import { makeReplayPhaseTracer } from './replay-phase-tracer.test-support'

// Only the disposable acceptance executable installs this diagnostic sink.
export const tracedBacktestCommand = Effect.gen(function* () {
  const clock = yield* Clock.clockWith(Effect.succeed)
  const tracer = makeReplayPhaseTracer(clock, (record) => {
    process.stderr.write(`${JSON.stringify({ message: 'Replay child phase', ...record })}\n`)
  })
  return yield* backtestCommand.pipe(Effect.provideService(Tracer.Tracer, tracer))
})

if (import.meta.main) NodeRuntime.runMain(tracedBacktestCommand, { disableErrorReporting: true })
