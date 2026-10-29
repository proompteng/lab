import { BigDecimal, Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import { canonicalHashV1Result } from '../hash'
import { PositiveIntegerSchema, Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'
import { numberToMicros, scaledNumber } from '../strategy/execution-model/fixed-point'
import type { NativeChartEvidence } from './chart-evidence'
import type { ChartAssessmentsMaterial } from './chart-questions'
import { JevContractError } from './contract'
import type { JevEntryEconomics } from './entry-economics'
import { jevExitLimitValue } from './liquidation-economics'
import type { JevProtocolMaterial } from './protocol'

export enum EntrySetup {
  SupportRecovery = 'SUPPORT_RECOVERY',
  BaseBreakout = 'BASE_BREAKOUT',
}

const Price = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
const ProposalMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-proposal.v1'),
  symbol: SymbolSchema,
  source: Schema.Union([
    Schema.Struct({
      setup: Schema.Literal(EntrySetup.SupportRecovery),
      supportBarId: Schema.NonEmptyString,
      resistanceBarId: Schema.NonEmptyString,
      targetBasis: Schema.Literal('OBSERVED_RESISTANCE'),
    }),
    Schema.Struct({
      setup: Schema.Literal(EntrySetup.BaseBreakout),
      firstBarId: Schema.NonEmptyString,
      lastBarId: Schema.NonEmptyString,
      targetBasis: Schema.Literal('PROJECTED_MEASURED_BASE_RANGE'),
    }),
  ]),
  barsHash: Sha256Schema,
  chartAssessmentsHash: Sha256Schema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  maximumEntryPriceMicros: Price,
  stopPriceMicros: Price,
  stopLimitPriceMicros: Price,
  profitLimitPriceMicros: Price,
  funding: Schema.Struct({
    maximumQuantityAtoms: Price,
    receivedQuantityAtoms: Price,
    maximumTargetWeight: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
    acquisitionCostMicros: Price,
    estimatedStopNetMicros: Price,
    estimatedTargetNetMicros: Price,
  }),
})
export const EntryProposalSchema = Schema.Struct({ ...ProposalMaterial.fields, proposalId: Sha256Schema }).check(
  Schema.makeFilter((proposal) => {
    const { proposalId, ...material } = proposal
    const hash = canonicalHashV1Result(material)
    return Date.parse(proposal.sourceStartAt) < Date.parse(proposal.sourceEndAt) &&
      BigInt(proposal.stopLimitPriceMicros) <= BigInt(proposal.stopPriceMicros) &&
      BigInt(proposal.stopPriceMicros) < BigInt(proposal.maximumEntryPriceMicros) &&
      BigInt(proposal.maximumEntryPriceMicros) < BigInt(proposal.profitLimitPriceMicros) &&
      BigInt(proposal.funding.estimatedStopNetMicros) < BigInt(proposal.funding.acquisitionCostMicros) &&
      BigInt(proposal.funding.acquisitionCostMicros) < BigInt(proposal.funding.estimatedTargetNetMicros) &&
      BigInt(proposal.funding.receivedQuantityAtoms) <= BigInt(proposal.funding.maximumQuantityAtoms) &&
      Result.isSuccess(hash) &&
      hash.success === proposalId
      ? []
      : [{ path: [], issue: 'proposal prices, funding, source interval and identity must agree' }]
  }),
)
export type EntryProposal = typeof EntryProposalSchema.Type

export enum ProposalRejection {
  NoQuantity = 'NO_BUY_QUANTITY',
  ChartRefused = 'CHART_EVIDENCE_REFUSED',
  NoStructure = 'STRUCTURE_NOT_IDENTIFIED',
  IncoherentStructure = 'SOURCE_STRUCTURE_INCOHERENT',
  InvalidPrices = 'INVALID_PROTECTIVE_PRICES',
  Unfunded = 'TARGET_DOES_NOT_COVER_COSTS',
}

export const entrySourcePriceMicros = (value: number) =>
  Result.gen(function* () {
    yield* numberToMicros(value, 'proposal source price')
    const rounded = BigDecimal.round(BigDecimal.fromNumberUnsafe(value), { scale: 6, mode: 'floor' })
    return yield* scaledNumber(Number(BigDecimal.scale(rounded, 6).value), 'proposal source price', 1)
  })

type ProposalFundingInput = {
  readonly symbol: string
  readonly economics: JevEntryEconomics
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
  readonly stop: bigint
  readonly target: bigint
}

