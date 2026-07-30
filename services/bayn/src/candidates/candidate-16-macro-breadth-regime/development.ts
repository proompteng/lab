import { pipe, Result } from 'effect'

import {
  buildCandidateDevelopmentComparisonSemanticsEvidence,
  candidateDevelopmentCalendarContract,
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentPreflightPass,
} from '../../candidate-development'
import {
  accrueCashYield,
  calculateSessionFees,
  elapsedCalendarDays,
  makeFillTerms,
  makeOrderOutcome,
  MICROS,
  notionalMicros,
  referencePriceMicros,
  saleCostBasisMicros,
  type FeeInput,
} from '../../execution-model'
import { canonicalHashV1Result } from '../../hash'
import { prepareQualificationSeries } from '../../qualification-statistics'
import {
  buildVerdict,
  directVolatilityWeights,
  simulate,
  type AlignedSession,
  type SimulationResult,
  type SimulationTarget,
} from '../../simulation'
import { makeCashChange, makeFeeEvent, makeFill } from '../../simulation/evidence'
import { calculateExactPerformanceMetrics } from '../../simulation/metrics'
import { referencePricesFor } from '../../simulation/valuation'
import { reconcileMarkedEquity } from '../../simulation-reconciliation'
import {
  ContractVersion,
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type CashChange,
  type DailyPerformancePoint,
  type DailyPositionMark,
  type DecisionEvent,
  type EvaluationEvent,
  type EvaluationResult,
  type InputManifest,
  type IsoDate,
  type SignalDecision,
  type SimulatedOrder,
  type SimulationProtocol,
  type SimulationTrace,
} from '../../types'
import {
  CANDIDATE_16_DEVELOPMENT_END,
  CANDIDATE_16_DEVELOPMENT_START,
  CANDIDATE_16_PREREGISTRATION_COMMIT,
  CANDIDATE_16_PREREGISTRATION_SHA256,
  CANDIDATE_16_SNAPSHOT_ID,
  CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
  candidate16BehaviorMaterial,
  candidate16DevelopmentSessions,
  candidate16PriorAttemptIds,
  candidate16SimulationProtocol,
  candidate16StrategyProtocolMaterial,
  candidate16Universe,
  type Candidate16CostReplay,
  type Candidate16Dataset,
  type Candidate16DevelopmentEvaluation,
  type Candidate16Failure,
  type Candidate16PreparedData,
  type Candidate16Registration,
  type Candidate16Symbol,
} from './model'
import { buildCandidate16Plan } from './strategy'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate16Failure> =>
  Result.fail({ _tag: 'Candidate16InvalidInput', operation, reason })

const canonicalHash = (operation: string, material: unknown): Result.Result<string, Candidate16Failure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): Candidate16Failure => ({ _tag: 'Candidate16HashFailure', operation, cause })),
  )

const exactStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((date, index) => date === right[index])

const exactDates = (left: readonly IsoDate[], right: readonly IsoDate[]): boolean => exactStrings(left, right)

export const candidate16FinalizedSnapshotCoversDevelopment = (
  snapshot: Candidate16Dataset['finalizedSnapshot'],
): Result.Result<void, Candidate16Failure> => {
  if (snapshot.snapshotId !== CANDIDATE_16_SNAPSHOT_ID) {
    return fail('dataset', `finalized snapshot ${snapshot.snapshotId} differs from Candidate 16`)
  }
  if (
    snapshot.requestedStart > CANDIDATE_16_DEVELOPMENT_START ||
    snapshot.firstSession > CANDIDATE_16_DEVELOPMENT_START ||
    snapshot.lastSession < CANDIDATE_16_DEVELOPMENT_END ||
    snapshot.asOfSession < CANDIDATE_16_DEVELOPMENT_END
  ) {
    return fail(
      'dataset',
      `finalized snapshot ${snapshot.firstSession}..${snapshot.lastSession} as-of ${snapshot.asOfSession} does not cover the frozen development subset`,
    )
  }
  if (
    snapshot.calendarVersion !== candidateDevelopmentCalendarContract.calendarVersion ||
    !exactStrings(snapshot.symbols, candidate16Universe)
  ) {
    return fail('dataset', 'finalized snapshot calendar or universe differs from Candidate 16')
  }
  return Result.succeed(undefined)
}

export const candidate16DatasetHashes = (
  sessions: readonly IsoDate[],
  bars: Candidate16Dataset['bars'],
): Result.Result<{ readonly sessionsContentHash: string; readonly barsContentHash: string }, Candidate16Failure> =>
  Result.all({
    sessionsContentHash: canonicalHash('development-sessions', {
      schemaVersion: 'bayn.candidate-16-development-sessions.v1',
      snapshotId: CANDIDATE_16_SNAPSHOT_ID,
      sessions,
    }),
    barsContentHash: canonicalHash('development-bars', {
      schemaVersion: 'bayn.candidate-16-development-bars.v1',
      snapshotId: CANDIDATE_16_SNAPSHOT_ID,
      universe: candidate16Universe,
      bars,
    }),
  })

const validDatasetBar = (bar: Candidate16Dataset['bars'][number]): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

