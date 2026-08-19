import { Result } from 'effect'

import type { ExecutionModel } from '../../execution-model-contract'
import { canonicalHashV1Result } from '../../hash'
import type { IntradayMarketSnapshot, IntradayQuote } from '../../market-data'
import { calculateSessionFees } from '../execution-model/fees'
import { makeFillTerms, type FillTerms } from '../execution-model/fills'
import {
  desiredQuantityMicros,
  notionalMicros,
  numberToMicros,
  quantizeDown,
  referencePriceMicros,
} from '../execution-model/fixed-point'
import { defaultExecutionModel, MICROS } from '../execution-model/model'
import { decideOpeningDrive } from './decision'
import {
  OpeningDriveQualificationFailure,
  type OpeningDrivePortfolioReplay,
  type OpeningDriveQualificationPolicy,
  type OpeningDriveReplaySessionInput,
  type OpeningDriveSessionReplay,
} from './qualification-model'
import type { OpeningDriveProtocol } from './protocol'

const replayExecutionModel: ExecutionModel = Object.freeze({
  ...defaultExecutionModel,
  priceImpact: Object.freeze({
    halfSpreadBps: 0,
    slippageBps: defaultExecutionModel.priceImpact.slippageBps,
  }),
})

export const openingDriveReplayCostModelDocument = Object.freeze({
  schemaVersion: 'bayn.opening-drive.replay-cost-model.v1',
  entryPriceReference: 'verified-opening-ask',
  exitPriceReference: 'verified-flatten-bid',
  quotedSpreadCost: 'observed-top-of-book-midpoint-distance',
  liquidity: 'minimum-entry-ask-and-exit-bid-top-size',
  adverseSlippageBps: defaultExecutionModel.priceImpact.slippageBps,
  adverseSlippageMultiplier: defaultExecutionModel.doubleCostMultiplier,
  regulatoryFeeMultiplier: defaultExecutionModel.doubleCostMultiplier,
  precision: defaultExecutionModel.precision,
  fees: defaultExecutionModel.fees,
})

const failure = (
  reason: OpeningDriveQualificationFailure['reason'],
  message: string,
  details: Pick<OpeningDriveQualificationFailure, 'sessionDate' | 'symbol' | 'cause'> = {},
): OpeningDriveQualificationFailure => new OpeningDriveQualificationFailure({ reason, message, ...details })

const canonicalHash = (
  value: unknown,
  message: string,
  sessionDate?: string,
): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.mapError(canonicalHashV1Result(value), (cause) =>
    failure('canonicalization', message, { ...(sessionDate === undefined ? {} : { sessionDate }), cause }),
  )

const validateSnapshotIntegrity = (
  snapshot: IntradayMarketSnapshot,
): Result.Result<void, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const { manifest } = snapshot
    if (
      manifest.barCount !== snapshot.bars.length ||
      manifest.quoteCount !== snapshot.quotes.length ||
      manifest.tradeCount !== snapshot.trades.length
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'intraday snapshot counts do not match the bound payload', {
          sessionDate: manifest.sessionDate,
        }),
      )
    }
    const hashes = yield* Result.all({
      bars: canonicalHash(snapshot.bars, 'intraday bars are not canonically hashable', manifest.sessionDate),
      quotes: canonicalHash(snapshot.quotes, 'intraday quotes are not canonically hashable', manifest.sessionDate),
      trades: canonicalHash(snapshot.trades, 'intraday trades are not canonically hashable', manifest.sessionDate),
    })
    if (
      hashes.bars !== manifest.barsContentHash ||
      hashes.quotes !== manifest.quotesContentHash ||
      hashes.trades !== manifest.tradesContentHash
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'intraday snapshot payload hashes do not match its manifest', {
          sessionDate: manifest.sessionDate,
        }),
      )
    }
    const { contentHash, snapshotId, ...material } = manifest
    if (
      (yield* canonicalHash(material, 'intraday manifest is not canonically hashable', manifest.sessionDate)) !==
        contentHash ||
      (yield* canonicalHash(
        { ...material, contentHash },
        'intraday snapshot identity is not canonically hashable',
        manifest.sessionDate,
      )) !== snapshotId
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'intraday snapshot identity does not match its manifest', {
          sessionDate: manifest.sessionDate,
        }),
      )
    }
    const derivedLatest: Record<string, IntradayQuote> = {}
    for (const quote of snapshot.quotes) derivedLatest[quote.symbol] = quote
    if (
      (yield* canonicalHash(derivedLatest, 'latest quotes are not canonically hashable', manifest.sessionDate)) !==
      (yield* canonicalHash(
        snapshot.latestQuotes,
        'bound latest quotes are not canonically hashable',
        manifest.sessionDate,
      ))
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'intraday latest-quote projection does not match the bound quote payload', {
          sessionDate: manifest.sessionDate,
        }),
      )
    }
    return undefined
  })

