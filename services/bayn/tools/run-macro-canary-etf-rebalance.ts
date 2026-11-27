import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Clock, Config, Console, Effect, FileSystem, Layer, Logger, Result, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../src/hash'
import { utcInstantFromEpochMillis } from '../src/time'
import { AccountId, makeAlpaca, paperOrigin, type Alpaca } from './macro-canary-runner/alpaca'
import { failure, Mode, TimeInForce, type Options } from './macro-canary-runner/contract'
import { assertSubmissionWindow, readMarket, readWindow } from './macro-canary-runner/market'
import { cents, orderPrefix, overnightCapCents, planRebalance, type Snapshot } from './macro-canary-runner/planner'
import { computeSignals, historyLength, wave5dRevision } from './macro-canary-runner/signals'

const usage =
  'Usage: bun services/bayn/tools/run-macro-canary-etf-rebalance.ts --output <new-receipt.json>\n' +
  '  [--mode shadow|paper-submit] [--confirm-paper-account <uuid>] [--tif day|opg]\n' +
  '  [--exclude-symbols QQQ,SMH] [--capital-budget-usd 50000]'

export const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            output: { type: 'string' },
            mode: { type: 'string', default: Mode.Shadow },
            'confirm-paper-account': { type: 'string' },
            'exclude-symbols': { type: 'string' },
            'capital-budget-usd': { type: 'string' },
            tif: { type: 'string', default: TimeInForce.Open },
          },
          tokens: true,
        }),
      catch: () => failure('config', usage),
    })
    const { mode, tif, output, 'confirm-paper-account': accountId, 'capital-budget-usd': budget } = values
    const excludeSymbols = values['exclude-symbols']?.split(',').map((symbol) => symbol.trim().toUpperCase()) ?? []
    if (
      new Set(tokens.map((token) => (token.kind === 'option' ? token.name : ''))).size !== tokens.length ||
      (mode !== Mode.Shadow && mode !== Mode.PaperSubmit) ||
      (tif !== TimeInForce.Open && tif !== TimeInForce.Day) ||
      output === undefined ||
      output.trim().length === 0 ||
      excludeSymbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) ||
      (budget !== undefined && !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(budget))
    )
      return yield* Result.fail(failure('config', usage))
    const capitalBudgetCents = budget === undefined ? undefined : cents(budget)
    if (capitalBudgetCents !== undefined && (capitalBudgetCents <= 0 || capitalBudgetCents > overnightCapCents))
      return yield* Result.fail(failure('config', '--capital-budget-usd must be positive and no more than 150000'))
    if (
      (mode === Mode.PaperSubmit && !Schema.is(AccountId)(accountId)) ||
      (mode === Mode.Shadow && accountId !== undefined)
    )
      return yield* Result.fail(
        failure('config', 'Only paper-submit accepts and requires --confirm-paper-account <uuid>'),
      )
    return {
      mode,
      tif,
      output,
      excludeSymbols: [...new Set(excludeSymbols)].sort(),
      ...(accountId === undefined ? {} : { confirmPaperAccount: accountId }),
      ...(capitalBudgetCents === undefined ? {} : { capitalBudgetCents }),
    } satisfies Options
  })

const hash = (material: unknown) =>
  Effect.fromResult(canonicalHashV1Result(material)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically hashed', cause)),
  )
const canonicalText = (material: unknown) =>
  Effect.fromResult(canonicalJsonV1Result(material)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically serialized', cause)),
  )