export const prepareCandidate16DevelopmentData = (
  dataset: Candidate16Dataset,
): Result.Result<Candidate16PreparedData, Candidate16Failure> => {
  const expectedSessions = candidate16DevelopmentSessions()
  if (dataset.snapshotId !== CANDIDATE_16_SNAPSHOT_ID) {
    return fail('dataset', `snapshot ${dataset.snapshotId} differs from ${CANDIDATE_16_SNAPSHOT_ID}`)
  }
  const snapshot = dataset.finalizedSnapshot
  const snapshotCoverage = candidate16FinalizedSnapshotCoversDevelopment(snapshot)
  if (Result.isFailure(snapshotCoverage)) return Result.fail(snapshotCoverage.failure)
  if (!exactDates(dataset.sessions, expectedSessions)) return fail('dataset', 'official development sessions differ')
  const expectedBarCount = expectedSessions.length * candidate16Universe.length
  if (dataset.bars.length !== expectedBarCount) {
    return fail('dataset', `expected ${expectedBarCount} bars, observed ${dataset.bars.length}`)
  }
  return pipe(
    candidate16DatasetHashes(dataset.sessions, dataset.bars),
    Result.flatMap((hashes) => {
      if (hashes.sessionsContentHash !== dataset.sessionsContentHash) {
        return fail('dataset', 'sessions content hash differs')
      }
      if (hashes.barsContentHash !== dataset.barsContentHash) return fail('dataset', 'bars content hash differs')
      const sessions: AlignedSession[] = []
      for (let sessionIndex = 0; sessionIndex < expectedSessions.length; sessionIndex += 1) {
        const date = expectedSessions.at(sessionIndex)
        if (date === undefined) return fail('dataset', `session ${sessionIndex} is missing`)
        const bars: Partial<Record<Candidate16Symbol, AlignedSession['bars'][string]>> = {}
        for (let symbolIndex = 0; symbolIndex < candidate16Universe.length; symbolIndex += 1) {
          const symbol = candidate16Universe.at(symbolIndex)
          const bar = dataset.bars.at(sessionIndex * candidate16Universe.length + symbolIndex)
          if (symbol === undefined || bar === undefined)
            return fail('dataset', `bar ${sessionIndex}:${symbolIndex} missing`)
          if (bar.sessionDate !== date || bar.symbol !== symbol) {
            return fail(
              'dataset',
              `expected ${date}:${symbol}, observed ${bar.sessionDate}:${bar.symbol} at ${sessionIndex}:${symbolIndex}`,
            )
          }
          if (!validDatasetBar(bar)) return fail('dataset', `invalid OHLCV on ${date}:${symbol}`)
          bars[symbol] = {
            symbol,
            sessionDate: date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            source: DataSource.Alpaca,
            sourceFeed: DataFeed.Sip,
            adjustment: PriceAdjustment.All,
            publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
          }
        }
        sessions.push({ date, bars: bars as AlignedSession['bars'] })
      }
      return Result.succeed({ dataset, sessions })
    }),
  )
}

const spyBenchmarkProtocol: SimulationProtocol = {
  ...candidate16SimulationProtocol,
  universe: ['SPY'],
}

const benchmarkTargets = (
  sessions: readonly AlignedSession[],
  strategyTargets: readonly SimulationTarget[],
  startIndex: number,
): Result.Result<
  {
    readonly buyAndHold: readonly SimulationTarget[]
    readonly directVolatility: readonly SimulationTarget[]
    readonly terminalCashProof: boolean
  },
  Candidate16Failure
> => {
  const terminal = strategyTargets.at(-1)
  if (terminal === undefined) return fail('benchmarks', 'terminal target is missing')
  const terminalSignalDate = sessions.at(terminal.signalIndex)?.date
  const terminalExecutionDate = sessions.at(terminal.executionIndex)?.date
  if (terminalSignalDate === undefined || terminalExecutionDate === undefined) {
    return fail('benchmarks', 'terminal session boundary is missing')
  }
  const terminalSell = makeOrderOutcome({
    identity: {
      schemaVersion: ContractVersion.PartialFillSeed,
      signalDate: terminalSignalDate,
      executionDate: terminalExecutionDate,
      symbol: 'SPY',
      side: 'sell',
    },
    side: 'sell',
    requestedQuantityMicros: 1_000_000n,
    referencePriceMicros: 100_000_000n,
    model: spyBenchmarkProtocol.executionModel,
  })
  if (Result.isFailure(terminalSell)) {
    return Result.fail({
      _tag: 'Candidate16SimulationFailure',
      simulation: 'benchmark-terminal-fill',
      cause: terminalSell.failure,
    })
  }
  const terminalCashProof =
    terminalSell.success.status === 'filled' &&
    terminalSell.success.filledQuantityMicros === terminalSell.success.requestedQuantityMicros &&
    terminalSell.success.unfilledRemainder === 'none'
  const benchmarkTerminal: SimulationTarget = {
    signalIndex: terminal.signalIndex,
    executionIndex: terminal.executionIndex,
    weights: { SPY: 0 },
  }
  return pipe(
    Result.all(
      strategyTargets.slice(0, -1).map((target) =>
        pipe(
          directVolatilityWeights(sessions, target.signalIndex, spyBenchmarkProtocol),
          Result.mapError(
            (cause): Candidate16Failure => ({
              _tag: 'Candidate16SimulationFailure',
              simulation: 'direct-volatility-target',
              cause,
            }),
          ),
          Result.map(
            (weights): SimulationTarget => ({
              signalIndex: target.signalIndex,
              executionIndex: target.executionIndex,
              weights,
            }),
          ),
        ),
      ),
    ),
    Result.map((directVolatility) => ({
      buyAndHold: [
        {
          signalIndex: startIndex - 1,
          executionIndex: startIndex,
          weights: { SPY: 1 },
        },
        benchmarkTerminal,
      ],
      directVolatility: [...directVolatility, benchmarkTerminal],
      terminalCashProof,
    })),
  )
}