const fundProposalPrices = (input: ProposalFundingInput) =>
  Result.gen(function* () {
    const { symbol, economics, protocol, bidMicros, stop, target } = input
    const stopLimit = quantizeInstrumentPriceMicros(
      symbol,
      (stop * BigInt(10_000 - protocol.maximumEntryLimitSlippageBps) + 9_999n) / 10_000n,
      'UP',
    )
    if (stopLimit <= 0n || stopLimit > stop || stop >= bidMicros || target <= BigInt(economics.maximumEntryPriceMicros))
      return { status: 'REJECTED', reason: ProposalRejection.InvalidPrices } as const
    const liquidation = { protocol, symbol, quantityAtoms: BigInt(economics.receivedQuantityAtoms) }
    const stopValue = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: stopLimit })
    const targetValue = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: target })
    const acquisition = BigInt(economics.acquisitionCostMicros)
    if (
      stopValue.conservativeNetMicros <= 0n ||
      stopValue.conservativeNetMicros >= acquisition ||
      targetValue.conservativeNetMicros <= acquisition
    )
      return { status: 'REJECTED', reason: ProposalRejection.Unfunded } as const
    return {
      status: 'FUNDED',
      stopLimit,
      stopNet: stopValue.conservativeNetMicros,
      targetNet: targetValue.conservativeNetMicros,
    } as const
  })

// Reproduce the preflight of immutable v2 and v3 financial evidence.
export const mayHaveRetainedFundableSourceProposal = (input: {
  readonly chart: NativeChartEvidence
  readonly economics: JevEntryEconomics
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
}) =>
  Result.gen(function* () {
    const { chart, economics, protocol, bidMicros } = input
    const entrySourcePriceMicross = chart.bars.map((bar) =>
      Result.all({ high: entrySourcePriceMicros(bar.high), low: entrySourcePriceMicros(bar.low) }),
    )
    // An unselected, unrepresentable bar cannot prove that every selectable proposal is unfundable.
    if (entrySourcePriceMicross.some(Result.isFailure)) return true
    const prices = yield* Result.all(entrySourcePriceMicross)
    const highest = prices.reduce((maximum, price) => (price.high > maximum ? price.high : maximum), 0n)
    const target = quantizeInstrumentPriceMicros(chart.symbol, highest - 1n, 'DOWN')
    for (const price of prices) {
      const funding = yield* fundProposalPrices({
        symbol: chart.symbol,
        economics,
        protocol,
        bidMicros,
        stop: quantizeInstrumentPriceMicros(chart.symbol, price.low - 1n, 'DOWN'),
        target,
      })
      if (funding.status === 'FUNDED') return true
    }
    for (const [first, initial] of prices.entries()) {
      let high = initial.high
      let low = initial.low
      for (let last = first + 1; last < prices.length - 1; last++) {
        const previousBar = chart.bars[last - 1]
        const lastBar = chart.bars[last]
        const price = prices[last]
        if (previousBar === undefined || lastBar === undefined || price === undefined)
          return yield* Result.fail(new JevContractError({ message: 'Source feasibility window is inconsistent' }))
        if (previousBar.minuteBeforeWindowEnd !== lastBar.minuteBeforeWindowEnd + 1) break
        high = price.high > high ? price.high : high
        low = price.low < low ? price.low : low
        if (high <= low || bidMicros <= high) continue
        const funding = yield* fundProposalPrices({
          symbol: chart.symbol,
          economics,
          protocol,
          bidMicros,
          stop: quantizeInstrumentPriceMicros(chart.symbol, low - 1n, 'DOWN'),
          target: quantizeInstrumentPriceMicros(chart.symbol, high + high - low, 'DOWN'),
        })
        if (funding.status === 'FUNDED') return true
      }
    }
    return false
  })

export interface EntrySourceCandidates {
  readonly supportBarIds: readonly string[]
  readonly resistanceBarIds: readonly string[]
  readonly baseWindows: readonly {
    readonly firstBarId: string
    readonly lastBarId: string
  }[]
}

