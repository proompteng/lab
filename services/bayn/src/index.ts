import process from 'node:process'

import { Effect, Layer } from 'effect'

import { runBayn } from './app'
import { loadConfig } from './config'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'

const main = Effect.gen(function* () {
  const config = yield* loadConfig
  const dependencies = Layer.mergeAll(MarketDataLive(config), JournalLive(config))
  yield* runBayn(config).pipe(Effect.provide(dependencies))
})

const handledMain = main.pipe(
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.error(
        JSON.stringify({
          service: 'bayn',
          event: 'startup_failed',
          error: { component: error.component, operation: error.operation, message: error.message },
        }),
      )
      process.exitCode = 1
    }),
  ),
)

Effect.runPromise(handledMain).catch((cause) => {
  console.error(
    JSON.stringify({
      service: 'bayn',
      event: 'startup_defect',
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  )
  process.exitCode = 1
})
