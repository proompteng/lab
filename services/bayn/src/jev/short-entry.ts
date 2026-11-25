import { Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { OrderSide, OrderType } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { canonicalHashV1Result } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { quantityScale } from '../quantity'
import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  UtcInstantSchema,
  SignedMicrosSchema,
} from '../schemas'
import { calculateSessionFees } from '../strategy/execution-model/fees'
import { priceNumberToMicros, desiredQuantityAtoms } from '../strategy/execution-model/fixed-point'
import type { NativeChartEvidence } from './chart-evidence'
import type { ChartAssessmentsMaterial } from './chart-assessments'
import { JevContractError } from './contract'
import { jevEntryPriceAllowances } from './entry-economics'
import { hasRequiredRewardRiskRatio, meetsMinimumProtectiveStopDistance } from './entry-proposals'
import { chartPresenceIsAbsent } from './judgment-policy'
import type { JevProtocolMaterial } from './protocol'

export enum ShortEntrySetup {
  ResistanceRejection = 'RESISTANCE_REJECTION',
  BaseBreakdown = 'BASE_BREAKDOWN',
}

export const ShortEntrySourceSchema = Schema.Union([
  Schema.Struct({
    setup: Schema.Literal(ShortEntrySetup.ResistanceRejection),
    resistanceBarId: Schema.NonEmptyString,
    supportBarId: Schema.NonEmptyString,
    targetBasis: Schema.Literal('OBSERVED_SUPPORT'),
  }),
  Schema.Struct({
    setup: Schema.Literal(ShortEntrySetup.BaseBreakdown),
    firstBarId: Schema.NonEmptyString,
    lastBarId: Schema.NonEmptyString,
    targetBasis: Schema.Literal('PROJECTED_MEASURED_BASE_RANGE'),
  }),
])

const ShortProposalMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.equity-short-entry-proposal.v1'),
  positionSide: Schema.Literal('SHORT'),
  symbol: SymbolSchema,
  source: ShortEntrySourceSchema,
  barsHash: Sha256Schema,
  chartAssessmentsHash: Sha256Schema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  minimumEntryPriceMicros: PositiveMicrosSchema,
  stopPriceMicros: PositiveMicrosSchema,
  stopLimitPriceMicros: PositiveMicrosSchema,
  profitLimitPriceMicros: PositiveMicrosSchema,
  funding: Schema.Struct({
    maximumQuantityAtoms: PositiveMicrosSchema,
    maximumTargetWeight: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
    saleNetProceedsMicros: PositiveMicrosSchema,
    collateralMicros: PositiveMicrosSchema,
    estimatedStopPnlMicros: SignedMicrosSchema,
    estimatedTargetPnlMicros: SignedMicrosSchema,
  }),
})

export const ShortEntryProposalSchema = Schema.Struct({
  ...ShortProposalMaterial.fields,
  proposalId: Sha256Schema,
}).check(
  Schema.makeFilter((proposal) => {
    const { proposalId, ...material } = proposal
    const hash = canonicalHashV1Result(material)
    return instrumentMarket(proposal.symbol) === MarketKind.Equity &&
      Date.parse(proposal.sourceStartAt) < Date.parse(proposal.sourceEndAt) &&
      BigInt(proposal.profitLimitPriceMicros) < BigInt(proposal.minimumEntryPriceMicros) &&
      BigInt(proposal.minimumEntryPriceMicros) < BigInt(proposal.stopPriceMicros) &&
      BigInt(proposal.stopPriceMicros) <= BigInt(proposal.stopLimitPriceMicros) &&
      BigInt(proposal.funding.maximumQuantityAtoms) % quantityScale === 0n &&
      BigInt(proposal.funding.estimatedStopPnlMicros) < 0n &&
      BigInt(proposal.funding.estimatedTargetPnlMicros) > 0n &&
      Result.isSuccess(hash) &&
      hash.success === proposalId
      ? []
      : [
          {
            path: [],
            issue:
              'short proposal must bind whole equity shares, ordered cover prices, funded loss/profit and exact source identity',
          },
        ]
  }),
)
export type ShortEntryProposal = typeof ShortEntryProposalSchema.Type

export const isShortPayoffFunded = (
  protocol: Pick<JevProtocolMaterial, 'schemaVersion'>,
  targetPnlMicros: bigint,
  stopPnlMicros: bigint,
): boolean =>
  stopPnlMicros < 0n &&
  targetPnlMicros > 0n &&
  hasRequiredRewardRiskRatio(protocol, MarketKind.Equity, targetPnlMicros, -stopPnlMicros)

