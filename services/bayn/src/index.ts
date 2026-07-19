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

Effect.runPromise(main).catch((cause) => {
  console.error(
    JSON.stringify({
      service: 'bayn',
      event: 'startup_failed',
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  )
  process.exitCode = 1
})