const selectEvaluationWindow = (
  simulation: string,
  raw: SimulationResult,
  sessions: readonly AlignedSession[],
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
): Result.Result<SimulationResult, Candidate16Failure> => {
  const evaluationStartDate = sessions.at(evaluationStartIndex)?.date
  if (evaluationStartDate === undefined) return fail(simulation, `evaluation index ${evaluationStartIndex} is missing`)
  const selectedOffset = raw.dailyPerformance.findIndex((point) => point.sessionDate === evaluationStartDate)
  if (selectedOffset < 0) return fail(simulation, `evaluation date ${evaluationStartDate} is missing`)
  const selected = raw.dailyPerformance.slice(selectedOffset)
  const expectedObservations = sessions.length - evaluationStartIndex
  const first = selected.at(0)
  const last = selected.at(-1)
  if (selected.length !== expectedObservations || first === undefined || last === undefined) {
    return fail(simulation, `expected ${expectedObservations} selected observations, observed ${selected.length}`)
  }
  const initialCapitalMicros = BigInt(protocol.initialCapitalMicros)
  const firstEquityMicros = BigInt(first.equityMicros)
  const firstNetReturn = Number(firstEquityMicros) / Number(initialCapitalMicros) - 1
  if (!Number.isFinite(firstNetReturn)) return fail(simulation, 'first selected return is not finite')
  const normalizedDailyPerformance = [{ ...first, netReturn: firstNetReturn }, ...selected.slice(1)]
  const metrics = calculateExactPerformanceMetrics(
    normalizedDailyPerformance.map((point) => BigInt(point.equityMicros)),
    BigInt(last.cumulativeTurnoverMicros),
    BigInt(last.cumulativeFeesMicros),
    BigInt(last.cumulativeSpreadCostMicros),
    BigInt(last.cumulativeSlippageCostMicros),
    BigInt(last.cumulativeCashYieldMicros),
    initialCapitalMicros,
  )
  if (Result.isFailure(metrics)) {
    return Result.fail({ _tag: 'Candidate16SimulationFailure', simulation, cause: metrics.failure })
  }
  return Result.succeed({ ...raw, metrics: metrics.success, dailyPerformance: normalizedDailyPerformance })
}

const runSimulation = (
  simulation: string,
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  simulationStartIndex: number,
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  recordEvents: boolean,
): Result.Result<SimulationResult, Candidate16Failure> => {
  const raw = simulate(sessions, targets, simulationStartIndex, protocol, costMultiplierMicros, runId, recordEvents)
  if (Result.isFailure(raw)) {
    return Result.fail({ _tag: 'Candidate16SimulationFailure', simulation, cause: raw.failure })
  }
  return selectEvaluationWindow(simulation, raw.success, sessions, evaluationStartIndex, protocol)
}

interface ReplayPosition {
  readonly quantityMicros: bigint
  readonly costBasisMicros: bigint
}

interface ReplayState {
  readonly cashMicros: bigint
  readonly positions: Readonly<Record<Candidate16Symbol, ReplayPosition>>
  readonly previousSessionDate: IsoDate | null
  readonly previousEquityMicros: bigint
  readonly peakEquityMicros: bigint
  readonly turnoverMicros: bigint
  readonly totalFeesMicros: bigint
  readonly totalSpreadCostMicros: bigint
  readonly totalSlippageCostMicros: bigint
  readonly totalCashYieldMicros: bigint
  readonly equityMicros: readonly bigint[]
  readonly events: readonly EvaluationEvent[]
  readonly cashChanges: readonly CashChange[]
  readonly dailyMarks: readonly DailyPositionMark[]
  readonly dailyPerformance: readonly DailyPerformancePoint[]
}

const initialReplayPositions = (): Readonly<Record<Candidate16Symbol, ReplayPosition>> =>
  Object.fromEntries(
    candidate16Universe.map((symbol) => [symbol, { quantityMicros: 0n, costBasisMicros: 0n }]),
  ) as Readonly<Record<Candidate16Symbol, ReplayPosition>>

const indexedBySession = <A extends { readonly sessionDate: IsoDate }>(
  values: readonly A[],
): ReadonlyMap<IsoDate, readonly A[]> => {
  const grouped = new Map<IsoDate, readonly A[]>()
  for (const value of values) grouped.set(value.sessionDate, [...(grouped.get(value.sessionDate) ?? []), value])
  return grouped
}

const decisionEvents = (decisions: readonly SignalDecision[]): readonly DecisionEvent[] =>
  decisions.map((decision) => ({
    kind: 'decision',
    id: decision.decisionId,
    signalDate: decision.signalDate,
    executionDate: decision.executionDate,
    targetWeights: decision.targetWeights,
  }))

const position = (
  positions: Readonly<Record<Candidate16Symbol, ReplayPosition>>,
  symbol: string,
): Result.Result<{ readonly symbol: Candidate16Symbol; readonly value: ReplayPosition }, Candidate16Failure> => {
  if (!candidate16Universe.includes(symbol as Candidate16Symbol)) {
    return fail('double-cost-replay', `order symbol ${symbol} is outside the frozen universe`)
  }
  const candidateSymbol = symbol as Candidate16Symbol
  return Result.succeed({ symbol: candidateSymbol, value: positions[candidateSymbol] })
}