export const jevShortEntryEconomics = (input: {
  readonly protocol: JevProtocolMaterial
  readonly symbol: string
  readonly feeAt: string
  readonly bidMicros: bigint
  readonly capitalMicros: string
}) =>
  Result.gen(function* () {
    if (instrumentMarket(input.symbol) !== MarketKind.Equity || input.bidMicros <= 0n)
      return yield* Result.fail(
        new JevContractError({ message: 'Native short funding requires a positive equity bid' }),
      )
    const entryAllowances = jevEntryPriceAllowances(input.protocol, input.symbol)
    const minimumEntryPrice =
      entryAllowances.quoteDriftBps === 0 && entryAllowances.limitSlippageBps === 0
        ? quantizeInstrumentPriceMicros(input.symbol, input.bidMicros, 'DOWN')
        : (yield* deriveExecutionIntentPricing({
            symbol: input.symbol,
            side: OrderSide.Sell,
            orderType: OrderType.Limit,
            timeInForce: cashSpotLimitTimeInForce(MarketKind.Equity),
            quantityAtoms: quantityScale,
            referencePriceMicros: quantizeInstrumentPriceMicros(
              input.symbol,
              (input.bidMicros * BigInt(10_000 - entryAllowances.quoteDriftBps) + 9_999n) / 10_000n,
              'DOWN',
            ),
            limitSlippageBps: BigInt(entryAllowances.limitSlippageBps),
          })).expectedExecutionPriceMicros
    if (minimumEntryPrice <= 0n) return null
    const weight = Math.min(input.protocol.maximumGrossWeight, input.protocol.maximumSymbolWeight)
    // Sale proceeds never increase the allocation budget. Reserve 150% initial collateral from existing capital.
    const sharesByGross =
      (yield* desiredQuantityAtoms(BigInt(input.capitalMicros), weight, minimumEntryPrice, {
        precision: { ...input.protocol.executionModel.precision, quantityIncrementAtoms: quantityScale.toString() },
      })) / quantityScale
    const sharesByCollateral = (BigInt(input.capitalMicros) * 2n) / (minimumEntryPrice * 3n)
    const shares = sharesByGross < sharesByCollateral ? sharesByGross : sharesByCollateral
    if (shares <= 0n) return null
    const quantityAtoms = shares * quantityScale
    const notional = shares * minimumEntryPrice
    const fees = yield* calculateSessionFees(
      [{ symbol: input.symbol, side: 'sell', quantityAtoms, notionalMicros: notional }],
      input.protocol.executionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
      input.feeAt,
    )
    const proceeds = notional - fees.cashMicros
    if (proceeds <= 0n) return null
    return {
      minimumEntryPriceMicros: minimumEntryPrice.toString(),
      maximumQuantityAtoms: quantityAtoms.toString(),
      maximumTargetWeight: weight,
      saleNetProceedsMicros: proceeds.toString(),
      collateralMicros: ((notional * 3n + 1n) / 2n).toString(),
    }
  })

export const shortCoverCostMicros = (input: {
  readonly protocol: JevProtocolMaterial
  readonly symbol: string
  readonly feeAt: string
  readonly quantityAtoms: bigint
  readonly priceMicros: bigint
}) =>
  Result.gen(function* () {
    const notionalMicros = (input.quantityAtoms * input.priceMicros + quantityScale - 1n) / quantityScale
    const fees = yield* calculateSessionFees(
      [{ symbol: input.symbol, side: 'buy', quantityAtoms: input.quantityAtoms, notionalMicros }],
      input.protocol.executionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
      input.feeAt,
    )
    return notionalMicros + fees.cashMicros
  })

const evaluateShortProposalFunding = (input: {
  readonly protocol: JevProtocolMaterial
  readonly symbol: string
  readonly feeAt: string
  readonly askMicros: bigint
  readonly economics: {
    readonly minimumEntryPriceMicros: string
    readonly maximumQuantityAtoms: string
    readonly saleNetProceedsMicros: string
  }
  readonly stop: bigint
  readonly target: bigint
}) =>
  Result.gen(function* () {
    const { protocol, symbol, feeAt, askMicros, economics, stop, target } = input
    const stopLimit = quantizeInstrumentPriceMicros(
      symbol,
      (stop * BigInt(10_000 + protocol.maximumEntryLimitSlippageBps)) / 10_000n,
      'DOWN',
    )
    if (
      target <= 0n ||
      target >= BigInt(economics.minimumEntryPriceMicros) ||
      stop <= askMicros ||
      stopLimit < stop ||
      !meetsMinimumProtectiveStopDistance({
        protocol,
        side: 'short',
        referenceMicros: askMicros,
        stopPriceMicros: stop,
      })
    )
      return null
    const common = {
      protocol,
      symbol,
      feeAt,
      quantityAtoms: BigInt(economics.maximumQuantityAtoms),
    }
    const proceeds = BigInt(economics.saleNetProceedsMicros)
    const stopPnl = proceeds - (yield* shortCoverCostMicros({ ...common, priceMicros: stopLimit }))
    const targetPnl = proceeds - (yield* shortCoverCostMicros({ ...common, priceMicros: target }))
    if (!isShortPayoffFunded(protocol, targetPnl, stopPnl)) return null
    return { stopLimit, stopPnl, targetPnl } as const
  })