const readSnapshot = Effect.fn('macro-canary.reconcile')(function* (alpaca: Alpaca, options: Options) {
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

export const runRebalance = Effect.fn('macro-canary.rebalance')(function* (args: readonly string[]) {
  const options = yield* Effect.fromResult(parseOptions(args))
  const origin = yield* Config.String('BAYN_ALPACA_BASE_URL').pipe(Config.withDefault(paperOrigin))
  const key = yield* Config.Redacted('BAYN_ALPACA_KEY_ID')
  const secret = yield* Config.Redacted('BAYN_ALPACA_SECRET_KEY')
  const alpaca = yield* makeAlpaca(origin, key, secret)
  const fs = yield* FileSystem.FileSystem
  const now = yield* Clock.currentTimeMillis
  const window = yield* readWindow(alpaca, now)
  const market = yield* readMarket(alpaca, window)
  const signals = yield* Effect.fromResult(computeSignals(market.older, market.recent))
  const snapshot = yield* readSnapshot(alpaca, options)
  const plan = yield* Effect.fromResult(
    planRebalance(snapshot, options, window.executionDate, signals.reviewDue, signals.targetWeights, market.rawBars),
  )
  const observedAt = yield* Clock.currentTimeMillis
  if (observedAt >= window.cutoff)
    return yield* failure('calendar', 'Next-open planning window expired while reconciling inputs')
  const material = {
    schemaVersion: 'bayn.macro-canary-rebalance-receipt.v1',
    strategyRevision: wave5dRevision,
    broker: 'alpaca-paper',
    signalSession: window.lastDate,
    signalCloseAt: window.lastCloseAt,
    executionSession: window.executionDate,
    executionOpenAt: window.executionOpenAt,
    tif: options.tif,
    barSha256: yield* hash(market.material),
    signalBars: {
      feed: market.material.feed,
      timeframe: market.material.timeframe,
      adjustment: market.material.adjustment,
      sessions: historyLength,
      firstSession: window.recentDates[0],
      macroSeedSessions: window.olderDates.length,
    },
    rawSizingBars: { feed: 'sip', timeframe: '1Day', adjustment: 'raw', rows: market.rawBars },
    signals,
    reconciliation: snapshot,
    plan,
  }
  const receipt = {
    ...material,
    mode: options.mode,
    timestamp: utcInstantFromEpochMillis(observedAt),
    planSha256: yield* hash(material),
  }
  const encoder = new TextEncoder()
  const receiptFile = yield* fs.open(options.output, fileMode)
  yield* receiptFile.writeAll(encoder.encode(`${yield* canonicalText(receipt)}\n`))
  yield* receiptFile.sync

  if (options.mode === Mode.Shadow) return receipt
  if (plan.blocked !== null) return yield* failure('paper-submit', plan.blocked)
  if (plan.orders.length === 0) return receipt

  // Terminal orders also fence a rerun with a different receipt path, even if no order is still open.
  const prefix = orderPrefix(snapshot.account.id, window.executionDate)
  const history = yield* alpaca.orders(window.lastCloseAt)
  if (history.some(({ client_order_id }) => client_order_id.startsWith(prefix)))
    return yield* failure('paper-submit', 'This account already has a runner order for the execution session')
  const fresh = yield* readSnapshot(alpaca, options)
  if ((yield* hash(fresh)) !== (yield* hash(snapshot)))
    return yield* failure('paper-submit', 'Broker state changed after planning; no orders submitted')

  const clock = yield* alpaca.clock()
  const checkedAt = yield* Clock.currentTimeMillis
  yield* Effect.fromResult(assertSubmissionWindow(window, clock, checkedAt))
  const outputDirectory = dirname(options.output)
  const journal = yield* fs.open(join(outputDirectory, `${prefix}submissions.jsonl`), fileMode)
  // Persist the receipt and journal directory entries before the first broker mutation.
  const directory = yield* fs.open(outputDirectory, { flag: 'r' })
  yield* directory.sync
  const record = (entry: object) =>
    Effect.gen(function* () {
      yield* journal.writeAll(encoder.encode(`${yield* canonicalText({ planSha256: receipt.planSha256, ...entry })}\n`))
      yield* journal.sync
    })
  for (const { request } of plan.orders) {
    const dispatchMs = yield* Clock.currentTimeMillis
    if (dispatchMs >= Math.min(checkedAt + 60_000, window.cutoff))
      return yield* failure('paper-submit', 'Verified submission window expired; reconcile the journal and broker')
    const at = utcInstantFromEpochMillis(dispatchMs)
    yield* record({ outcome: 'dispatching', at, clientOrderId: request.client_order_id })
    // If interrupted or the response is uncertain, the durable dispatch record has no matching acknowledgement.
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
    yield* record({
      outcome: 'acknowledged',
      at: yield* Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis)),
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
            Effect.logInfo('Macro canary receipt written', { mode, planSha256, orders: plan.orders.length }),
          ),
          // @effect-diagnostics-next-line strictEffectProvide:off -- entry point owns HTTP and receipt files
          Effect.provide(runtime),
        ),
  )
}