export const makeEntrySourceCandidates = (input: {
  readonly chart: NativeChartEvidence
  readonly economics: JevEntryEconomics
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
}) =>
  Result.gen(function* () {
    const { chart, economics, protocol, bidMicros } = input
    const prices = chart.bars.map((bar) => ({
      high: entrySourcePriceMicros(bar.high),
      low: entrySourcePriceMicros(bar.low),
    }))
    let highest = 0n
    for (const price of prices)
      if (Result.isSuccess(price.high) && price.high.success > highest) highest = price.high.success
    const supportBarIds: string[] = []
    const resistanceBarIds: string[] = []
    const baseWindows: { firstBarId: string; lastBarId: string }[] = []
    if (highest === 0n) return { supportBarIds, resistanceBarIds, baseWindows } satisfies EntrySourceCandidates
    let admittedStop: bigint | undefined
    const greatestTarget = quantizeInstrumentPriceMicros(chart.symbol, highest - 1n, 'DOWN')
    for (const [index, price] of prices.entries()) {
      const bar = chart.bars[index]
      if (bar === undefined || Result.isFailure(price.low)) continue
      const stop = quantizeInstrumentPriceMicros(chart.symbol, price.low.success - 1n, 'DOWN')
      const funding = yield* fundProposalPrices({ ...input, symbol: chart.symbol, stop, target: greatestTarget })
      if (funding.status === 'FUNDED') {
        supportBarIds.push(bar.id)
        admittedStop ??= stop
      }
    }
    if (admittedStop !== undefined)
      for (const [index, price] of prices.entries()) {
        const bar = chart.bars[index]
        if (bar === undefined || Result.isFailure(price.high)) continue
        const target = quantizeInstrumentPriceMicros(chart.symbol, price.high.success - 1n, 'DOWN')
        const funding = yield* fundProposalPrices({ ...input, symbol: chart.symbol, stop: admittedStop, target })
        if (funding.status === 'FUNDED') resistanceBarIds.push(bar.id)
      }
    for (const [first, initial] of prices.entries()) {
      const firstBar = chart.bars[first]
      if (firstBar === undefined || Result.isFailure(initial.high) || Result.isFailure(initial.low)) continue
      let high = initial.high.success
      let low = initial.low.success
      for (let last = first + 1; last < prices.length - 1; last++) {
        const previousBar = chart.bars[last - 1]
        const lastBar = chart.bars[last]
        const price = prices[last]
        if (
          previousBar === undefined ||
          lastBar === undefined ||
          price === undefined ||
          Result.isFailure(price.high) ||
          Result.isFailure(price.low) ||
          previousBar.minuteBeforeWindowEnd !== lastBar.minuteBeforeWindowEnd + 1
        )
          break
        high = price.high.success > high ? price.high.success : high
        low = price.low.success < low ? price.low.success : low
        if (high <= low || bidMicros <= high) continue
        const funding = yield* fundProposalPrices({
          symbol: chart.symbol,
          economics,
          protocol,
          bidMicros,
          stop: quantizeInstrumentPriceMicros(chart.symbol, low - 1n, 'DOWN'),
          target: quantizeInstrumentPriceMicros(chart.symbol, high + high - low, 'DOWN'),
        })
        if (funding.status === 'FUNDED') baseWindows.push({ firstBarId: firstBar.id, lastBarId: lastBar.id })
      }
    }
    return { supportBarIds, resistanceBarIds, baseWindows } satisfies EntrySourceCandidates
  })