const sameTopics = (
  left: IntradayMarketSnapshot['manifest']['sourceTopics'],
  right: IntradayMarketSnapshot['manifest']['sourceTopics'],
): boolean => left.bars === right.bars && left.quotes === right.quotes && left.trades === right.trades

const validateExitSnapshot = (
  input: OpeningDriveReplaySessionInput,
  protocol: OpeningDriveProtocol,
): Result.Result<void, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    yield* validateSnapshotIntegrity(input.opening.snapshot)
    yield* validateSnapshotIntegrity(input.exit)
    const opening = input.opening.snapshot.manifest
    const exit = input.exit.manifest
    const close = Date.parse(input.opening.session.closeAt)
    const exitStart = Date.parse(exit.rangeStartAt)
    const exitEnd = Date.parse(exit.rangeEndAt)
    const observed = Date.parse(exit.observedAt)
    const expectedExitEnd = close - protocol.flattenBeforeCloseMinutes * 60_000
    const hardFlatAt = close - protocol.hardFlatBeforeCloseMinutes * 60_000
    if (
      exit.sessionDate !== opening.sessionDate ||
      exit.sessionDate !== input.opening.session.sessionDate ||
      exit.snapshotId === opening.snapshotId ||
      exit.universeId !== opening.universeId ||
      exit.universeSymbolHash !== opening.universeSymbolHash ||
      exit.feed !== opening.feed ||
      exit.delayClass !== opening.delayClass ||
      !sameTopics(exit.sourceTopics, opening.sourceTopics) ||
      exit.symbols.length !== protocol.universe.length ||
      exit.symbols.some((symbol, index) => symbol !== protocol.universe[index])
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'exit snapshot identity does not match the opening decision snapshot', {
          sessionDate: opening.sessionDate,
        }),
      )
    }
    if (
      ![close, exitStart, exitEnd, observed].every(Number.isFinite) ||
      exitStart < Date.parse(opening.rangeEndAt) ||
      exitStart >= exitEnd ||
      exitEnd !== expectedExitEnd ||
      observed < exitEnd ||
      observed > hardFlatAt ||
      input.exit.bars.some((bar) => !bar.final)
    ) {
      return yield* Result.fail(
        failure('snapshot-binding', 'exit snapshot does not bind the frozen flatten window', {
          sessionDate: opening.sessionDate,
        }),
      )
    }
    for (const symbol of protocol.universe) {
      const quote = input.exit.latestQuotes[symbol]
      const eventAt = quote === undefined ? Number.NaN : Date.parse(quote.eventAt)
      const ingestedAt = quote === undefined ? Number.NaN : Date.parse(quote.ingestedAt)
      if (
        quote === undefined ||
        quote.symbol !== symbol ||
        !Number.isFinite(eventAt) ||
        !Number.isFinite(ingestedAt) ||
        eventAt < exitEnd ||
        eventAt > observed ||
        observed - ingestedAt > protocol.maximumQuoteAgeMs ||
        !Number.isFinite(quote.bidPrice) ||
        !Number.isFinite(quote.askPrice) ||
        quote.bidPrice <= 0 ||
        quote.askPrice < quote.bidPrice ||
        !Number.isFinite(quote.bidSize) ||
        !Number.isFinite(quote.askSize) ||
        quote.bidSize < 0 ||
        quote.askSize < 0
      ) {
        return yield* Result.fail(
          failure('snapshot-binding', 'exit snapshot lacks a fresh, executable top-of-book quote', {
            sessionDate: opening.sessionDate,
            symbol,
          }),
        )
      }
    }
    return undefined
  })

