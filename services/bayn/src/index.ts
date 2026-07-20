import { NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger } from 'effect'

import { run } from './app'
import { loadConfig } from './config'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { TsmomStrategyLive, tsmomStrategy } from './strategy-service'

const main = Effect.gen(function* () {
  const config = yield* loadConfig
  const dependencies = Layer.mergeAll(
    MarketDataLive(config, tsmomStrategy.universe),
    JournalLive(config),
    TsmomStrategyLive,
  )
  return yield* run(config).pipe(Effect.provide(dependencies))
})

const program = main.pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError('Bayn process failed').pipe(
          Effect.annotateLogs({ service: 'bayn', event: 'process_failed', cause: Cause.pretty(cause) }),
        ),
  ),
  Effect.provide(Logger.layer([Logger.consoleJson])),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