const updatePosition = (
  positions: Readonly<Record<Candidate16Symbol, ReplayPosition>>,
  symbol: Candidate16Symbol,
  value: ReplayPosition,
): Readonly<Record<Candidate16Symbol, ReplayPosition>> => ({ ...positions, [symbol]: value })

const orderQuantity = (order: SimulatedOrder): Result.Result<bigint, Candidate16Failure> =>
  /^\d+$/.test(order.filledQuantityMicros)
    ? Result.succeed(BigInt(order.filledQuantityMicros))
    : fail('double-cost-replay', `order ${order.id} has invalid filled quantity ${order.filledQuantityMicros}`)

const applyReplayOrders = (
  state: ReplayState,
  session: AlignedSession,
  orders: readonly SimulatedOrder[],
  decisionsById: ReadonlyMap<string, DecisionEvent>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<ReplayState, Candidate16Failure> => {
  let next = state
  const feeInputs: FeeInput[] = []
  let encounteredBuy = false
  for (const order of orders) {
    if (order.side === 'buy') encounteredBuy = true
    if (order.side === 'sell' && encounteredBuy) {
      return fail('double-cost-replay', `sell order ${order.id} follows a buy on ${session.date}`)
    }
    const quantity = orderQuantity(order)
    if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
    if (quantity.success === 0n) continue
    const decision = decisionsById.get(order.decisionId)
    if (decision === undefined) return fail('double-cost-replay', `decision ${order.decisionId} is missing`)
    const located = position(next.positions, order.symbol)
    if (Result.isFailure(located)) return Result.fail(located.failure)
    const bar = session.bars[located.success.symbol]
    if (bar === undefined)
      return fail('double-cost-replay', `${located.success.symbol} bar is missing on ${session.date}`)
    const referencePrice = referencePriceMicros(bar.open, protocol.executionModel)
    if (Result.isFailure(referencePrice)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: referencePrice.failure,
      })
    }
    const terms = makeFillTerms(
      order.side,
      quantity.success,
      referencePrice.success,
      protocol.executionModel,
      costMultiplierMicros,
    )
    if (Result.isFailure(terms)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: terms.failure,
      })
    }
    let updatedPosition: ReplayPosition
    let cashChangeMicros: bigint
    let costBasisMicros: bigint
    if (order.side === 'sell') {
      if (quantity.success > located.success.value.quantityMicros) {
        return fail('double-cost-replay', `sell ${order.id} exceeds the open ${order.symbol} position`)
      }
      const soldCostBasis = saleCostBasisMicros(
        located.success.value.costBasisMicros,
        quantity.success,
        located.success.value.quantityMicros,
      )
      if (Result.isFailure(soldCostBasis)) {
        return Result.fail({
          _tag: 'Candidate16SimulationFailure',
          simulation: 'double-cost-replay',
          cause: soldCostBasis.failure,
        })
      }
      updatedPosition = {
        quantityMicros: located.success.value.quantityMicros - quantity.success,
        costBasisMicros: located.success.value.costBasisMicros - soldCostBasis.success,
      }
      costBasisMicros = soldCostBasis.success
      cashChangeMicros = terms.success.notionalMicros
    } else {
      updatedPosition = {
        quantityMicros: located.success.value.quantityMicros + quantity.success,
        costBasisMicros: located.success.value.costBasisMicros + terms.success.notionalMicros,
      }
      costBasisMicros = terms.success.notionalMicros
      cashChangeMicros = -terms.success.notionalMicros
    }
    const preparedOrder = { event: order, filledQuantityMicros: quantity.success }
    const fill = makeFill(runId, decision, preparedOrder, terms.success, costBasisMicros)
    if (Result.isFailure(fill)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: fill.failure,
      })
    }
    const cashMicros = next.cashMicros + cashChangeMicros
    const cashChange = makeCashChange(runId, fill.success.event, cashChangeMicros, cashMicros)
    if (Result.isFailure(cashChange)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: cashChange.failure,
      })
    }
    next = {
      ...next,
      cashMicros,
      positions: updatePosition(next.positions, located.success.symbol, updatedPosition),
      turnoverMicros: next.turnoverMicros + terms.success.notionalMicros,
      totalSpreadCostMicros: next.totalSpreadCostMicros + terms.success.spreadCostMicros,
      totalSlippageCostMicros: next.totalSlippageCostMicros + terms.success.slippageCostMicros,
      events: [...next.events, fill.success.event],
      cashChanges: [...next.cashChanges, cashChange.success],
    }
    feeInputs.push({ side: order.side, quantityMicros: quantity.success, notionalMicros: terms.success.notionalMicros })
  }
  const fees = calculateSessionFees(feeInputs, protocol.executionModel, costMultiplierMicros)
  if (Result.isFailure(fees)) {
    return Result.fail({ _tag: 'Candidate16SimulationFailure', simulation: 'double-cost-replay', cause: fees.failure })
  }
  if (fees.success.totalMicros > 0n) {
    const fee = makeFeeEvent(runId, session.date, fees.success)
    if (Result.isFailure(fee)) {
      return Result.fail({ _tag: 'Candidate16SimulationFailure', simulation: 'double-cost-replay', cause: fee.failure })
    }
    const cashMicros = next.cashMicros - fees.success.totalMicros
    const cashChange = makeCashChange(runId, fee.success, -fees.success.totalMicros, cashMicros)
    if (Result.isFailure(cashChange)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: cashChange.failure,
      })
    }
    next = {
      ...next,
      cashMicros,
      totalFeesMicros: next.totalFeesMicros + fees.success.totalMicros,
      events: [...next.events, fee.success],
      cashChanges: [...next.cashChanges, cashChange.success],
    }
  }
  return next.cashMicros < 0n
    ? Result.fail({
        _tag: 'Candidate16DoubledCostReplayInvalid',
        disposition: 'INVALID_PROTOCOL_DEVIATION',
        reason: `fixed baseline quantities require borrowed cash on ${session.date}: ${next.cashMicros}`,
      })
    : Result.succeed(next)
}

