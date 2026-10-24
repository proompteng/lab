import { jevLiquidationValue } from '../jev/liquidation-economics'
import { instrumentMarket } from '../instruments'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { momentumControlCandidates } from './momentum-control'
import { replayInstrument, type ReplayInstrumentsSchema } from './execution-core'
import { quantityFromNumber } from '../quantity'
import { equityMarketProfile, jevHoldingMinutesForSymbol, jevMarketForSymbol } from '../jev/markets'
import { equityRollingValues } from '../market-data/features/native-feature'

import { Data, Result } from 'effect'

import { OrderSide, OrderType } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { assessEntryTurnoverReserve, EntryTurnoverPolicy } from '../execution/turnover-reserve'
import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
import { MICROS } from '../strategy/execution-model/model'
import { notionalMicros, numberToMicros } from '../strategy/execution-model/fixed-point'
import type { JevProtocol } from '../jev/protocol'
import { type IntradayQuote } from '../market-data/intraday/model'
import { compareRecords } from '../market-data/intraday/verification'
import type { ObservedMarketValue } from '../market-data/streaming/projection'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import type { Policy } from '../risk'
import { decideIntradayMomentumCore } from '../strategy/intraday-momentum/decision-core'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'
import { replayQuoteRejection } from './broker-execution-evidence'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill, type ReplayLedger } from './ledger'
import { studyOrder } from './signal-study'
import { ResidualShockCandidate, residualShockDefinition, selectResidualShock } from './residual-shock'

export const controlExitDefinition = { protectiveStopBps: 50, profitTargetNetBps: 100 } as const

export enum ControlPolicy {
  RetainedBreakout = 'RETAINED_BREAKOUT_CLOSE',
  RepeatedBreakout = 'REPEATED_BREAKOUT',
  RelativeMomentum = 'REPEATED_RELATIVE_MOMENTUM',
  JevEntry = 'REPEATED_JEV_ENTRY',
  ResidualShock = ResidualShockCandidate.SpyRelativeShockRebound60s,
  Ridge = 'SIX_BAR_RIDGE_V1',
  TrainingMean = 'SIX_BAR_TRAINING_MEAN_V1',
  FixedCandidateTraining = 'SIX_BAR_FIXED_CANDIDATE_TRAINING_V1',
}

export enum ControlExit {
  Model = 'JEV_EXIT',
  SessionClose = 'SESSION_CLOSE',
  MaximumHold = 'MAXIMUM_HOLD',
  ProtectiveStop = 'PROTECTIVE_STOP',
  ProfitTarget = 'PROFIT_TARGET',
  SignalHorizon = 'SIGNAL_HORIZON',
}

export class ControlStudyFailure extends Data.TaggedError('ControlStudyFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ControlQuote = ObservedMarketValue<IntradayQuote> | undefined
type EpisodeStart = { readonly enteredAtMs: number; readonly openingCashMicros: string }
type ControlInventory =
  | { readonly status: 'FLAT' }
  | ({ readonly status: 'HOLDING' } & EpisodeStart)
  | ({ readonly status: 'EXITING'; readonly reason: ControlExit } & EpisodeStart)

export interface ControlEpisode {
  readonly symbol: string
  readonly enteredAtMs: number
  readonly exitedAtMs: number
  readonly reason: ControlExit
  readonly netExecutionPnlMicros: string
}

export interface ControlPortfolio {
  readonly ledger: ReplayLedger<EconomicReplayFill>
  readonly inventory: ControlInventory
  readonly episodes: readonly ControlEpisode[]
  readonly tradedNotionalMicros: bigint
  readonly consumedLiquidity: ReadonlyMap<string, bigint>
}

export const createControlPortfolio = (
  openingCashMicros: string,
): Result.Result<ControlPortfolio, ControlStudyFailure> =>
  createReplayLedger(openingCashMicros).pipe(
    Result.map((ledger) => ({
      ledger,
      inventory: { status: 'FLAT' as const },
      episodes: [],
      tradedNotionalMicros: 0n,
      consumedLiquidity: new Map<string, bigint>(),
    })),
    Result.mapError((cause) => new ControlStudyFailure({ message: 'Invalid control opening cash', cause })),
  )

export const controlCandidates = (policy: ControlPolicy, _protocol: JevProtocol) =>
  policy === ControlPolicy.RetainedBreakout
    ? defaultIntradayMomentumProtocolDocument.candidateSymbols
    : equityMarketProfile.candidateSymbols

export const selectControlSymbol = (snapshot: StrategyMarketSnapshot, policy: ControlPolicy, protocol: JevProtocol) =>
  Result.gen(function* () {
    if (
      policy === ControlPolicy.JevEntry ||
      policy === ControlPolicy.Ridge ||
      policy === ControlPolicy.TrainingMean ||
      policy === ControlPolicy.FixedCandidateTraining
    )
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'This policy requires its bound native entry adapter' }),
      )
    if (policy === ControlPolicy.ResidualShock) return (yield* selectResidualShock(snapshot, protocol)).selectedSymbol
    const latestTrades = Object.fromEntries(
      snapshot.trades.toSorted(compareRecords).map((trade) => [trade.symbol, trade]),
    )
    if (policy !== ControlPolicy.RelativeMomentum) {
      const decision = yield* decideIntradayMomentumCore({
        observedAt: snapshot.manifest.observedAt,
        protocol: { ...defaultIntradayMomentumProtocolDocument, candidateSymbols: controlCandidates(policy, protocol) },
        latestQuotes: snapshot.latestQuotes,
        latestTrades,
        rollingPrices: Object.fromEntries(
          yield* Result.all(
            snapshot.manifest.streaming.features.map(({ value }) =>
              equityRollingValues(value).pipe(Result.map((values) => [value.material.symbol, values] as const)),
            ),
          ),
        ),
        candidateExclusions: snapshot.manifest.candidateExclusions ?? [],
      })
      return decision.selectedSymbols[0] ?? null
    }
    return (yield* momentumControlCandidates(snapshot))[0]?.symbol ?? null
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot select control signal', cause })))