export const mayHaveFundableShortSource = (input: {
  readonly chart: NativeChartEvidence
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
  readonly askMicros: bigint
  readonly capitalMicros: string
}) =>
  Result.gen(function* () {
    const economics = yield* jevShortEntryEconomics({
      ...input,
      symbol: input.chart.symbol,
      feeAt: input.chart.windowEndAt,
    })
    if (economics === null) return false
    const prices = yield* Result.all(
      input.chart.bars.map((bar) =>
        Result.all({
          high: priceNumberToMicros(bar.high, 'short source high', 'UP'),
          low: priceNumberToMicros(bar.low, 'short source low', 'DOWN'),
        }),
      ),
    )
    const fundable = (stop: bigint, target: bigint) =>
      evaluateShortProposalFunding({
        protocol: input.protocol,
        symbol: input.chart.symbol,
        feeAt: input.chart.windowEndAt,
        askMicros: input.askMicros,
        economics,
        stop,
        target,
      }).pipe(Result.map((funded) => funded !== null))
    const lowest = prices.reduce<bigint | undefined>((n, p) => (n === undefined || p.low < n ? p.low : n), undefined)
    if (lowest !== undefined) {
      const target = quantizeInstrumentPriceMicros(input.chart.symbol, lowest + 1n, 'UP')
      for (const price of prices) {
        if (yield* fundable(quantizeInstrumentPriceMicros(input.chart.symbol, price.high + 1n, 'UP'), target))
          return true
      }
    }
    for (let first = 0; first < prices.length - 2; first++) {
      const initial = prices[first]
      if (initial === undefined) continue
      let maximum = initial.high
      let minimum = initial.low
      for (let last = first + 1; last < prices.length - 1; last++) {
        const previousBar = input.chart.bars[last - 1]
        const bar = input.chart.bars[last]
        const price = prices[last]
        if (
          previousBar === undefined ||
          bar === undefined ||
          price === undefined ||
          previousBar.minuteBeforeWindowEnd !== bar.minuteBeforeWindowEnd + 1
        )
          break
        maximum = price.high > maximum ? price.high : maximum
        minimum = price.low < minimum ? price.low : minimum
        if (
          input.askMicros < minimum &&
          maximum > minimum &&
          (yield* fundable(
            quantizeInstrumentPriceMicros(input.chart.symbol, maximum + 1n, 'UP'),
            quantizeInstrumentPriceMicros(input.chart.symbol, minimum - (maximum - minimum), 'UP'),
          ))
        )
          return true
      }
    }
    return false
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Native short source feasibility could not be established', cause }),
    ),
  )

