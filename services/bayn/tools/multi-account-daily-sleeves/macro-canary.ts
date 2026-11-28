import { join } from 'node:path'

import { Clock, Effect, FileSystem, Result, Schema, type PlatformError } from 'effect'

import { OrderSide } from '../../src/execution/contracts'
import { IsoDateSchema, Sha256Schema } from '../../src/schemas'
import { defaultMacroCanaryEtfPolicy, macroCanaryEtfs } from '../../src/strategy/macro-canary-etf/policy'
import { planMacroCanaryEtfRebalance } from '../../src/strategy/macro-canary-etf/rebalance-planner'
import { compileMacroCanaryEtfSignal, macroCanaryEtfReviewOffset } from '../../src/strategy/macro-canary-etf/signals'
import { utcInstantFromEpochMillis } from '../../src/time'
import { AccountId, BarAdjustment, Side, type Alpaca, type OrderRequest } from '../macro-canary-runner/alpaca'
import { TimeInForce } from '../macro-canary-runner/contract'
import { nyTime, readBars, readWindow } from '../macro-canary-runner/market'
import {
  hashEvidence,
  newPrivateFile,
  readSnapshot,
  submissionJournalPath,
  writeRecord,
} from '../macro-canary-runner/paper-rebalance'
import { cents, microsPerCent, orderPrefix, overnightCapCents, type Snapshot } from '../macro-canary-runner/planner'
import { orderPrefix as journalPrefix } from '../macro-etf-core-runner/planner'
import { DailySleeveFailure, SleeveMode, type DailySleeve, type VerifiedCanaryEvidenceInput } from './contract'

const { policy } = defaultMacroCanaryEtfPolicy
const minimumSessions = Math.max(...policy.features.horizons) + 1
const integerQuantity = /^\d+(?:\.0+)?$/
const usableCents = (value: string) => (Number(value) > 0 ? cents(value) : 0)
const receiptVersion = 'bayn.macro-canary-next-open-sleeve-receipt.v1'