export const controlEntryQuantity = (input: {
  readonly portfolio: ControlPortfolio
  readonly policy: Policy
  readonly protocol: JevProtocol
  readonly targetWeight: number
  readonly symbol: string
  readonly referencePriceMicros: bigint
  readonly instruments: typeof ReplayInstrumentsSchema.Type
  readonly atMs: number
  readonly feeMultiplierPpm: number
  readonly turnoverPolicy?: EntryTurnoverPolicy
  readonly allocationBudgetMicros?: bigint
}) =>
  Result.gen(function* () {
    const { portfolio, policy, symbol, referencePriceMicros, protocol } = input
    if (portfolio.inventory.status !== 'FLAT' || portfolio.ledger.positions.length !== 0)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Control entry requires flat inventory' }))
    if (input.allocationBudgetMicros !== undefined && (input.allocationBudgetMicros <= 0n || input.targetWeight !== 1))
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Fixed principal sizing requires a positive budget and unit weight' }),
      )
    let fixedPrincipalCap: bigint | undefined
    if (input.allocationBudgetMicros !== undefined) {
      const brokerEquityMicros = yield* Result.try({
        try: () => BigInt(portfolio.ledger.cashMicros),
        catch: (cause) => new ControlStudyFailure({ message: 'Invalid flat-portfolio broker equity', cause }),
      })
      const maximumWeightPpm = Math.floor(
        Math.min(protocol.maximumGrossWeight, protocol.maximumSymbolWeight) * 1_000_000,
      )
      if (
        brokerEquityMicros <= 0n ||
        !Number.isSafeInteger(maximumWeightPpm) ||
        maximumWeightPpm <= 0 ||
        maximumWeightPpm > 1_000_000
      )
        return yield* Result.fail(
          new ControlStudyFailure({
            message: 'Fixed principal sizing requires positive broker equity and valid exposure limits',
          }),
        )
      const equityRiskCapacity = (brokerEquityMicros * BigInt(maximumWeightPpm)) / MICROS
      fixedPrincipalCap =
        input.allocationBudgetMicros < equityRiskCapacity ? input.allocationBudgetMicros : equityRiskCapacity
    }
    const targetWeights = { [symbol]: input.targetWeight }
    const allocation = yield* executionMandateAllocationCapitalMicros({
      accountEquityMicros: BigInt(portfolio.ledger.cashMicros),
      dailyTradedNotionalMicros: portfolio.tradedNotionalMicros,
      maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
      maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
      maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      targetWeights,
      positions: [],
      referencePriceMicros: { [symbol]: String(referencePriceMicros) },
    })
    const constrained = yield* constrainExecutionTargetAllocationCapitalMicros({
      allocationCapitalMicros:
        fixedPrincipalCap !== undefined && fixedPrincipalCap < allocation ? fixedPrincipalCap : allocation,
      maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
      maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      targetWeights,
    })
    const instrument = yield* replayInstrument(symbol, input.instruments)
    const increment = instrument.quantityIncrementAtoms
    const weight = BigInt(Math.round(input.targetWeight * 1_000_000))
    let high = (constrained * weight * 1_000_000_000n) / MICROS / referencePriceMicros / increment
    let low = 0n
    const pricing = yield* deriveExecutionIntentPricing({
      symbol: symbol,
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: cashSpotLimitTimeInForce(instrumentMarket(symbol)),
      // Price derivation needs a nonzero micro-dollar notional; a crypto increment can be one nano-coin.
      quantityAtoms: 1_000_000_000n,
      referencePriceMicros,
      limitSlippageBps: BigInt(policy.maxAdverseSlippageBps),
    })
    while (low < high) {
      const shares = (low + high + 1n) / 2n
      const quantity = shares * increment
      const notional = (quantity * pricing.expectedExecutionPriceMicros + 999_999_999n) / 1_000_000_000n
      const tentative = applyReplayFill(
        portfolio.ledger,
        {
          symbol,
          side: 'buy',
          observedAt: new Date(input.atMs).toISOString(),
          quantityAtoms: String(shares * increment),
          priceMicros: String(pricing.expectedExecutionPriceMicros),
          notionalMicros: String(yield* notionalMicros(quantity, pricing.expectedExecutionPriceMicros)),
        },
        String(shares * increment),
        protocol.executionModel,
        input.feeMultiplierPpm,
      )
      if (Result.isFailure(tentative) && tentative.failure._tag !== 'IntradayReplayLedgerInsufficientCash')
        return yield* Result.fail(tentative.failure)
      const allowed =
        Result.isSuccess(tentative) &&
        (fixedPrincipalCap === undefined || notional <= fixedPrincipalCap) &&
        notional <= BigInt(policy.maxOrderNotionalMicros) &&
        portfolio.tradedNotionalMicros + notional <= BigInt(policy.maxDailyTradedNotionalMicros) &&
        (input.turnoverPolicy !== EntryTurnoverPolicy.EntryAndExpectedExit ||
          (yield* assessEntryTurnoverReserve({
            filledTurnoverMicros: portfolio.tradedNotionalMicros,
            maximumTurnoverMicros: BigInt(policy.maxDailyTradedNotionalMicros),
            otherReservedMicros: 0n,
            quantityAtoms: shares * increment,
            entryLimitPriceMicros: pricing.expectedExecutionPriceMicros,
            exitReferencePriceMicros: referencePriceMicros,
            exitAllowanceBps: BigInt(policy.maxAdverseSlippageBps),
          })).admitted)
      if (allowed) low = shares
      else high = shares - 1n
    }
    return low * increment >= instrument.minimumQuantityAtoms ? low * increment : 0n
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot size control entry', cause })))

export const triggerControlExit = (input: {
  readonly portfolio: ControlPortfolio
  readonly policy: ControlPolicy
  readonly feeMultiplierPpm: number
  readonly protocol: JevProtocol
  readonly atMs: number
  readonly cutoffMs: number
  readonly quote: ControlQuote
}): Result.Result<ControlPortfolio, ControlStudyFailure> =>
  Result.gen(function* () {
    const { portfolio, protocol, atMs, quote } = input
    if (portfolio.inventory.status !== 'HOLDING') return portfolio
    const position = portfolio.ledger.positions[0]
    if (position === undefined)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Holding control has no ledger position' }))
    let reason: ControlExit | undefined
    if (atMs >= input.cutoffMs) reason = ControlExit.SessionClose
    else if (input.policy !== ControlPolicy.RetainedBreakout) {
      if (atMs - portfolio.inventory.enteredAtMs >= jevHoldingMinutesForSymbol(protocol, position.symbol) * 60_000)
        reason = ControlExit.MaximumHold
      else if (
        quote !== undefined &&
        quote.value.bidSize > 0 &&
        replayQuoteRejection(quote, position.symbol, atMs, { ...protocol, ...jevMarketForSymbol(position.symbol) }) ===
          null
      ) {
        const bid = yield* numberToMicros(quote.value.bidPrice)
        if (
          bid * BigInt(position.quantityAtoms) * 10_000n <=
          BigInt(position.costBasisMicros) * 1_000_000_000n * BigInt(10_000 - controlExitDefinition.protectiveStopBps)
        )
          reason = ControlExit.ProtectiveStop
        else if (input.policy !== ControlPolicy.ResidualShock) {
          const liquidation = yield* jevLiquidationValue({
            protocol,
            symbol: position.symbol,
            quantityAtoms: BigInt(position.quantityAtoms),
            bidMicros: bid,
            costMultiplierMicros: BigInt(input.feeMultiplierPpm),
          })
          const acquisition = BigInt(portfolio.inventory.openingCashMicros) - BigInt(portfolio.ledger.cashMicros)
          if (
            liquidation.conservativeNetMicros >=
            (acquisition * BigInt(10_000 + controlExitDefinition.profitTargetNetBps) + 9_999n) / 10_000n
          )
            reason = ControlExit.ProfitTarget
        }
      }
      if (
        reason === undefined &&
        input.policy === ControlPolicy.ResidualShock &&
        atMs - portfolio.inventory.enteredAtMs >= residualShockDefinition.targetHoldingMs
      )
        reason = ControlExit.SignalHorizon
    }
    return reason === undefined
      ? portfolio
      : { ...portfolio, inventory: { ...portfolio.inventory, status: 'EXITING' as const, reason } }
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot manage control position', cause })))

export const applyControlOrder = (
  portfolio: ControlPortfolio,
  input: Omit<Parameters<typeof studyOrder>[0], 'orderType'>,
) =>
  Result.gen(function* () {
    const buying = input.side === OrderSide.Buy
    if ((buying && portfolio.inventory.status !== 'FLAT') || (!buying && portfolio.inventory.status !== 'EXITING'))
      return yield* Result.fail(new ControlStudyFailure({ message: 'Order violates control inventory phase' }))
    const orderType = OrderType.Limit
    let outcome = yield* studyOrder({ ...input, orderType })
    if (outcome.status !== 'FILLED') return { portfolio, outcome }
    const quote = input.arrivalQuote
    if (quote === undefined)
      return yield* Result.fail(new ControlStudyFailure({ message: 'Filled control order has no arrival quote' }))
    const liquidityKey = `${input.symbol}:${input.side}:${quote.recordHash}`
    const consumed = portfolio.consumedLiquidity.get(liquidityKey) ?? 0n
    if (consumed > 0n) {
      const displayed = yield* quantityFromNumber(buying ? quote.value.askSize : quote.value.bidSize)
      const available = (displayed * BigInt(input.assumptions.availableLiquidityPpm)) / MICROS
      const increment = (yield* replayInstrument(input.symbol, input.assumptions.instruments)).quantityIncrementAtoms
      const remaining = available > consumed ? ((available - consumed) / increment) * increment : 0n
      if (remaining === 0n)
        return {
          portfolio,
          outcome: { status: 'CANCELED' as const, reason: 'quote-liquidity-exhausted', quoteHash: quote.recordHash },
        }
      if (remaining < input.quantityAtoms)
        outcome = yield* studyOrder({ ...input, orderType, quantityAtoms: remaining })
      if (outcome.status !== 'FILLED') return { portfolio, outcome }
    }
    const ledger = yield* applyReplayFill(
      portfolio.ledger,
      outcome.fill,
      String(input.quantityAtoms),
      input.protocol.executionModel,
      input.assumptions.feeMultiplierPpm,
    )
    const updated = {
      ...portfolio,
      ledger,
      tradedNotionalMicros: portfolio.tradedNotionalMicros + BigInt(outcome.fill.notionalMicros),
      consumedLiquidity: new Map(portfolio.consumedLiquidity).set(
        liquidityKey,
        consumed + BigInt(outcome.fill.quantityAtoms),
      ),
    }
    if (buying)
      return {
        portfolio: {
          ...updated,
          inventory: {
            status: 'HOLDING' as const,
            enteredAtMs: input.arrivalAtMs,
            openingCashMicros: portfolio.ledger.cashMicros,
          },
        },
        outcome,
      }
    if (ledger.positions.length !== 0) return { portfolio: updated, outcome }
    const inventory = portfolio.inventory
    if (inventory.status !== 'EXITING')
      return yield* Result.fail(new ControlStudyFailure({ message: 'Closed control has no exit trigger' }))
    return {
      portfolio: {
        ...updated,
        inventory: { status: 'FLAT' as const },
        episodes: [
          ...portfolio.episodes,
          {
            symbol: input.symbol,
            enteredAtMs: inventory.enteredAtMs,
            exitedAtMs: input.arrivalAtMs,
            reason: inventory.reason,
            netExecutionPnlMicros: String(BigInt(ledger.cashMicros) - BigInt(inventory.openingCashMicros)),
          },
        ],
      },
      outcome,
    }
  }).pipe(Result.mapError((cause) => new ControlStudyFailure({ message: 'Cannot execute control order', cause })))