export const makeEntryProposals = (input: {
  readonly chart: NativeChartEvidence
  readonly assessments: ChartAssessmentsMaterial
  readonly economics: JevEntryEconomics
  readonly protocol: JevProtocolMaterial
  readonly bidMicros: bigint
}) =>
  Result.gen(function* () {
    const { chart, assessments, economics, protocol, bidMicros } = input
    if (
      assessments.symbol !== chart.symbol ||
      assessments.windowEndAt !== chart.windowEndAt ||
      assessments.barsHash !== chart.barsHash ||
      assessments.pngHash !== chart.pngHash ||
      economics.maximumHoldingMinutes !== protocol.maximumHoldingMinutes
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Proposal source, chart judgments, economics or holding policy differ' }),
      )
    const chartAssessmentsHash = yield* canonicalHashV1Result(assessments)
    const proposals: EntryProposal[] = []
    const rejections: { readonly setup: EntrySetup; readonly reason: ProposalRejection }[] = []
    const reject = (setup: EntrySetup, reason: ProposalRejection) => {
      rejections.push({ setup, reason })
    }
    const barFor = (id: string) => {
      const bar = chart.bars.find((value) => value.id === id)
      return bar === undefined
        ? Result.fail(new JevContractError({ message: 'Chart judgment selected a bar outside its source' }))
        : Result.succeed(bar)
    }
    const firstSource = chart.bars[0]
    if (firstSource === undefined)
      return yield* Result.fail(new JevContractError({ message: 'Proposal requires identified source bars' }))
    const add = (source: typeof ProposalMaterial.fields.source.Type, stop: bigint, target: bigint) =>
      Result.gen(function* () {
        const funding = yield* fundProposalPrices({
          symbol: chart.symbol,
          economics,
          protocol,
          bidMicros,
          stop,
          target,
        })
        if (funding.status === 'REJECTED') {
          reject(source.setup, funding.reason)
          return
        }
        const material = yield* Schema.decodeUnknownResult(ProposalMaterial)({
          schemaVersion: 'bayn.entry-proposal.v1',
          symbol: chart.symbol,
          source,
          barsHash: chart.barsHash,
          chartAssessmentsHash,
          sourceStartAt: firstSource.timestamp,
          sourceEndAt: chart.windowEndAt,
          maximumHoldingMinutes: protocol.maximumHoldingMinutes,
          maximumEntryPriceMicros: economics.maximumEntryPriceMicros,
          stopPriceMicros: stop.toString(),
          stopLimitPriceMicros: funding.stopLimit.toString(),
          profitLimitPriceMicros: target.toString(),
          funding: {
            maximumQuantityAtoms: economics.maximumQuantityAtoms,
            receivedQuantityAtoms: economics.receivedQuantityAtoms,
            maximumTargetWeight: economics.maximumTargetWeight,
            acquisitionCostMicros: economics.acquisitionCostMicros,
            estimatedStopNetMicros: funding.stopNet.toString(),
            estimatedTargetNetMicros: funding.targetNet.toString(),
          },
        })
        proposals.push({ ...material, proposalId: yield* canonicalHashV1Result(material) })
      })

    const { support, resistance, base } = assessments
    if (support.anchor.status === 'NOT_IDENTIFIED' || resistance.anchor.status === 'NOT_IDENTIFIED') {
      reject(EntrySetup.SupportRecovery, ProposalRejection.NoStructure)
    } else if (
      support.presence.status === 'REFUSED' ||
      resistance.presence.status === 'REFUSED' ||
      support.anchor.status === 'REFUSED' ||
      resistance.anchor.status === 'REFUSED'
    ) {
      reject(EntrySetup.SupportRecovery, ProposalRejection.ChartRefused)
    } else {
      const supportBar = yield* barFor(support.anchor.barId)
      const resistanceBar = yield* barFor(resistance.anchor.barId)
      const low = yield* entrySourcePriceMicros(supportBar.low)
      const high = yield* entrySourcePriceMicros(resistanceBar.high)
      yield* add(
        {
          setup: EntrySetup.SupportRecovery,
          supportBarId: supportBar.id,
          resistanceBarId: resistanceBar.id,
          targetBasis: 'OBSERVED_RESISTANCE',
        },
        quantizeInstrumentPriceMicros(chart.symbol, low - 1n, 'DOWN'),
        quantizeInstrumentPriceMicros(chart.symbol, high - 1n, 'DOWN'),
      )
    }
    if (base.first.status === 'NOT_IDENTIFIED' || base.last.status === 'NOT_IDENTIFIED') {
      reject(EntrySetup.BaseBreakout, ProposalRejection.NoStructure)
    } else if (
      base.presence.status === 'REFUSED' ||
      base.first.status === 'REFUSED' ||
      base.last.status === 'REFUSED'
    ) {
      reject(EntrySetup.BaseBreakout, ProposalRejection.ChartRefused)
    } else {
      const first = yield* barFor(base.first.barId)
      const last = yield* barFor(base.last.barId)
      const newest = chart.bars.at(-1)
      const range = chart.bars.filter((bar) => bar.timestamp >= first.timestamp && bar.timestamp <= last.timestamp)
      if (
        first.timestamp >= last.timestamp ||
        newest === undefined ||
        last.timestamp >= newest.timestamp ||
        range.some(
          (bar, index) => index > 0 && range[index - 1]?.minuteBeforeWindowEnd !== bar.minuteBeforeWindowEnd + 1,
        )
      ) {
        reject(EntrySetup.BaseBreakout, ProposalRejection.IncoherentStructure)
      } else {
        const highs = yield* Result.all(range.map((bar) => entrySourcePriceMicros(bar.high)))
        const lows = yield* Result.all(range.map((bar) => entrySourcePriceMicros(bar.low)))
        const high = highs.reduce((maximum, value) => (value > maximum ? value : maximum), 0n)
        const low = lows.reduce((minimum, value) => (value < minimum ? value : minimum), high)
        if (high <= low || bidMicros <= high) reject(EntrySetup.BaseBreakout, ProposalRejection.IncoherentStructure)
        else
          yield* add(
            {
              setup: EntrySetup.BaseBreakout,
              firstBarId: first.id,
              lastBarId: last.id,
              targetBasis: 'PROJECTED_MEASURED_BASE_RANGE',
            },
            quantizeInstrumentPriceMicros(chart.symbol, low - 1n, 'DOWN'),
            quantizeInstrumentPriceMicros(chart.symbol, high + high - low, 'DOWN'),
          )
      }
    }
    return { proposals, rejections }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Source-anchored entry proposals could not be reproduced', cause }),
    ),
  )