const JournalHeader = Schema.fromJsonString(
  Schema.Struct({
    outcome: Schema.String,
    planSha256: Sha256Schema,
    plan: Schema.optionalKey(
      Schema.Struct({
        sleeveId: Schema.String,
        accountId: AccountId,
        verifiedAccountId: AccountId,
        receipt: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
)
const ReviewedReduction = Schema.Struct({
  mode: Schema.Literal(SleeveMode.PaperSubmit),
  signalSession: IsoDateSchema,
  executionSession: IsoDateSchema,
  sleeveSha256: Sha256Schema,
  target: Schema.Struct({ review: Schema.Literal(true), policyHash: Sha256Schema }),
  effectiveTargetWeights: Schema.Record(Schema.Literals(macroCanaryEtfs), Schema.Finite),
})

const rotationFailure = (code: string) => new DailySleeveFailure({ stage: 'rotation', code })
const rotationFileFailure = (cause: PlatformError.PlatformError) =>
  new DailySleeveFailure({
    stage: 'rotation',
    code: 'CanaryRotationFileOperationFailed',
    cause: { kind: cause.reason._tag },
  })

const readPendingRotation = Effect.fn('multi-account-daily-sleeves.read-pending-rotation')(function* (
  sleeve: DailySleeve,
  outputDirectory: string,
  reviewSignalSession: string,
  reviewExecutionSession: string,
  sleeveSha256: string,
) {
  const fs = yield* FileSystem.FileSystem
  const prefix = journalPrefix(sleeve.accountId, reviewExecutionSession)
  const completionPath = join(outputDirectory, `${prefix}${sleeve.sleeveId}-o1-complete.json`)
  if (yield* fs.exists(completionPath).pipe(Effect.mapError(rotationFileFailure))) return undefined

  // The reduction's reviewed target was fsynced before any order POST, even if the final receipt was lost.
  const journal = yield* fs.readFileString(submissionJournalPath(outputDirectory, prefix)).pipe(
    Effect.catchIf(
      ({ reason }) => reason._tag === 'NotFound',
      () => Effect.void,
    ),
    Effect.mapError(rotationFileFailure),
  )
  if (journal === undefined) return undefined
  const invalid = rotationFailure('InvalidCanaryRotationJournal')
  const { outcome, plan, planSha256 } = yield* Schema.decodeUnknownEffect(JournalHeader)(
    journal.split('\n', 1)[0],
  ).pipe(Effect.mapError(() => invalid))
  if (
    outcome !== 'prepared' ||
    plan === undefined ||
    plan.sleeveId !== sleeve.sleeveId ||
    plan.receipt['schemaVersion'] !== receiptVersion ||
    plan.receipt['phase'] !== 'reduce'
  )
    return undefined

  const { planSha256: receiptSha256, ...material } = plan.receipt
  if (receiptSha256 !== planSha256 || (yield* hashEvidence(material)) !== planSha256) return yield* invalid
  const source = yield* Schema.decodeUnknownEffect(ReviewedReduction)(material).pipe(Effect.mapError(() => invalid))
  if (
    plan.accountId !== sleeve.accountId ||
    plan.verifiedAccountId !== sleeve.accountId ||
    source.signalSession !== reviewSignalSession ||
    source.executionSession !== reviewExecutionSession ||
    source.sleeveSha256 !== sleeveSha256 ||
    source.target.policyHash !== defaultMacroCanaryEtfPolicy.policyHash
  )
    return yield* rotationFailure('CanaryRotationBindingMismatch')
  return { source, planSha256, completionPath }
})

const reconcileInventory = (snapshot: Snapshot, sleeve: DailySleeve) =>
  Result.gen(function* () {
    const seen = new Set<string>()
    const positions = []
    let reservedCents = 0
    let managedCents = 0
    for (const position of snapshot.positions) {
      const { symbol, qty, qty_available, side, market_value } = position
      const managed = macroCanaryEtfs.find(
        (candidate) => candidate === symbol && sleeve.activeSymbols.some((active) => active === candidate),
      )
      const sign = side === 'long' ? 1 : -1
      if (seen.has(symbol) || sign * Number(qty) <= 0 || sign * Number(market_value) <= 0)
        return yield* Result.fail(new DailySleeveFailure({ stage: 'reconcile', code: 'InconsistentCanaryInventory' }))
      seen.add(symbol)
      const gross = cents(market_value.replace(/^-/, ''), true)
      if (managed === undefined) {
        reservedCents += gross
        continue
      }
      if (
        side !== 'long' ||
        !integerQuantity.test(qty) ||
        qty_available === undefined ||
        !integerQuantity.test(qty_available) ||
        Number(qty_available) !== Number(qty)
      )
        return yield* Result.fail(new DailySleeveFailure({ stage: 'reconcile', code: 'UnsettledCanaryInventory' }))
      managedCents += gross
      positions.push({ symbol: managed, shares: Number(qty) })
    }
    if (!Number.isSafeInteger(reservedCents + managedCents))
      return yield* Result.fail(new DailySleeveFailure({ stage: 'reconcile', code: 'InvalidCanaryGross' }))
    return { positions, reservedCents, managedCents }
  })

export const prepareCanaryRebalance = Effect.fn('multi-account-daily-sleeves.canary')(function* (
  alpaca: Alpaca,
  snapshot: Snapshot,
  snapshotSha256: string,
  sleeve: DailySleeve,
  evidence: VerifiedCanaryEvidenceInput | undefined,
  outputDirectory: string,
) {
  const now = yield* Clock.currentTimeMillis
  const window = yield* readWindow(alpaca, now, policy.historyStartSession, minimumSessions)
  const calendar = window.sessions.map(({ date }) => date)
  const dates = calendar.slice(0, -1)
  const adjusted = yield* readBars(alpaca, macroCanaryEtfs, dates, window.barEnd, BarAdjustment.All)
  const raw = yield* readBars(alpaca, macroCanaryEtfs, [window.lastDate], window.barEnd, BarAdjustment.Raw)
  const bars = dates.flatMap((session) => {
    const midnight = nyTime(session, '00:00')
    return macroCanaryEtfs.flatMap((symbol) => {
      const bar = adjusted.get(symbol)?.get(midnight)
      return bar === undefined
        ? []
        : [{ session, symbol, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }]
    })
  })
  const rawSizingBars = [...raw].flatMap(([symbol, series]) => [...series.values()].map((bar) => ({ symbol, bar })))
  const marketSha256 = yield* hashEvidence({
    calendar,
    feed: 'sip',
    timeframe: '1Day',
    adjustment: BarAdjustment.All,
    bars,
    rawSizingBars,
  })
  const binding = { signalSession: window.lastDate, executionSession: window.executionDate, marketSha256 }
  if (
    evidence === undefined ||
    evidence.marketSha256 !== marketSha256 ||
    evidence.signalSession !== window.lastDate ||
    evidence.executionSession !== window.executionDate
  )
    return yield* new DailySleeveFailure({ stage: 'market', code: 'UnverifiedCanaryAdjustments', cause: binding })

  const market = {
    calendar,
    nextOpenSession: window.executionDate,
    history: { adjustment: BarAdjustment.All, corporateActionsThrough: evidence.signalSession, bars },
  } as const
  const target = yield* Effect.fromResult(compileMacroCanaryEtfSignal(defaultMacroCanaryEtfPolicy, market)).pipe(
    Effect.mapError((cause) => new DailySleeveFailure({ stage: 'signal', code: cause._tag, cause })),
  )
  const sleeveSha256 = yield* hashEvidence({
    accountId: sleeve.accountId,
    sleeveId: sleeve.sleeveId,
    capitalBudgetCents: sleeve.capitalBudgetCents,
    activeSymbols: sleeve.activeSymbols,
  })
  const reviewIndex = dates.length - 1 - macroCanaryEtfReviewOffset(policy, dates.length)
  const pending = target.review
    ? undefined
    : yield* readPendingRotation(sleeve, outputDirectory, dates[reviewIndex], calendar[reviewIndex + 1], sleeveSha256)
  const actionable = target.review || pending !== undefined
  const inventory = yield* Effect.fromResult(reconcileInventory(snapshot, sleeve))
  const { account } = snapshot
  if (account.account_blocked || account.trading_blocked || account.trade_suspended_by_user)
    return yield* new DailySleeveFailure({ stage: 'reconcile', code: 'CanaryBrokerStateBlocked' })
  const budgetCents = Math.max(
    0,
    Math.min(
      sleeve.capitalBudgetCents,
      usableCents(account.equity) - inventory.reservedCents,
      overnightCapCents - inventory.reservedCents,
    ),
  )
  const spendableCents = Math.max(
    0,
    Math.min(usableCents(account.cash), usableCents(account.buying_power), budgetCents - inventory.managedCents),
  )
  const accountEvidence = evidence.accounts.find((entry) => entry.accountId === sleeve.accountId)
  if (actionable && (accountEvidence === undefined || accountEvidence.snapshotSha256 !== snapshotSha256))
    return yield* new DailySleeveFailure({
      stage: 'reconcile',
      code: 'UnverifiedCanaryAccountEvidence',
      cause: { ...binding, snapshotSha256 },
    })

  // An exclusion removes this sleeve's authority over a symbol, including sells and SHY carry.
  const excluded = new Set(sleeve.excludeSymbols)
  const targetWeights = { ...(pending?.source.effectiveTargetWeights ?? target.targetWeights) }
  for (const symbol of macroCanaryEtfs) if (excluded.has(symbol)) targetWeights[symbol] = 0
  if (rawSizingBars.some(({ bar }) => bar.c < 1 || bar.c > 100_000))
    return yield* new DailySleeveFailure({ stage: 'sizing', code: 'InvalidCanaryRawReference' })
  const quotes = Object.fromEntries(
    rawSizingBars.map(({ symbol, bar }) => [
      symbol,
      { priceMicros: BigInt(Math.round(bar.c * 1_000_000)), tickMicros: BigInt(microsPerCent), shortable: false },
    ]),
  )
  const plan = yield* Effect.fromResult(
    planMacroCanaryEtfRebalance(defaultMacroCanaryEtfPolicy, {
      target: { ...target, review: actionable, targetWeights },
      executionSession: window.executionDate,
      equityMicros: BigInt(budgetCents) * BigInt(microsPerCent),
      spendableCashMicros: BigInt(spendableCents) * BigInt(microsPerCent),
      references: {
        adjustment: BarAdjustment.Raw,
        // Prior finalized raw closes are the price references for this next-open batch, not execution prices.
        session: window.executionDate,
        corporateActionsReconciled: accountEvidence?.snapshotSha256 === snapshotSha256,
        quotes,
      },
      positions: inventory.positions,
      ordersClear: snapshot.openOrders.length === 0,
      remainingOneWayTurnoverBps: accountEvidence?.remainingOneWayTurnoverBps ?? 0,
    }),
  ).pipe(Effect.mapError((cause) => new DailySleeveFailure({ stage: 'plan', code: cause._tag, cause })))
  const orders =
    plan.phase === 'hold'
      ? []
      : plan.orders.map((order) => ({
          request: {
            symbol: order.symbol,
            qty: String(order.shares),
            side: order.side === OrderSide.Buy ? Side.Buy : Side.Sell,
            type: 'limit',
            time_in_force: TimeInForce.Open,
            extended_hours: false,
            limit_price: (Number(order.limitPriceMicros) / 1_000_000).toFixed(2),
            client_order_id: orderPrefix(account.id, window.executionDate) + order.symbol,
          } satisfies OrderRequest,
        }))
  const observedAt = yield* Clock.currentTimeMillis
  if (observedAt >= window.cutoff)
    return yield* new DailySleeveFailure({ stage: 'calendar', code: 'CanaryPlanningWindowExpired' })
  const receipt = {
    schemaVersion: receiptVersion,
    ...binding,
    mode: sleeve.mode,
    broker: 'alpaca-paper',
    sleeveSha256,
    snapshotSha256,
    observedAt: utcInstantFromEpochMillis(observedAt),
    target,
    resumedRotation:
      pending === undefined ? null : { signalSession: pending.source.signalSession, planSha256: pending.planSha256 },
    effectiveTargetWeights: targetWeights,
    rawSizingBars,
    budgetCents,
    spendableCents,
    remainingOneWayTurnoverBps: actionable ? (accountEvidence?.remainingOneWayTurnoverBps ?? null) : null,
    phase: plan.phase,
    holdReason: plan.phase === 'hold' ? plan.reason : null,
    orders,
  }
  const planSha256 = yield* hashEvidence(receipt)
  if (
    pending !== undefined &&
    plan.phase === 'hold' &&
    plan.reason === 'NoWholeShareDrift' &&
    sleeve.mode === SleeveMode.PaperSubmit
  ) {
    // Acknowledgements are not fills. Close only after a fresh verified snapshot has no actionable drift.
    const fresh = yield* readSnapshot(alpaca, sleeve.accountId)
    if ((yield* hashEvidence(fresh)) !== snapshotSha256) return yield* rotationFailure('CanaryRotationInventoryChanged')
    const fs = yield* FileSystem.FileSystem
    const marker = yield* fs.open(pending.completionPath, newPrivateFile).pipe(Effect.mapError(rotationFileFailure))
    yield* writeRecord(marker, { ...binding, snapshotSha256, planSha256, reviewPlanSha256: pending.planSha256 }).pipe(
      Effect.catchTag('PlatformError', (cause) => Effect.fail(rotationFileFailure(cause))),
    )
    const directory = yield* fs.open(outputDirectory, { flag: 'r' }).pipe(Effect.mapError(rotationFileFailure))
    yield* directory.sync.pipe(Effect.mapError(rotationFileFailure))
  }
  return {
    window,
    plan: { ...receipt, planSha256 },
    targetExposure: actionable
      ? macroCanaryEtfs
          .filter((symbol) => !excluded.has(symbol))
          .map((symbol) => ({
            symbol,
            targetCents: Math.floor(targetWeights[symbol] * budgetCents),
          }))
      : null,
  }
})
