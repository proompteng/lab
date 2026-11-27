import { dirname, join } from 'node:path'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Clock, Config, Console, Effect, FileSystem, Layer, Logger } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../src/hash'
import { utcInstantFromEpochMillis } from '../src/time'
import { makeAlpaca, paperOrigin, type Alpaca } from './macro-canary-runner/alpaca'
import { Mode } from './macro-canary-runner/contract'
import { assertSubmissionWindow } from './macro-canary-runner/market'
import type { Snapshot } from './macro-canary-runner/planner'
import { computeAllocation } from './macro-etf-core-runner/allocation'
import { failure, parseOptions, usage, type Options } from './macro-etf-core-runner/contract'
import { readMarket } from './macro-etf-core-runner/market'
import { orderPrefix, planRebalance } from './macro-etf-core-runner/planner'

const hash = (material: unknown) =>
  Effect.fromResult(canonicalHashV1Result(material)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically hashed', cause)),
  )

const readSnapshot = Effect.fn('macro-etf-core.reconcile')(function* (alpaca: Alpaca, options: Options) {
  const account = yield* alpaca.account()
  if (options.mode === Mode.PaperSubmit && account.id !== options.confirmPaperAccount)
    return yield* failure('reconcile', 'Paper account ID does not match --confirm-paper-account')
  const positions = yield* alpaca.positions()
  const openOrders = yield* alpaca.orders()
  return {
    account,
    positions: positions.toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
    openOrders: openOrders.toSorted((a, b) => a.id.localeCompare(b.id)),
  } satisfies Snapshot
})

const fileMode = { flag: 'wx', mode: 0o600, noFollow: true } as const
const encoder = new TextEncoder()
const writeRecord = Effect.fn('macro-etf-core.persist')(function* (file: FileSystem.File, value: object) {
  const text = yield* Effect.fromResult(canonicalJsonV1Result(value)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically serialized', cause)),
  )
  yield* file.writeAll(encoder.encode(`${text}\n`))
  yield* file.sync
})

export const runRebalance = Effect.fn('macro-etf-core.rebalance')(function* (args: readonly string[]) {
  const options = yield* Effect.fromResult(parseOptions(args))
  const origin = yield* Config.String('BAYN_ALPACA_BASE_URL').pipe(Config.withDefault(paperOrigin))
  const key = yield* Config.Redacted('BAYN_ALPACA_KEY_ID')
  const secret = yield* Config.Redacted('BAYN_ALPACA_SECRET_KEY')
  const alpaca = yield* makeAlpaca(origin, key, secret)
  const fs = yield* FileSystem.FileSystem
  const snapshot = yield* readSnapshot(alpaca, options)
  const market = yield* readMarket(alpaca)
  const { window } = market
  const allocation = yield* Effect.fromResult(computeAllocation(options.profile, market, options.excludeSymbols))
  const plan = yield* Effect.fromResult(planRebalance(snapshot, options, allocation, market))
  const observedAt = yield* Clock.currentTimeMillis
  if (observedAt >= window.cutoff)
    return yield* failure('calendar', 'Next-open planning window expired while building the plan')

  const material = {
    schemaVersion: 'bayn.macro-etf-core-rebalance-receipt.v1',
    broker: 'alpaca-paper',
    profile: options.profile,
    configuredExclusions: options.excludeSymbols,
    configuredBudgetCents: options.capitalBudgetCents,
    signalSession: window.lastDate,
    signalCloseAt: window.lastCloseAt,
    executionSession: window.executionDate,
    executionOpenAt: window.executionOpenAt,
    tif: options.tif,
    barSha256: market.barSha256,
    signalBars: {
      feed: 'sip',
      timeframe: '1Day',
      adjustment: market.evidence.snapshot.adjustment,
      sessions: market.evidence.snapshot.bars.length,
      snapshotSha256: market.evidence.snapshotHash,
      missingCandidates: market.missingCandidates,
    },
    rawSizingBars: { feed: 'sip', timeframe: '1Day', adjustment: 'raw', rows: market.rawBars },
    allocation,
    reconciliation: snapshot,
    plan,
  }
  const receipt = {
    ...material,
    mode: options.mode,
    timestamp: utcInstantFromEpochMillis(observedAt),
    planSha256: yield* hash(material),
  }
  const receiptFile = yield* fs.open(options.output, fileMode)
  yield* writeRecord(receiptFile, receipt)
  const outputDirectory = dirname(options.output)
  const directory = yield* fs.open(outputDirectory, { flag: 'r' })
  yield* directory.sync

  if (options.mode === Mode.Shadow) return receipt
  if (plan.blocked !== null) return yield* failure('paper-submit', plan.blocked)

  const fresh = yield* readSnapshot(alpaca, options)
  if ((yield* hash(fresh)) !== (yield* hash(snapshot)))
    return yield* failure('paper-submit', 'Broker account or inventory changed after planning; no orders submitted')
  // Include terminal orders in the entire interval leading into this next open, not just our client IDs.
  const history = yield* alpaca.orders(utcInstantFromEpochMillis(Date.parse(window.lastCloseAt) - 1))
  if (history.length > 0)
    return yield* failure('paper-submit', 'Paper account already has an order for this next-open session')

  const clock = yield* alpaca.clock()
  const checkedAt = yield* Clock.currentTimeMillis
  yield* Effect.fromResult(assertSubmissionWindow(window, clock, checkedAt))
  if (plan.orders.length === 0) return receipt

  const prefix = orderPrefix(snapshot.account.id, window.executionDate)
  const journal = yield* fs.open(join(outputDirectory, `${prefix}submissions.jsonl`), fileMode)
  yield* directory.sync
  const dispatchDeadline = Math.min(checkedAt + 60_000, window.cutoff)
  for (const { request } of plan.orders) {
    const dispatchMs = yield* Clock.currentTimeMillis
    if (dispatchMs >= dispatchDeadline)
      return yield* failure('paper-submit', 'Verified submission window expired; reconcile the journal and broker')
    yield* writeRecord(journal, {
      planSha256: receipt.planSha256,
      outcome: 'dispatching',
      at: utcInstantFromEpochMillis(dispatchMs),
      request,
    })
    // An fsync may itself cross the cutoff. Preserve the journal fence even if no POST is attempted.
    if ((yield* Clock.currentTimeMillis) >= dispatchDeadline)
      return yield* failure('paper-submit', 'Submission window expired after journaling; reconcile before retrying')

    const ack = yield* alpaca
      .submit(request)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'paper-submit',
            `No verified acknowledgement for ${request.client_order_id}; reconcile before retrying`,
            cause,
          ),
        ),
      )
    yield* writeRecord(journal, {
      planSha256: receipt.planSha256,
      outcome: 'acknowledged',
      at: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      ack,
    })
  }
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