const closeReplaySession = (
  state: ReplayState,
  session: AlignedSession,
  opening: Pick<
    ReplayState,
    'turnoverMicros' | 'totalFeesMicros' | 'totalSpreadCostMicros' | 'totalSlippageCostMicros' | 'totalCashYieldMicros'
  >,
  protocol: SimulationProtocol,
): Result.Result<ReplayState, Candidate16Failure> => {
  const closingPrices = referencePricesFor(session.bars, protocol, (bar) => bar.close)
  if (Result.isFailure(closingPrices)) {
    return Result.fail({
      _tag: 'Candidate16SimulationFailure',
      simulation: 'double-cost-replay',
      cause: closingPrices.failure,
    })
  }
  let positionValueMicros = 0n
  const markedPositions: DailyPositionMark['positions'][number][] = []
  for (const symbol of candidate16Universe) {
    const priceMicros = closingPrices.success[symbol]
    if (priceMicros === undefined)
      return fail('double-cost-replay', `${symbol} closing price is missing on ${session.date}`)
    const current = state.positions[symbol]
    const marketValue = notionalMicros(current.quantityMicros, priceMicros)
    if (Result.isFailure(marketValue)) {
      return Result.fail({
        _tag: 'Candidate16SimulationFailure',
        simulation: 'double-cost-replay',
        cause: marketValue.failure,
      })
    }
    positionValueMicros += marketValue.success
    markedPositions.push({
      symbol,
      quantityMicros: current.quantityMicros.toString(),
      costBasisMicros: current.costBasisMicros.toString(),
      priceMicros: priceMicros.toString(),
      marketValueMicros: marketValue.success.toString(),
    })
  }
  const closingEquityMicros = state.cashMicros + positionValueMicros
  const peakEquityMicros = state.peakEquityMicros > closingEquityMicros ? state.peakEquityMicros : closingEquityMicros
  const netReturn = Number(closingEquityMicros) / Number(state.previousEquityMicros) - 1
  const drawdown = 1 - Number(closingEquityMicros) / Number(peakEquityMicros)
  if (!Number.isFinite(netReturn) || !Number.isFinite(drawdown) || closingEquityMicros <= 0n) {
    return fail('double-cost-replay', `invalid marked equity on ${session.date}`)
  }
  const performance: DailyPerformancePoint = {
    sessionDate: session.date,
    equityMicros: closingEquityMicros.toString(),
    netReturn,
    turnoverMicros: (state.turnoverMicros - opening.turnoverMicros).toString(),
    cumulativeTurnoverMicros: state.turnoverMicros.toString(),
    feeMicros: (state.totalFeesMicros - opening.totalFeesMicros).toString(),
    cumulativeFeesMicros: state.totalFeesMicros.toString(),
    spreadCostMicros: (state.totalSpreadCostMicros - opening.totalSpreadCostMicros).toString(),
    cumulativeSpreadCostMicros: state.totalSpreadCostMicros.toString(),
    slippageCostMicros: (state.totalSlippageCostMicros - opening.totalSlippageCostMicros).toString(),
    cumulativeSlippageCostMicros: state.totalSlippageCostMicros.toString(),
    cashYieldMicros: (state.totalCashYieldMicros - opening.totalCashYieldMicros).toString(),
    cumulativeCashYieldMicros: state.totalCashYieldMicros.toString(),
    peakEquityMicros: peakEquityMicros.toString(),
    drawdown,
  }
  return Result.succeed({
    ...state,
    previousEquityMicros: closingEquityMicros,
    peakEquityMicros,
    equityMicros: [...state.equityMicros, closingEquityMicros],
    dailyPerformance: [...state.dailyPerformance, performance],
    dailyMarks: [
      ...state.dailyMarks,
      { ...performance, cashMicros: state.cashMicros.toString(), positions: markedPositions },
    ],
  })
}

