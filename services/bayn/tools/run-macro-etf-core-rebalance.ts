import { dirname } from 'node:path'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Config, Console, Effect, FileSystem, Layer, Logger } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { makeAlpaca, paperOrigin } from './macro-canary-runner/alpaca'
import { Mode } from './macro-canary-runner/contract'
import {
  hashEvidence,
  newPrivateFile,
  readSnapshot,
  submitPaperRebalance,
  writeRecord,
} from './macro-canary-runner/paper-rebalance'
import { failure, parseOptions, usage } from './macro-etf-core-runner/contract'
import { orderPrefix } from './macro-etf-core-runner/planner'
import { prepareMacroEtfCoreRebalance } from './macro-etf-core-runner/rebalance'

export const runRebalance = Effect.fn('macro-etf-core.rebalance')(function* (args: readonly string[]) {
  const options = yield* Effect.fromResult(parseOptions(args))
  const origin = yield* Config.String('BAYN_ALPACA_BASE_URL').pipe(Config.withDefault(paperOrigin))
  const key = yield* Config.Redacted('BAYN_ALPACA_KEY_ID')
  const secret = yield* Config.Redacted('BAYN_ALPACA_SECRET_KEY')
  const alpaca = yield* makeAlpaca(origin, key, secret)
  const fs = yield* FileSystem.FileSystem
  const snapshot = yield* readSnapshot(alpaca, options.confirmPaperAccount)
  const { material, timestamp, window } = yield* prepareMacroEtfCoreRebalance(alpaca, snapshot, options)
  const retainedMaterial = { ...material, reconciliation: snapshot }
  const receipt = {
    ...retainedMaterial,
    mode: options.mode,
    timestamp,
    planSha256: yield* hashEvidence(retainedMaterial),
  }
  const receiptFile = yield* fs.open(options.output, newPrivateFile)
  yield* writeRecord(receiptFile, receipt)
  const outputDirectory = dirname(options.output)
  const directory = yield* fs.open(outputDirectory, { flag: 'r' })
  yield* directory.sync

  if (options.mode === Mode.Shadow) return receipt
  if (receipt.plan.blocked !== null) return yield* failure('paper-submit', receipt.plan.blocked)
  yield* submitPaperRebalance({
    alpaca,
    snapshot,
    window,
    orders: receipt.plan.orders,
    planSha256: receipt.planSha256,
    output: options.output,
    journalPrefix: orderPrefix(snapshot.account.id, window.executionDate),
  })
  return receipt
})

const runtime = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer, Logger.layer([Logger.consoleJson]))
if (import.meta.main) {
  const args = process.argv.slice(2)
  NodeRuntime.runMain(
    args.length === 1 && args[0] === '--help'
      ? Console.log(usage)
      : runRebalance(args).pipe(
          Effect.scoped,
          Effect.flatMap(({ mode, planSha256, plan }) =>
            Effect.logInfo('Macro ETF core receipt written', { mode, planSha256, orders: plan.orders.length }),
          ),
          // @effect-diagnostics-next-line strictEffectProvide:off -- entry point owns HTTP and receipt files
          Effect.provide(runtime),
        ),
  )
}
