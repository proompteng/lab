import { Result, Schema } from 'effect'
import {
  AccountStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
} from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { numberToMicros } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { applyControlOrder, ControlExit, type ControlPortfolio, ControlStudyFailure } from './control-portfolio'
import { signalStudyDefinition } from './signal-study'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevManagementAction, JevManagementDecisionSchema } from '../jev/decision'
import { jevProtectiveQuoteIsFresh, jevProtectiveStopCrossed, decideJevExit, JevExitReason } from '../jev/exit'
import { makeJevObservation } from '../jev/observation'
import { decodeJevPortfolio, JevPurpose } from '../jev/portfolio'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { reconciledStateHash } from '../reconciliation'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'

const invalid = (message: string) => Result.fail(new ControlStudyFailure({ message }))

export const applyControlManagementDecision = (input: {
  readonly portfolio: ControlPortfolio
  readonly expectedBatchId: string
  readonly decision: unknown
  readonly committedAtMs: number
}) =>
  Result.gen(function* () {
    const expectedBatchId = yield* Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)(input.expectedBatchId)
    const decision = yield* Schema.decodeUnknownResult(JevManagementDecisionSchema, strictParseOptions)(input.decision)
    const { portfolio, committedAtMs } = input
    const { observation, batchPlan, decidedAt } = decision.evidence
    const held = portfolio.ledger.positions[0]
    const observedHeld = observation.portfolio.brokerState.positions.find(
      (position) => BigInt(position.quantityMicros) > 0n,
    )
    if (
      portfolio.inventory.status !== 'HOLDING' ||
      held === undefined ||
      portfolio.ledger.positions.length !== 1 ||
      observedHeld?.schemaVersion !== 'bayn.position.v2' ||
      observedHeld.quantityMicros !== held.quantityMicros ||
      observedHeld.costBasisMicros !== held.costBasisMicros ||
      observation.portfolio.purpose !== JevPurpose.Manage ||
      batchPlan.batchId !== expectedBatchId ||
      observation.portfolio.brokerState.accountingHash !== (yield* canonicalHashV1Result(portfolio.ledger)) ||
      observation.portfolio.entryFills[0]?.occurredAt !== utcInstantFromEpochMillis(portfolio.inventory.enteredAtMs) ||
      decision.symbol !== held.symbol ||
      !Number.isSafeInteger(committedAtMs) ||
      committedAtMs < Date.parse(decidedAt) ||
      committedAtMs > Date.parse(batchPlan.expiresAt)
    )
      return yield* invalid('Management decision differs from the current control position, request or commit deadline')
    if (decision.action === JevManagementAction.Hold)
      return { action: JevManagementAction.Hold, portfolio, decision } as const
    const target = yield* decideJevExit({
      cycleId: decision.cycleId,
      sessionDate: observation.observedAt.slice(0, 10),
      protocol: observation.protocol,
      portfolio: observation.portfolio,
      observedAt: decidedAt,
      trigger: { reason: JevExitReason.Model, decision },
    })
    return {
      action: JevManagementAction.Exit,
      portfolio: { ...portfolio, inventory: { ...portfolio.inventory, status: 'EXITING', reason: ControlExit.Model } },
      decision,
      target,
    } as const
  }).pipe(
    Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot apply recorded control management', cause })),
  )