export const replayCandidate16FixedOrderCosts = (
  sessions: readonly AlignedSession[],
  baseline: SimulationResult,
  simulationStartIndex: number,
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<Candidate16CostReplay, Candidate16Failure> => {
  const trace = baseline.simulation
  if (trace === null) {
    return Result.fail({
      _tag: 'Candidate16DoubledCostReplayInvalid',
      disposition: 'INVALID_PROTOCOL_DEVIATION',
      reason: 'baseline simulation trace is absent',
    })
  }
  if (protocol.executionModel.cash.annualYieldBps !== 0) {
    return Result.fail({
      _tag: 'Candidate16DoubledCostReplayInvalid',
      disposition: 'INVALID_PROTOCOL_DEVIATION',
      reason: `unsupported nonzero cash yield ${protocol.executionModel.cash.annualYieldBps}`,
    })
  }
  const decisions = decisionEvents(baseline.signalDecisions)
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision] as const))
  const decisionsByExecution = new Map<IsoDate, readonly DecisionEvent[]>()
  for (const decision of decisions) {
    decisionsByExecution.set(decision.executionDate, [
      ...(decisionsByExecution.get(decision.executionDate) ?? []),
      decision,
    ])
  }
  const ordersBySession = indexedBySession(trace.orders)
  let state: ReplayState = {
    cashMicros: BigInt(protocol.initialCapitalMicros),
    positions: initialReplayPositions(),
    previousSessionDate: null,
    previousEquityMicros: BigInt(protocol.initialCapitalMicros),
    peakEquityMicros: BigInt(protocol.initialCapitalMicros),
    turnoverMicros: 0n,
    totalFeesMicros: 0n,
    totalSpreadCostMicros: 0n,
    totalSlippageCostMicros: 0n,
    totalCashYieldMicros: 0n,
    equityMicros: [],
    events: [],
    cashChanges: [],
    dailyMarks: [],
    dailyPerformance: [],
  }
  for (let index = simulationStartIndex; index < sessions.length; index += 1) {
    const session = sessions.at(index)
    if (session === undefined) return fail('double-cost-replay', `session ${index} is missing`)
    const opening = {
      turnoverMicros: state.turnoverMicros,
      totalFeesMicros: state.totalFeesMicros,
      totalSpreadCostMicros: state.totalSpreadCostMicros,
      totalSlippageCostMicros: state.totalSlippageCostMicros,
      totalCashYieldMicros: state.totalCashYieldMicros,
    }
    if (state.previousSessionDate !== null) {
      const elapsed = elapsedCalendarDays(state.previousSessionDate, session.date)
      if (Result.isFailure(elapsed)) {
        return Result.fail({
          _tag: 'Candidate16SimulationFailure',
          simulation: 'double-cost-replay',
          cause: elapsed.failure,
        })
      }
      const cashYield = accrueCashYield(state.cashMicros, elapsed.success, protocol.executionModel)
      if (Result.isFailure(cashYield)) {
        return Result.fail({
          _tag: 'Candidate16SimulationFailure',
          simulation: 'double-cost-replay',
          cause: cashYield.failure,
        })
      }
      if (cashYield.success !== 0n) {
        return Result.fail({
          _tag: 'Candidate16DoubledCostReplayInvalid',
          disposition: 'INVALID_PROTOCOL_DEVIATION',
          reason: `unexpected nonzero cash yield ${cashYield.success}`,
        })
      }
    }
    state = {
      ...state,
      previousSessionDate: session.date,
      events: [...state.events, ...(decisionsByExecution.get(session.date) ?? [])],
    }
    const afterOrders = applyReplayOrders(
      state,
      session,
      ordersBySession.get(session.date) ?? [],
      decisionsById,
      protocol,
      costMultiplierMicros,
      runId,
    )
    if (Result.isFailure(afterOrders)) return Result.fail(afterOrders.failure)
    const closed = closeReplaySession(afterOrders.success, session, opening, protocol)
    if (Result.isFailure(closed)) return Result.fail(closed.failure)
    state = closed.success
  }
  const rawMetrics = calculateExactPerformanceMetrics(
    state.equityMicros,
    state.turnoverMicros,
    state.totalFeesMicros,
    state.totalSpreadCostMicros,
    state.totalSlippageCostMicros,
    state.totalCashYieldMicros,
    BigInt(protocol.initialCapitalMicros),
  )
  if (Result.isFailure(rawMetrics)) {
    return Result.fail({
      _tag: 'Candidate16SimulationFailure',
      simulation: 'double-cost-replay',
      cause: rawMetrics.failure,
    })
  }
  const stressedTrace: SimulationTrace = {
    schemaVersion: trace.schemaVersion,
    executionModel: protocol.executionModel,
    costMultiplierMicros: costMultiplierMicros.toString(),
    orders: trace.orders,
    cashChanges: state.cashChanges,
    dailyMarks: state.dailyMarks,
  }
  const selected = selectEvaluationWindow(
    'double-cost-replay',
    {
      metrics: rawMetrics.success,
      events: state.events,
      signalDecisions: baseline.signalDecisions,
      dailyPerformance: state.dailyPerformance,
      simulation: stressedTrace,
    },
    sessions,
    evaluationStartIndex,
    protocol,
  )
  if (Result.isFailure(selected)) return Result.fail(selected.failure)
  const terminalCash = candidate16Universe.every((symbol) => state.positions[symbol].quantityMicros === 0n)
  return Result.succeed({
    result: { ...selected.success, simulation: stressedTrace },
    terminalCash,
  })
}

const traceTerminalCash = (simulation: SimulationResult): boolean => {
  const lastMark = simulation.simulation?.dailyMarks.at(-1)
  return lastMark !== undefined && lastMark.positions.every((position) => position.quantityMicros === '0')
}

const terminalExposure = (simulation: SimulationResult): string =>
  simulation.simulation?.dailyMarks
    .at(-1)
    ?.positions.filter((position) => position.quantityMicros !== '0')
    .map((position) => `${position.symbol}=${position.quantityMicros}`)
    .join(',') ?? 'missing-terminal-mark'

