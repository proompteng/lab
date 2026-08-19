import { Result } from 'effect'

import type { ExecutionModel } from '../../execution-model-contract'
import { canonicalHashV1Result } from '../../hash'
import { reverifyIntradayMarketSnapshot, type IntradayMarketSnapshot, type IntradayQuote } from '../../market-data'
import { scaleQuantityMicros } from '../execution-model/cash'
import { calculateSessionFees } from '../execution-model/fees'
import { makeFillTerms, type FillTerms } from '../execution-model/fills'
import {
  desiredQuantityMicros,
  notionalMicros,
  numberToMicros,
  quantizeDown,
  referencePriceMicros,
} from '../execution-model/fixed-point'
import { MICROS, PPM } from '../execution-model/model'
import { decideOpeningDrive } from './decision'
import {
  OpeningDriveQualificationFailure,
  type OpeningDrivePortfolioReplay,
  type OpeningDriveQualificationPolicy,
  type OpeningDriveReplaySessionInput,
  type OpeningDriveSessionReplay,
} from './qualification-model'
import type { OpeningDriveProtocol } from './protocol'

const replayExecutionModelFor = (protocol: OpeningDriveProtocol): ExecutionModel =>
  Object.freeze({
    ...protocol.executionModel,
    priceImpact: Object.freeze({
      halfSpreadBps: 0,
      slippageBps: protocol.executionModel.priceImpact.slippageBps,
    }),
  })