export const makeControlManagementBatch = (input: {
  readonly runId: string
  readonly entryDecisionHash: string
  readonly beforeEntry: ControlPortfolio
  readonly entryOrder: Parameters<typeof applyControlOrder>[1]
  readonly snapshot: VerifiedStrategyMarketSnapshot
}) =>
  Result.gen(function* () {
    const runId = yield* Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)(input.runId)
    const entryDecisionHash = yield* Schema.decodeUnknownResult(
      Sha256Schema,
      strictParseOptions,
    )(input.entryDecisionHash)
    const order = input.entryOrder
    const protocol = order.protocol
    if (order.side !== OrderSide.Buy) return yield* invalid('Management input requires a simulated entry IOC')
    const executed = yield* applyControlOrder(input.beforeEntry, order)
    if (executed.outcome.status !== 'FILLED' || executed.portfolio.inventory.status !== 'HOLDING')
      return yield* invalid('Unfilled or unresolved entry cannot create management context')
    const { portfolio: control, outcome } = executed
    const fill = outcome.fill
    const position = control.ledger.positions[0]
    const at = input.snapshot.manifest.observedAt
    const atMs = Date.parse(at)
    if (
      position === undefined ||
      control.ledger.positions.length !== 1 ||
      position.quantityMicros !== fill.quantityMicros ||
      position.costBasisMicros !== fill.notionalMicros ||
      fill.observedAt > at ||
      fill.observedAt.slice(0, 10) !== input.snapshot.manifest.sessionDate ||
      atMs >= Date.parse(fill.observedAt) + protocol.maximumHoldingMinutes * 60_000
    )
      return yield* invalid('Management requires the current entry fill before its mandatory holding deadline')
    const quote = input.snapshot.latestQuotes[position.symbol]
    if (quote === undefined || !jevProtectiveQuoteIsFresh(quote, at, protocol.maximumQuoteAgeMs))
      return yield* invalid('Management requires a fresh held-position quote')
    const bid = yield* numberToMicros(quote.bidPrice)
    if (
      quote.bidSize > 0 &&
      jevProtectiveStopCrossed(
        BigInt(position.costBasisMicros),
        BigInt(position.quantityMicros),
        bid,
        protocol.protectiveStopBps,
      )
    )
      return yield* invalid('Protective stop takes precedence over a management inference')
    const decisionQuote = order.decisionQuote
    if (decisionQuote === undefined) return yield* invalid('Filled entry lacks its decision quote')
    const terms = yield* deriveExecutionIntentPricing({
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityMicros: order.quantityMicros,
      referencePriceMicros: yield* numberToMicros(decisionQuote.value.askPrice),
      executionModel: protocol.executionModel,
      limitSlippageBps: BigInt(signalStudyDefinition.limitSlippageBps),
    })
    const accountId = `research-control-management-${runId}`
    const entryIdentity = yield* canonicalHashV1Result({
      runId,
      entryDecisionHash,
      outcome,
      requestedQuantityMicros: String(order.quantityMicros),
      decisionAt: utcInstantFromEpochMillis(order.decisionAtMs),
      assumptions: order.assumptions,
      beforeLedger: input.beforeEntry.ledger,
    })
    const intentId = yield* canonicalHashV1Result({ entryIdentity, kind: 'SIMULATED_ENTRY_INTENT' })
    const brokerOrderId = `simulation-${entryIdentity}`
    const clientOrderId = `simulation-${intentId}`
    const marketValue = (BigInt(position.quantityMicros) * bid) / 1_000_000n
    const fee = BigInt(control.ledger.executionFeesMicros) - BigInt(input.beforeEntry.ledger.executionFeesMicros)
    const material: Parameters<typeof reconciledStateHash>[0] = {
      account: {
        schemaVersion: 'bayn.paper-account-snapshot.v1',
        accountId,
        status: AccountStatus.Active,
        currency: 'USD',
        cashMicros: control.ledger.cashMicros,
        equityMicros: String(BigInt(control.ledger.cashMicros) + marketValue),
        buyingPowerMicros: control.ledger.cashMicros,
        observedAt: at,
      },
      positions: [
        {
          schemaVersion: 'bayn.position.v2',
          accountId,
          symbol: position.symbol,
          quantityMicros: position.quantityMicros,
          costBasisMicros: position.costBasisMicros,
          averageEntryPriceMicros: String(
            (BigInt(position.costBasisMicros) * 1_000_000n) / BigInt(position.quantityMicros),
          ),
          marketPriceMicros: String(bid),
          marketValueMicros: String(marketValue),
          unrealizedPnlMicros: String(marketValue - BigInt(position.costBasisMicros)),
          observedAt: at,
        },
      ],
      positionsObservedAt: at,
      orders: [
        {
          schemaVersion: 'bayn.paper-order.v1',
          accountId,
          brokerOrderId,
          clientOrderId,
          intentId,
          symbol: fill.symbol,
          side: OrderSide.Buy,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: String(order.quantityMicros),
          filledQuantityMicros: fill.quantityMicros,
          limitPriceMicros: String(terms.expectedExecutionPriceMicros),
          status: BigInt(fill.quantityMicros) === order.quantityMicros ? OrderStatus.Filled : OrderStatus.Canceled,
          observedAt: at,
        },
      ],
      ordersObservedAt: at,
      accountingHash: yield* canonicalHashV1Result(control.ledger),
    }
    const stateHash = yield* reconciledStateHash(material)
    const portfolio = yield* decodeJevPortfolio({
      purpose: JevPurpose.Manage,
      entryDecisionHash,
      entryIntentIds: [intentId],
      entryFills: [
        {
          schemaVersion: 'bayn.paper-fill.v1',
          accountId,
          brokerOrderId,
          clientOrderId,
          intentId,
          fillId: `simulation-${yield* canonicalHashV1Result({ entryIdentity, fill })}`,
          symbol: fill.symbol,
          side: OrderSide.Buy,
          quantityMicros: fill.quantityMicros,
          priceMicros: fill.priceMicros,
          feeMicros: String(fee),
          occurredAt: fill.observedAt,
        },
      ],
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: {
          schemaVersion: 'bayn.paper-reconciliation.v1',
          accountId,
          reconciliationId: yield* canonicalHashV1Result({ runId, at, stateHash }),
          expectedHash: stateHash,
          observedHash: stateHash,
          contentHash: yield* canonicalHashV1Result(material),
          status: ReconciliationStatus.Exact,
          discrepancies: [],
          reconciledAt: at,
        },
      },
    })
    const observation = yield* makeJevObservation({
      cycleId: yield* canonicalHashV1Result({ runId, sessionDate: input.snapshot.manifest.sessionDate }),
      authorityGenerationHash: yield* canonicalHashV1Result({ runId, scope: 'SIMULATED_CONTROL_MANAGEMENT', protocol }),
      protocol,
      portfolio,
      snapshot: input.snapshot,
    })
    const batch = yield* makeJevTradingSignalBatch({
      observation: observation.payload,
      expiresAt: utcInstantFromEpochMillis(atMs + protocol.inferenceValidityMs),
      planVersion: JevBatchPlanVersion.V3,
    })
    return {
      classification: 'SIMULATED_CONTROL_MANAGEMENT_REQUEST_ONLY' as const,
      controlPortfolio: control,
      entryIdentity,
      entryOutcome: outcome,
      observation: observation.payload,
      batch,
    }
  })