const makeInputManifest = (
  dataset: Candidate16Dataset,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<InputManifest, Candidate16Failure> => {
  const material = {
    schemaVersion: 'bayn.input-manifest.v3' as const,
    database: 'signal' as const,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1' as const,
      dataStart: CANDIDATE_16_DEVELOPMENT_START,
      dataEnd: CANDIDATE_16_DEVELOPMENT_END,
      lookbackStart: CANDIDATE_16_DEVELOPMENT_START,
      evaluationStart: preflight.selectedObservationStart,
      evaluationEnd: preflight.selectedObservationEnd,
    },
    rowCount: dataset.bars.length,
    sessionCount: dataset.sessions.length,
    firstSession: CANDIDATE_16_DEVELOPMENT_START,
    lastSession: CANDIDATE_16_DEVELOPMENT_END,
    symbols: candidate16Universe.map((symbol) => ({
      symbol,
      rows: dataset.sessions.length,
      firstSession: CANDIDATE_16_DEVELOPMENT_START,
      lastSession: CANDIDATE_16_DEVELOPMENT_END,
    })),
    tables: {
      bars: 'adjusted_daily_bars_v2' as const,
      sessions: 'exchange_sessions_v1' as const,
      manifests: 'snapshot_manifests_v2' as const,
    },
    finalizedSnapshot: dataset.finalizedSnapshot,
  }
  return pipe(
    canonicalHash('input-manifest', material),
    Result.map((hash) => ({ ...material, hash }) as InputManifest),
  )
}

const selectedSignalDecisions = (
  decisions: readonly SignalDecision[],
  preflight: CandidateDevelopmentPreflightPass,
): readonly SignalDecision[] =>
  decisions.filter(
    (decision) =>
      decision.executionDate >= preflight.selectedObservationStart &&
      decision.executionDate <= preflight.selectedObservationEnd,
  )

const selectedTrace = (trace: SimulationTrace, preflight: CandidateDevelopmentPreflightPass): SimulationTrace => ({
  ...trace,
  dailyMarks: trace.dailyMarks.filter(
    (mark) =>
      mark.sessionDate >= preflight.selectedObservationStart && mark.sessionDate <= preflight.selectedObservationEnd,
  ),
})