interface PositionReplay {
  readonly symbol: string
  readonly quantityMicros: bigint
  readonly entry: FillTerms
  readonly exit: FillTerms
  readonly midpointGrossPnlMicros: bigint
  readonly quotedSpreadCostMicros: bigint
}

const executionFailure = (sessionDate: string, symbol: string, cause: unknown): OpeningDriveQualificationFailure =>
  failure('execution-cost', 'opening-drive replay could not calculate conservative execution terms', {
    sessionDate,
    symbol,
    cause,
  })

const replayPosition = (
  symbol: string,
  weight: number,
  allocationMicros: bigint,
  opening: IntradayQuote,
  exit: IntradayQuote,
  sessionDate: string,
): Result.Result<PositionReplay | null, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const values = yield* Result.mapError(
      Result.all({
        entryBid: referencePriceMicros(opening.bidPrice, replayExecutionModel),
        entryAsk: referencePriceMicros(opening.askPrice, replayExecutionModel),
        exitBid: referencePriceMicros(exit.bidPrice, replayExecutionModel),
        exitAsk: referencePriceMicros(exit.askPrice, replayExecutionModel),
        entrySize: numberToMicros(opening.askSize, 'entry ask size'),
        exitSize: numberToMicros(exit.bidSize, 'exit bid size'),
      }),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const desired = yield* Result.mapError(
      desiredQuantityMicros(allocationMicros, weight, values.entryAsk, replayExecutionModel),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const quantity = yield* Result.mapError(
      quantizeDown(
        [desired, values.entrySize, values.exitSize].reduce((minimum, value) => (value < minimum ? value : minimum)),
        BigInt(replayExecutionModel.precision.quantityIncrementMicros),
      ),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    if (quantity === 0n) return null
    const costMultiplier = BigInt(defaultExecutionModel.doubleCostMultiplier) * MICROS
    const fills = yield* Result.mapError(
      Result.all({
        entry: makeFillTerms('buy', quantity, values.entryAsk, replayExecutionModel, costMultiplier),
        exit: makeFillTerms('sell', quantity, values.exitBid, replayExecutionModel, costMultiplier),
      }),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const entryMidpoint = (values.entryBid + values.entryAsk) / 2n
    const exitMidpoint = (values.exitBid + values.exitAsk) / 2n
    const notionals = yield* Result.mapError(
      Result.all({
        entryMidpoint: notionalMicros(quantity, entryMidpoint),
        exitMidpoint: notionalMicros(quantity, exitMidpoint),
        entrySpread: notionalMicros(quantity, values.entryAsk - entryMidpoint),
        exitSpread: notionalMicros(quantity, exitMidpoint - values.exitBid),
      }),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    return {
      symbol,
      quantityMicros: quantity,
      entry: fills.entry,
      exit: fills.exit,
      midpointGrossPnlMicros: notionals.exitMidpoint - notionals.entryMidpoint,
      quotedSpreadCostMicros: notionals.entrySpread + notionals.exitSpread,
    }
  })

const replayPortfolio = (
  symbols: readonly string[],
  weights: Readonly<Record<string, number>>,
  allocationMicros: bigint,
  opening: IntradayMarketSnapshot,
  exit: IntradayMarketSnapshot,
): Result.Result<OpeningDrivePortfolioReplay, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const positions = (yield* Result.all(
      symbols.map((symbol) => {
        const entryQuote = opening.latestQuotes[symbol]
        const exitQuote = exit.latestQuotes[symbol]
        return entryQuote === undefined || exitQuote === undefined
          ? Result.fail(
              failure('snapshot-binding', 'replay snapshot lacks a required symbol quote', {
                sessionDate: opening.manifest.sessionDate,
                symbol,
              }),
            )
          : replayPosition(
              symbol,
              weights[symbol] ?? 0,
              allocationMicros,
              entryQuote,
              exitQuote,
              opening.manifest.sessionDate,
            )
      }),
    )).filter((position): position is PositionReplay => position !== null)
    const fees = yield* Result.mapError(
      calculateSessionFees(
        positions.flatMap((position) => [
          {
            side: 'buy' as const,
            quantityMicros: position.quantityMicros,
            notionalMicros: position.entry.notionalMicros,
          },
          {
            side: 'sell' as const,
            quantityMicros: position.quantityMicros,
            notionalMicros: position.exit.notionalMicros,
          },
        ]),
        replayExecutionModel,
        BigInt(defaultExecutionModel.doubleCostMultiplier) * MICROS,
      ),
      (cause) => executionFailure(opening.manifest.sessionDate, 'portfolio', cause),
    )
    const midpointGrossPnl = positions.reduce((sum, position) => sum + position.midpointGrossPnlMicros, 0n)
    const quotedSpreadCost = positions.reduce((sum, position) => sum + position.quotedSpreadCostMicros, 0n)
    const slippageCost = positions.reduce(
      (sum, position) => sum + position.entry.slippageCostMicros + position.exit.slippageCostMicros,
      0n,
    )
    const netPnl =
      positions.reduce((sum, position) => sum + position.exit.notionalMicros - position.entry.notionalMicros, 0n) -
      fees.totalMicros
    const replayReturn = Number(netPnl) / Number(allocationMicros)
    if (!Number.isFinite(replayReturn) || replayReturn < -1) {
      return yield* Result.fail(
        failure('statistic', 'opening-drive replay return is outside its finite simple-return domain', {
          sessionDate: opening.manifest.sessionDate,
        }),
      )
    }
    return Object.freeze({
      executedSymbols: Object.freeze(positions.map((position) => position.symbol)),
      midpointGrossPnlMicros: String(midpointGrossPnl),
      quotedSpreadCostMicros: String(quotedSpreadCost),
      slippageCostMicros: String(slippageCost),
      feeCostMicros: String(fees.totalMicros),
      netPnlMicros: String(netPnl),
      return: Number.parseFloat(replayReturn.toFixed(12)),
    })
  })

export const hashOpeningDriveReplayCostModel = (): Result.Result<string, OpeningDriveQualificationFailure> =>
  canonicalHash(openingDriveReplayCostModelDocument, 'opening-drive replay cost model is not canonically hashable')

export const replayOpeningDriveSession = (
  input: OpeningDriveReplaySessionInput,
  protocol: OpeningDriveProtocol,
  policy: OpeningDriveQualificationPolicy,
): Result.Result<OpeningDriveSessionReplay, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    yield* validateExitSnapshot(input, protocol)
    const decision = yield* Result.mapError(decideOpeningDrive(input.opening, protocol), (cause) =>
      failure('strategy-decision', 'opening-drive decision failed during replay', {
        sessionDate: input.opening.session.sessionDate,
        cause,
      }),
    )
    const allocationMicros = BigInt(policy.allocationMicros)
    const benchmarkWeight = 1 / protocol.universe.length
    const benchmarkWeights = Object.fromEntries(protocol.universe.map((symbol) => [symbol, benchmarkWeight]))
    const portfolios = yield* Result.all({
      candidate: replayPortfolio(
        decision.selectedSymbols,
        decision.targetWeights,
        allocationMicros,
        input.opening.snapshot,
        input.exit,
      ),
      benchmark: replayPortfolio(
        protocol.universe,
        benchmarkWeights,
        allocationMicros,
        input.opening.snapshot,
        input.exit,
      ),
    })
    const decisionHash = yield* canonicalHash(
      decision,
      'opening-drive decision is not canonically hashable',
      input.opening.session.sessionDate,
    )
    const material = Object.freeze({
      schemaVersion: 'bayn.opening-drive.session-replay.v1' as const,
      sessionDate: input.opening.session.sessionDate,
      calendarHash: input.opening.session.calendarHash,
      openingSnapshotId: input.opening.snapshot.manifest.snapshotId,
      exitSnapshotId: input.exit.manifest.snapshotId,
      decisionHash,
      candidate: portfolios.candidate,
      benchmark: portfolios.benchmark,
    })
    const receiptHash = yield* canonicalHash(
      material,
      'opening-drive session replay is not canonically hashable',
      material.sessionDate,
    )
    return Object.freeze({ ...material, receiptHash })
  })