export const makeShortEntryProposals = (input: {
  readonly chart: NativeChartEvidence
  readonly assessments: ChartAssessmentsMaterial
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
  readonly askMicros: bigint
  readonly capitalMicros: string
}) =>
  Result.gen(function* () {
    const { chart, assessments, protocol } = input
    if (
      chart.symbol !== assessments.symbol ||
      chart.windowEndAt !== assessments.windowEndAt ||
      chart.barsHash !== assessments.barsHash ||
      chart.pngHash !== assessments.pngHash ||
      input.bidMicros > input.askMicros
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Short source judgments and executable quote must bind the exact chart' }),
      )
    const economics = yield* jevShortEntryEconomics({ ...input, symbol: chart.symbol, feeAt: chart.windowEndAt })
    const proposals: ShortEntryProposal[] = []
    if (economics === null) return proposals
    const first = chart.bars[0]
    if (first === undefined)
      return yield* Result.fail(new JevContractError({ message: 'Short source window is empty' }))
    const chartAssessmentsHash = yield* canonicalHashV1Result(assessments)
    const add = (source: typeof ShortEntrySourceSchema.Type, stop: bigint, target: bigint) =>
      Result.gen(function* () {
        const funded = yield* evaluateShortProposalFunding({
          protocol,
          symbol: chart.symbol,
          feeAt: chart.windowEndAt,
          askMicros: input.askMicros,
          economics,
          stop,
          target,
        })
        if (funded === null) return
        const { stopLimit, stopPnl, targetPnl } = funded
        const material = {
          schemaVersion: 'bayn.equity-short-entry-proposal.v1' as const,
          positionSide: 'SHORT' as const,
          symbol: chart.symbol,
          source,
          barsHash: chart.barsHash,
          chartAssessmentsHash,
          sourceStartAt: first.timestamp,
          sourceEndAt: chart.windowEndAt,
          maximumHoldingMinutes: protocol.maximumHoldingMinutes,
          minimumEntryPriceMicros: economics.minimumEntryPriceMicros,
          stopPriceMicros: stop.toString(),
          stopLimitPriceMicros: stopLimit.toString(),
          profitLimitPriceMicros: target.toString(),
          funding: {
            maximumQuantityAtoms: economics.maximumQuantityAtoms,
            maximumTargetWeight: economics.maximumTargetWeight,
            saleNetProceedsMicros: economics.saleNetProceedsMicros,
            collateralMicros: economics.collateralMicros,
            estimatedStopPnlMicros: stopPnl.toString(),
            estimatedTargetPnlMicros: targetPnl.toString(),
          },
        }
        proposals.push(
          yield* Schema.decodeUnknownResult(ShortEntryProposalSchema)({
            ...material,
            proposalId: yield* canonicalHashV1Result(material),
          }),
        )
      })
    const present = (structure: typeof assessments.support) =>
      structure.presence.status === 'ASSESSED' &&
      !chartPresenceIsAbsent(protocol, structure.presence.probability) &&
      structure.anchor.status === 'ASSESSED'
    if (
      present(assessments.support) &&
      present(assessments.resistance) &&
      assessments.support.anchor.status === 'ASSESSED' &&
      assessments.resistance.anchor.status === 'ASSESSED'
    ) {
      const supportId = assessments.support.anchor.barId
      const resistanceId = assessments.resistance.anchor.barId
      const support = chart.bars.find((b) => b.id === supportId)
      const resistance = chart.bars.find((b) => b.id === resistanceId)
      if (support === undefined || resistance === undefined)
        return yield* Result.fail(new JevContractError({ message: 'Short anchors must belong to their source chart' }))
      const low = yield* priceNumberToMicros(support.low, 'short support target', 'UP')
      const high = yield* priceNumberToMicros(resistance.high, 'short resistance stop', 'UP')
      yield* add(
        {
          setup: ShortEntrySetup.ResistanceRejection,
          supportBarId: support.id,
          resistanceBarId: resistance.id,
          targetBasis: 'OBSERVED_SUPPORT',
        },
        quantizeInstrumentPriceMicros(chart.symbol, high + 1n, 'UP'),
        quantizeInstrumentPriceMicros(chart.symbol, low + 1n, 'UP'),
      )
    }
    const base = assessments.base
    if (
      base.presence.status === 'ASSESSED' &&
      !chartPresenceIsAbsent(protocol, base.presence.probability) &&
      base.first.status === 'ASSESSED' &&
      base.last.status === 'ASSESSED'
    ) {
      const firstId = base.first.barId
      const lastId = base.last.barId
      const begin = chart.bars.findIndex((b) => b.id === firstId)
      const end = chart.bars.findIndex((b) => b.id === lastId)
      const range = chart.bars.slice(begin, end + 1)
      if (
        begin >= 0 &&
        end > begin &&
        end < chart.bars.length - 1 &&
        range.every((b, i) => i === 0 || range[i - 1]?.minuteBeforeWindowEnd === b.minuteBeforeWindowEnd + 1)
      ) {
        const high = yield* priceNumberToMicros(Math.max(...range.map((b) => b.high)), 'short base high', 'UP')
        const low = yield* priceNumberToMicros(Math.min(...range.map((b) => b.low)), 'short base low', 'DOWN')
        if (high > low && input.askMicros < low)
          yield* add(
            {
              setup: ShortEntrySetup.BaseBreakdown,
              firstBarId: firstId,
              lastBarId: lastId,
              targetBasis: 'PROJECTED_MEASURED_BASE_RANGE',
            },
            quantizeInstrumentPriceMicros(chart.symbol, high + 1n, 'UP'),
            quantizeInstrumentPriceMicros(chart.symbol, low - (high - low), 'UP'),
          )
      }
    }
    return proposals
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Native short proposals could not be funded', cause })),
  )