export const evaluateCandidate16Development = (
  registration: Candidate16Registration,
  dataset: Candidate16Dataset,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate16DevelopmentEvaluation, Candidate16Failure> => {
  if (preflight.protocolIdentity.candidateOrdinal !== 16 || preflight.protocolIdentity.priorTrialCount !== 15) {
    return fail('preflight', 'candidate ordinal or prior-trial lineage differs from Candidate 16')
  }
  if (preflight.expectedStrategyProtocolHash !== CANDIDATE_16_STRATEGY_PROTOCOL_HASH) {
    return fail(
      'preflight',
      `strategy protocol hash ${preflight.expectedStrategyProtocolHash} differs from Candidate 16`,
    )
  }
  if (
    registration.preregistrationHash !== CANDIDATE_16_PREREGISTRATION_SHA256 ||
    registration.preregistrationCommit !== CANDIDATE_16_PREREGISTRATION_COMMIT
  ) {
    return fail('registration', 'preregistration identity differs from the authoritative frozen commit')
  }
  if (!/^[0-9a-f]{40}$/.test(registration.evaluatedCommit)) {
    return fail('registration', `evaluated commit ${registration.evaluatedCommit} is not a full source revision`)
  }
  const prepared = prepareCandidate16DevelopmentData(dataset)
  if (Result.isFailure(prepared)) return Result.fail(prepared.failure)
  const strategyProtocolHash = canonicalHash('strategy-protocol', candidate16StrategyProtocolMaterial)
  if (Result.isFailure(strategyProtocolHash)) return Result.fail(strategyProtocolHash.failure)
  if (strategyProtocolHash.success !== CANDIDATE_16_STRATEGY_PROTOCOL_HASH) {
    return fail('strategy-protocol', 'source-controlled strategy protocol hash differs from the bound hash')
  }
  const runId = canonicalHash('development-run', {
    schemaVersion: 'bayn.candidate-16-development-run.v1',
    preregistrationHash: registration.preregistrationHash,
    preregistrationCommit: registration.preregistrationCommit,
    evaluatedCommit: registration.evaluatedCommit,
    strategyProtocolHash: CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
    candidateDevelopmentProtocolHash: preflight.protocolIdentity.candidateDevelopmentProtocolHash,
    snapshotId: dataset.snapshotId,
    sessionsContentHash: dataset.sessionsContentHash,
    barsContentHash: dataset.barsContentHash,
    priorAttemptIds: candidate16PriorAttemptIds,
    behavior: candidate16BehaviorMaterial,
  })
  if (Result.isFailure(runId)) return Result.fail(runId.failure)
  const plan = buildCandidate16Plan(prepared.success.sessions, preflight)
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  const targets = benchmarkTargets(prepared.success.sessions, plan.success.targets, plan.success.simulationStartIndex)
  if (Result.isFailure(targets)) return Result.fail(targets.failure)
  const benchmarkRunId = canonicalHash('benchmark-run', {
    schemaVersion: 'bayn.candidate-16-benchmark-run.v1',
    candidateRunId: runId.success,
    benchmark: 'SPY-buy-and-hold-and-direct-ten-percent-volatility',
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const baseline = runSimulation(
    'strategy',
    prepared.success.sessions,
    plan.success.targets,
    plan.success.simulationStartIndex,
    plan.success.evaluationStartIndex,
    candidate16SimulationProtocol,
    MICROS,
    runId.success,
    true,
  )
  if (Result.isFailure(baseline)) return Result.fail(baseline.failure)
  if (baseline.success.simulation === null) return fail('evaluation', 'baseline trace is missing')
  const baselineWithTrace = { ...baseline.success, simulation: baseline.success.simulation }
  const stressed = replayCandidate16FixedOrderCosts(
    prepared.success.sessions,
    baselineWithTrace,
    plan.success.simulationStartIndex,
    plan.success.evaluationStartIndex,
    candidate16SimulationProtocol,
    BigInt(candidate16SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
    runId.success,
  )
  if (Result.isFailure(stressed)) return Result.fail(stressed.failure)
  const buyAndHold = runSimulation(
    'buy-and-hold',
    prepared.success.sessions,
    targets.success.buyAndHold,
    plan.success.simulationStartIndex,
    plan.success.evaluationStartIndex,
    spyBenchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(buyAndHold)) return Result.fail(buyAndHold.failure)
  const directVolatility = runSimulation(
    'direct-volatility',
    prepared.success.sessions,
    targets.success.directVolatility,
    plan.success.simulationStartIndex,
    plan.success.evaluationStartIndex,
    spyBenchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(directVolatility)) return Result.fail(directVolatility.failure)
  const terminalCashPaths = {
    baseline: traceTerminalCash(baselineWithTrace),
    stressed: stressed.success.terminalCash,
    buyAndHold: targets.success.terminalCashProof,
    directVolatility: targets.success.terminalCashProof,
  }
  const exposureByPath = {
    baseline: terminalExposure(baselineWithTrace),
    stressed: terminalExposure(stressed.success.result),
    buyAndHold: targets.success.terminalCashProof ? '' : 'terminal-sell-not-fully-filled',
    directVolatility: targets.success.terminalCashProof ? '' : 'terminal-sell-not-fully-filled',
  }
  const exposedPaths = Object.entries(terminalCashPaths)
    .filter(([, isCash]) => !isCash)
    .map(([path]) => `${path}:${exposureByPath[path as keyof typeof exposureByPath]}`)
  if (exposedPaths.length > 0) {
    return fail('terminal-cash', `terminal positions remain on ${exposedPaths.join(',')}`)
  }
  const causalPath = validateCandidateDevelopmentDoubledCostCausalPath(
    { signalDecisions: baselineWithTrace.signalDecisions, simulation: baselineWithTrace.simulation },
    {
      signalDecisions: stressed.success.result.signalDecisions,
      simulation: stressed.success.result.simulation,
    },
  )
  if (Result.isFailure(causalPath)) {
    return Result.fail({
      _tag: 'Candidate16DoubledCostReplayInvalid',
      disposition: 'INVALID_PROTOCOL_DEVIATION',
      reason:
        causalPath.failure._tag === 'CandidateDevelopmentDoubledCostProtocolDeviation'
          ? causalPath.failure.reason
          : causalPath.failure._tag,
    })
  }
  const manifest = makeInputManifest(dataset, preflight)
  if (Result.isFailure(manifest)) return Result.fail(manifest.failure)
  const reconciliation = reconcileMarkedEquity({
    runId: runId.success,
    initialCapitalMicros: candidate16SimulationProtocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: baselineWithTrace.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: baselineWithTrace.metrics.endingEquityMicros,
    events: baselineWithTrace.events,
    simulation: baselineWithTrace.simulation,
  })
  if (Result.isFailure(reconciliation)) {
    return Result.fail({ _tag: 'Candidate16QualificationFailure', cause: reconciliation.failure })
  }
  const baselineTrace = selectedTrace(baselineWithTrace.simulation, preflight)
  const baselineEvaluation: EvaluationResult = {
    schemaVersion: ContractVersion.Evaluation,
    runId: runId.success,
    codeRevision: registration.evaluatedCommit,
    protocolHash: CANDIDATE_16_STRATEGY_PROTOCOL_HASH,
    initialCapitalMicros: candidate16SimulationProtocol.initialCapitalMicros,
    inputManifest: manifest.success,
    strategy: baselineWithTrace.metrics,
    buyAndHold: buyAndHold.success.metrics,
    directVolTiming: directVolatility.success.metrics,
    doubleCostStrategy: stressed.success.result.metrics,
    verdict: buildVerdict(
      baselineWithTrace.metrics,
      buyAndHold.success.metrics,
      directVolatility.success.metrics,
      stressed.success.result.metrics,
      candidate16SimulationProtocol,
    ),
    events: baselineWithTrace.events,
    simulation: baselineTrace,
    benchmarkSeries: {
      buyAndHold: buyAndHold.success.dailyPerformance,
      directVolTiming: directVolatility.success.dailyPerformance,
      doubleCostStrategy: stressed.success.result.dailyPerformance,
    },
    equitySeries: reconciliation.success.equitySeries,
    markedEquityReconciliation: reconciliation.success.reconciliation,
    signalDecisions: selectedSignalDecisions(baselineWithTrace.signalDecisions, preflight),
  }
  const series = prepareQualificationSeries(baselineEvaluation)
  if (Result.isFailure(series)) {
    return Result.fail({ _tag: 'Candidate16QualificationFailure', cause: series.failure })
  }
  const comparisonSemantics = buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, series.success)
  if (Result.isFailure(comparisonSemantics)) {
    return Result.fail({ _tag: 'Candidate16QualificationFailure', cause: comparisonSemantics.failure })
  }
  return Result.succeed({
    baseline: baselineEvaluation,
    comparisonSemantics: comparisonSemantics.success,
    stressed: {
      signalDecisions: selectedSignalDecisions(stressed.success.result.signalDecisions, preflight),
      simulation: selectedTrace(stressed.success.result.simulation, preflight),
    },
  })
}