export const openingDriveReplayCostModelDocument = (protocol: OpeningDriveProtocol) =>
  Object.freeze({
    schemaVersion: 'bayn.opening-drive.replay-cost-model.v1' as const,
    entryPriceReference: 'verified-opening-ask' as const,
    exitPriceReference: 'verified-flatten-bid' as const,
    quotedSpreadCost: 'observed-top-of-book-midpoint-distance' as const,
    liquidity: 'entry-sized-from-entry-ask; exit-filled-at-exit-bid; residual-zero-marked-and-rejected' as const,
    adverseSlippageBps: protocol.executionModel.priceImpact.slippageBps,
    adverseSlippageMultiplier: protocol.executionModel.doubleCostMultiplier,
    regulatoryFeeMultiplier: protocol.executionModel.doubleCostMultiplier,
    precision: Object.freeze({ ...protocol.executionModel.precision }),
    fees: Object.freeze({ ...protocol.executionModel.fees }),
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
  Result.map(
    Result.mapError(reverifyIntradayMarketSnapshot(snapshot), (cause) =>
      failure('snapshot-binding', 'intraday snapshot failed authoritative row verification', {
        sessionDate: snapshot.manifest.sessionDate,
        cause,
      }),
    ),
    () => undefined,
  )

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
      if (
        quote === undefined ||
        quote.symbol !== symbol ||
        !Number.isFinite(eventAt) ||
        eventAt < exitEnd ||
        eventAt > observed ||
        observed - eventAt > protocol.maximumQuoteAgeMs ||
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
  readonly entryQuantityMicros: bigint
  readonly exitQuantityMicros: bigint
  readonly unclosedQuantityMicros: bigint
  readonly entry: FillTerms
  readonly exit: FillTerms | null
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
  exitQuote: IntradayQuote,
  sessionDate: string,
  executionModel: ExecutionModel,
  scalePpm: bigint,
): Result.Result<PositionReplay | null, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const values = yield* Result.mapError(
      Result.all({
        entryBid: referencePriceMicros(opening.bidPrice, executionModel),
        entryAsk: referencePriceMicros(opening.askPrice, executionModel),
        exitBid: referencePriceMicros(exitQuote.bidPrice, executionModel),
        exitAsk: referencePriceMicros(exitQuote.askPrice, executionModel),
        entrySize: numberToMicros(opening.askSize, 'entry ask size'),
        exitSize: numberToMicros(exitQuote.bidSize, 'exit bid size'),
      }),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const desired = yield* Result.mapError(
      Result.flatMap(
        makeFillTerms(
          'buy',
          BigInt(executionModel.precision.quantityIncrementMicros),
          values.entryAsk,
          executionModel,
          BigInt(executionModel.doubleCostMultiplier) * MICROS,
        ),
        (minimumEntry) => desiredQuantityMicros(allocationMicros, weight, minimumEntry.fillPriceMicros, executionModel),
      ),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const scaledDesired = yield* Result.mapError(scaleQuantityMicros(desired, scalePpm, executionModel), (cause) =>
      executionFailure(sessionDate, symbol, cause),
    )
    const quantity = yield* Result.mapError(
      quantizeDown(
        scaledDesired < values.entrySize ? scaledDesired : values.entrySize,
        BigInt(executionModel.precision.quantityIncrementMicros),
      ),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    if (quantity === 0n) return null
    const costMultiplier = BigInt(executionModel.doubleCostMultiplier) * MICROS
    const entryReferenceNotional = yield* Result.mapError(notionalMicros(quantity, values.entryAsk), (cause) =>
      executionFailure(sessionDate, symbol, cause),
    )
    if (entryReferenceNotional < BigInt(executionModel.precision.minimumBuyNotionalMicros)) return null
    const entry = yield* Result.mapError(
      makeFillTerms('buy', quantity, values.entryAsk, executionModel, costMultiplier),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const exitQuantity = yield* Result.mapError(
      quantizeDown(
        quantity < values.exitSize ? quantity : values.exitSize,
        BigInt(executionModel.precision.quantityIncrementMicros),
      ),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    const exitFill =
      exitQuantity === 0n
        ? null
        : yield* Result.mapError(
            makeFillTerms('sell', exitQuantity, values.exitBid, executionModel, costMultiplier),
            (cause) => executionFailure(sessionDate, symbol, cause),
          )
    const entryMidpoint = (values.entryBid + values.entryAsk) / 2n
    const exitMidpoint = (values.exitBid + values.exitAsk) / 2n
    const notionals = yield* Result.mapError(
      Result.all({
        entryMidpoint: notionalMicros(quantity, entryMidpoint),
        exitMidpoint: notionalMicros(exitQuantity, exitMidpoint),
        entrySpread: notionalMicros(quantity, values.entryAsk - entryMidpoint),
        exitSpread: notionalMicros(exitQuantity, exitMidpoint - values.exitBid),
      }),
      (cause) => executionFailure(sessionDate, symbol, cause),
    )
    return {
      symbol,
      entryQuantityMicros: quantity,
      exitQuantityMicros: exitQuantity,
      unclosedQuantityMicros: quantity - exitQuantity,
      entry,
      exit: exitFill,
      midpointGrossPnlMicros: notionals.exitMidpoint - notionals.entryMidpoint,
      quotedSpreadCostMicros: notionals.entrySpread + notionals.exitSpread,
    }
  })

const entryFees = (
  positions: readonly PositionReplay[],
  sessionDate: string,
  executionModel: ExecutionModel,
): Result.Result<bigint, OpeningDriveQualificationFailure> =>
  Result.map(
    Result.mapError(
      calculateSessionFees(
        positions.map((position) => ({
          side: 'buy' as const,
          quantityMicros: position.entryQuantityMicros,
          notionalMicros: position.entry.notionalMicros,
        })),
        executionModel,
        BigInt(executionModel.doubleCostMultiplier) * MICROS,
      ),
      (cause) => executionFailure(sessionDate, 'portfolio-entry', cause),
    ),
    (fees) => fees.totalMicros,
  )

const maximumAffordableScale = (
  minimum: bigint,
  maximum: bigint,
  affordable: (candidate: bigint) => Result.Result<boolean, OpeningDriveQualificationFailure>,
): Result.Result<bigint, OpeningDriveQualificationFailure> => {
  if (minimum >= maximum) return Result.succeed(minimum)
  const candidate = (minimum + maximum + 1n) / 2n
  return Result.flatMap(affordable(candidate), (accepted) =>
    accepted
      ? maximumAffordableScale(candidate, maximum, affordable)
      : maximumAffordableScale(minimum, candidate - 1n, affordable),
  )
}

const replayPortfolio = (
  symbols: readonly string[],
  weights: Readonly<Record<string, number>>,
  allocationMicros: bigint,
  opening: IntradayMarketSnapshot,
  exit: IntradayMarketSnapshot,
  executionModel: ExecutionModel,
): Result.Result<OpeningDrivePortfolioReplay, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const positionsAtScale = (scalePpm: bigint) =>
      Result.map(
        Result.all(
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
                  executionModel,
                  scalePpm,
                )
          }),
        ),
        (values) => values.filter((position): position is PositionReplay => position !== null),
      )
    const affordableScale = yield* maximumAffordableScale(0n, PPM, (scalePpm) =>
      Result.flatMap(positionsAtScale(scalePpm), (positions) =>
        Result.map(
          entryFees(positions, opening.manifest.sessionDate, executionModel),
          (fees) => positions.reduce((sum, position) => sum + position.entry.notionalMicros, fees) <= allocationMicros,
        ),
      ),
    )
    const positions = yield* positionsAtScale(affordableScale)
    const entryNotional = positions.reduce((sum, position) => sum + position.entry.notionalMicros, 0n)
    const entryFeeCost = yield* entryFees(positions, opening.manifest.sessionDate, executionModel)
    if (entryNotional + entryFeeCost > allocationMicros) {
      return yield* Result.fail(
        failure('execution-cost', 'modeled opening-drive entries and buy-side fees exceed the cash allocation', {
          sessionDate: opening.manifest.sessionDate,
        }),
      )
    }
    const fees = yield* Result.mapError(
      calculateSessionFees(
        positions.flatMap((position) => {
          const entryOrder = {
            side: 'buy' as const,
            quantityMicros: position.entryQuantityMicros,
            notionalMicros: position.entry.notionalMicros,
          }
          return position.exit === null
            ? [entryOrder]
            : [
                entryOrder,
                {
                  side: 'sell' as const,
                  quantityMicros: position.exitQuantityMicros,
                  notionalMicros: position.exit.notionalMicros,
                },
              ]
        }),
        executionModel,
        BigInt(executionModel.doubleCostMultiplier) * MICROS,
      ),
      (cause) => executionFailure(opening.manifest.sessionDate, 'portfolio', cause),
    )
    const midpointGrossPnl = positions.reduce((sum, position) => sum + position.midpointGrossPnlMicros, 0n)
    const quotedSpreadCost = positions.reduce((sum, position) => sum + position.quotedSpreadCostMicros, 0n)
    const slippageCost = positions.reduce(
      (sum, position) => sum + position.entry.slippageCostMicros + (position.exit?.slippageCostMicros ?? 0n),
      0n,
    )
    const exitNotional = positions.reduce((sum, position) => sum + (position.exit?.notionalMicros ?? 0n), 0n)
    const unclosedQuantity = positions.reduce((sum, position) => sum + position.unclosedQuantityMicros, 0n)
    const netPnl = exitNotional - entryNotional - fees.totalMicros
    const replayReturn = unclosedQuantity > 0n ? -1 : Number(netPnl) / Number(allocationMicros)
    if (!Number.isFinite(replayReturn) || replayReturn < -1) {
      return yield* Result.fail(
        failure('statistic', 'opening-drive replay return is outside its finite simple-return domain', {
          sessionDate: opening.manifest.sessionDate,
        }),
      )
    }
    return Object.freeze({
      executedSymbols: Object.freeze(positions.map((position) => position.symbol)),
      entryNotionalMicros: String(entryNotional),
      exitNotionalMicros: String(exitNotional),
      unclosedQuantityMicros: String(unclosedQuantity),
      flat: unclosedQuantity === 0n,
      midpointGrossPnlMicros: String(midpointGrossPnl),
      quotedSpreadCostMicros: String(quotedSpreadCost),
      slippageCostMicros: String(slippageCost),
      feeCostMicros: String(fees.totalMicros),
      netPnlMicros: String(netPnl),
      return: Number.parseFloat(replayReturn.toFixed(12)),
    })
  })

export const hashOpeningDriveReplayCostModel = (
  protocol: OpeningDriveProtocol,
): Result.Result<string, OpeningDriveQualificationFailure> =>
  canonicalHash(
    openingDriveReplayCostModelDocument(protocol),
    'opening-drive replay cost model is not canonically hashable',
  )

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
    const executionModel = replayExecutionModelFor(protocol)
    const benchmarkWeight = 1 / protocol.universe.length
    const benchmarkWeights = Object.fromEntries(protocol.universe.map((symbol) => [symbol, benchmarkWeight]))
    const portfolios = yield* Result.all({
      candidate: replayPortfolio(
        decision.selectedSymbols,
        decision.targetWeights,
        allocationMicros,
        input.opening.snapshot,
        input.exit,
        executionModel,
      ),
      benchmark: replayPortfolio(
        protocol.universe,
        benchmarkWeights,
        allocationMicros,
        input.opening.snapshot,
        input.exit,
        executionModel,
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
