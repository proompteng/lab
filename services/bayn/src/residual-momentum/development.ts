import { pipe, Result } from 'effect'

import {
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import {
  accrueCashYield,
  calculateSessionFees,
  elapsedCalendarDays,
  makeFillTerms,
  MICROS,
  notionalMicros,
  referencePriceMicros,
  saleCostBasisMicros,
  type FeeInput,
} from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import {
  analyzeQualification,
  type QualificationObservation,
  type QualificationSeries,
} from '../qualification-statistics'
import {
  buildVerdict,
  directVolatilityWeights,
  simulate,
  type AlignedSession,
  type SimulationResult,
  type SimulationTarget,
} from '../simulation'
import { makeCashChange, makeFeeEvent, makeFill } from '../simulation/evidence'
import { calculateExactPerformanceMetrics } from '../simulation/metrics'
import { referencePricesFor } from '../simulation/valuation'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type CashChange,
  type DailyPerformancePoint,
  type DailyPositionMark,
  type DecisionEvent,
  type EvaluationEvent,
  type IsoDate,
  type SignalDecision,
  type SimulatedOrder,
  type SimulationProtocol,
  type SimulationTrace,
} from '../types'
import {
  CANDIDATE_13_DEVELOPMENT_END,
  CANDIDATE_13_DEVELOPMENT_START,
  CANDIDATE_13_HOLDOUT_END,
  CANDIDATE_13_HOLDOUT_START,
  CANDIDATE_13_PROTOCOL_HASH,
  CANDIDATE_13_SNAPSHOT_ID,
  candidate13BehaviorMaterial,
  candidate13DevelopmentSessions,
  candidate13DevelopmentStatisticsPolicy,
  candidate13PriorAttemptIds,
  candidate13Protocol,
  candidate13SelectionMultiplicity,
  candidate13SimulationProtocol,
  candidate13Specifications,
  candidate13Universe,
  type Candidate13CostReplay,
  type Candidate13Dataset,
  type Candidate13DevelopmentEvaluation,
  type Candidate13DevelopmentReport,
  type Candidate13Failure,
  type Candidate13Plan,
  type Candidate13PreparedData,
  type Candidate13Registration,
  type Candidate13SpecificationReport,
  type Candidate13Symbol,
} from './model'
import { buildCandidate13Plan, candidate13TerminalLiquidationIsComplete } from './strategy'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate13Failure> =>
  Result.fail({ _tag: 'Candidate13InvalidInput', operation, reason })

const canonicalHash = (operation: string, material: unknown): Result.Result<string, Candidate13Failure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): Candidate13Failure => ({ _tag: 'Candidate13HashFailure', operation, cause })),
  )

const exactDates = (left: readonly IsoDate[], right: readonly IsoDate[]): boolean =>
  left.length === right.length && left.every((date, index) => date === right[index])

export const candidate13DatasetHashes = (
  sessions: readonly IsoDate[],
  bars: Candidate13Dataset['bars'],
): Result.Result<{ readonly sessionsContentHash: string; readonly barsContentHash: string }, Candidate13Failure> =>
  Result.all({
    sessionsContentHash: canonicalHash('development-sessions', {
      schemaVersion: 'bayn.candidate-13-development-sessions.v1',
      snapshotId: CANDIDATE_13_SNAPSHOT_ID,
      sessions,
    }),
    barsContentHash: canonicalHash('development-bars', {
      schemaVersion: 'bayn.candidate-13-development-bars.v1',
      snapshotId: CANDIDATE_13_SNAPSHOT_ID,
      universe: candidate13Universe,
      bars,
    }),
  })

const validDatasetBar = (bar: Candidate13Dataset['bars'][number]): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

export const prepareCandidate13DevelopmentData = (
  dataset: Candidate13Dataset,
): Result.Result<Candidate13PreparedData, Candidate13Failure> => {
  const expectedSessions = candidate13DevelopmentSessions()
  if (dataset.snapshotId !== CANDIDATE_13_SNAPSHOT_ID) {
    return fail('dataset', `snapshot ${dataset.snapshotId} differs from ${CANDIDATE_13_SNAPSHOT_ID}`)
  }
  if (!exactDates(dataset.sessions, expectedSessions)) return fail('dataset', 'official development sessions differ')
  const expectedBarCount = expectedSessions.length * candidate13Universe.length
  if (dataset.bars.length !== expectedBarCount) {
    return fail('dataset', `expected ${expectedBarCount} bars, observed ${dataset.bars.length}`)
  }
  return pipe(
    candidate13DatasetHashes(dataset.sessions, dataset.bars),
    Result.flatMap((hashes) => {
      if (hashes.sessionsContentHash !== dataset.sessionsContentHash) {
        return fail('dataset', 'sessions content hash differs')
      }
      if (hashes.barsContentHash !== dataset.barsContentHash) return fail('dataset', 'bars content hash differs')
      const sessions: AlignedSession[] = []
      for (let sessionIndex = 0; sessionIndex < expectedSessions.length; sessionIndex += 1) {
        const date = expectedSessions.at(sessionIndex)
        if (date === undefined) return fail('dataset', `session ${sessionIndex} is missing`)
        const bars: Partial<Record<Candidate13Symbol, AlignedSession['bars'][string]>> = {}
        for (let symbolIndex = 0; symbolIndex < candidate13Universe.length; symbolIndex += 1) {
          const symbol = candidate13Universe.at(symbolIndex)
          const bar = dataset.bars.at(sessionIndex * candidate13Universe.length + symbolIndex)
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
  ...candidate13SimulationProtocol,
  universe: ['SPY'],
}

const benchmarkTargets = (
  sessions: readonly AlignedSession[],
  strategyTargets: readonly SimulationTarget[],
  startIndex: number,
): Result.Result<
  { readonly buyAndHold: readonly SimulationTarget[]; readonly directVolatility: readonly SimulationTarget[] },
  Candidate13Failure
> => {
  const terminal = strategyTargets.at(-1)
  if (terminal === undefined || terminal.executionIndex !== sessions.length - 1) {
    return fail('benchmarks', 'terminal target is missing')
  }
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
            (cause): Candidate13Failure => ({
              _tag: 'Candidate13SimulationFailure',
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
    })),
  )
}

const selectEvaluationWindow = (
  simulation: string,
  raw: SimulationResult,
  sessions: readonly AlignedSession[],
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
): Result.Result<SimulationResult, Candidate13Failure> => {
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
    return Result.fail({ _tag: 'Candidate13SimulationFailure', simulation, cause: metrics.failure })
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
): Result.Result<SimulationResult, Candidate13Failure> => {
  const raw = simulate(sessions, targets, simulationStartIndex, protocol, costMultiplierMicros, runId, recordEvents)
  if (Result.isFailure(raw)) {
    return Result.fail({ _tag: 'Candidate13SimulationFailure', simulation, cause: raw.failure })
  }
  return selectEvaluationWindow(simulation, raw.success, sessions, evaluationStartIndex, protocol)
}

interface ReplayPosition {
  readonly quantityMicros: bigint
  readonly costBasisMicros: bigint
}

interface ReplayState {
  readonly cashMicros: bigint
  readonly positions: Readonly<Record<Candidate13Symbol, ReplayPosition>>
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

const initialReplayPositions = (): Readonly<Record<Candidate13Symbol, ReplayPosition>> =>
  Object.fromEntries(
    candidate13Universe.map((symbol) => [symbol, { quantityMicros: 0n, costBasisMicros: 0n }]),
  ) as Readonly<Record<Candidate13Symbol, ReplayPosition>>

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
  positions: Readonly<Record<Candidate13Symbol, ReplayPosition>>,
  symbol: string,
): Result.Result<{ readonly symbol: Candidate13Symbol; readonly value: ReplayPosition }, Candidate13Failure> => {
  if (!candidate13Universe.includes(symbol as Candidate13Symbol)) {
    return fail('double-cost-replay', `order symbol ${symbol} is outside the frozen universe`)
  }
  const candidateSymbol = symbol as Candidate13Symbol
  return Result.succeed({ symbol: candidateSymbol, value: positions[candidateSymbol] })
}

const updatePosition = (
  positions: Readonly<Record<Candidate13Symbol, ReplayPosition>>,
  symbol: Candidate13Symbol,
  value: ReplayPosition,
): Readonly<Record<Candidate13Symbol, ReplayPosition>> => ({ ...positions, [symbol]: value })

const orderQuantity = (order: SimulatedOrder): Result.Result<bigint, Candidate13Failure> =>
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
): Result.Result<ReplayState, Candidate13Failure> => {
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
        _tag: 'Candidate13SimulationFailure',
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
        _tag: 'Candidate13SimulationFailure',
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
          _tag: 'Candidate13SimulationFailure',
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
        _tag: 'Candidate13SimulationFailure',
        simulation: 'double-cost-replay',
        cause: fill.failure,
      })
    }
    const cashMicros = next.cashMicros + cashChangeMicros
    const cashChange = makeCashChange(runId, fill.success.event, cashChangeMicros, cashMicros)
    if (Result.isFailure(cashChange)) {
      return Result.fail({
        _tag: 'Candidate13SimulationFailure',
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
    return Result.fail({ _tag: 'Candidate13SimulationFailure', simulation: 'double-cost-replay', cause: fees.failure })
  }
  if (fees.success.totalMicros > 0n) {
    const fee = makeFeeEvent(runId, session.date, fees.success)
    if (Result.isFailure(fee)) {
      return Result.fail({ _tag: 'Candidate13SimulationFailure', simulation: 'double-cost-replay', cause: fee.failure })
    }
    const cashMicros = next.cashMicros - fees.success.totalMicros
    const cashChange = makeCashChange(runId, fee.success, -fees.success.totalMicros, cashMicros)
    if (Result.isFailure(cashChange)) {
      return Result.fail({
        _tag: 'Candidate13SimulationFailure',
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
        _tag: 'Candidate13DoubledCostReplayInvalid',
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
): Result.Result<ReplayState, Candidate13Failure> => {
  const closingPrices = referencePricesFor(session.bars, protocol, (bar) => bar.close)
  if (Result.isFailure(closingPrices)) {
    return Result.fail({
      _tag: 'Candidate13SimulationFailure',
      simulation: 'double-cost-replay',
      cause: closingPrices.failure,
    })
  }
  let positionValueMicros = 0n
  const markedPositions: DailyPositionMark['positions'][number][] = []
  for (const symbol of candidate13Universe) {
    const priceMicros = closingPrices.success[symbol]
    if (priceMicros === undefined)
      return fail('double-cost-replay', `${symbol} closing price is missing on ${session.date}`)
    const current = state.positions[symbol]
    const marketValue = notionalMicros(current.quantityMicros, priceMicros)
    if (Result.isFailure(marketValue)) {
      return Result.fail({
        _tag: 'Candidate13SimulationFailure',
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

export const replayCandidate13FixedOrderCosts = (
  sessions: readonly AlignedSession[],
  baseline: SimulationResult,
  simulationStartIndex: number,
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<Candidate13CostReplay, Candidate13Failure> => {
  const trace = baseline.simulation
  if (trace === null) {
    return Result.fail({
      _tag: 'Candidate13DoubledCostReplayInvalid',
      disposition: 'INVALID_PROTOCOL_DEVIATION',
      reason: 'baseline simulation trace is absent',
    })
  }
  if (protocol.executionModel.cash.annualYieldBps !== 0) {
    return Result.fail({
      _tag: 'Candidate13DoubledCostReplayInvalid',
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
          _tag: 'Candidate13SimulationFailure',
          simulation: 'double-cost-replay',
          cause: elapsed.failure,
        })
      }
      const cashYield = accrueCashYield(state.cashMicros, elapsed.success, protocol.executionModel)
      if (Result.isFailure(cashYield)) {
        return Result.fail({
          _tag: 'Candidate13SimulationFailure',
          simulation: 'double-cost-replay',
          cause: cashYield.failure,
        })
      }
      if (cashYield.success !== 0n) {
        return Result.fail({
          _tag: 'Candidate13DoubledCostReplayInvalid',
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
      _tag: 'Candidate13SimulationFailure',
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
  const terminalCash = candidate13Universe.every((symbol) => state.positions[symbol].quantityMicros === 0n)
  return Result.succeed({
    result: { ...selected.success, simulation: stressedTrace },
    terminalCash,
  })
}

const performanceByDate = (
  points: readonly DailyPerformancePoint[],
  name: string,
): Result.Result<ReadonlyMap<IsoDate, DailyPerformancePoint>, Candidate13Failure> => {
  const map = new Map<IsoDate, DailyPerformancePoint>()
  for (const point of points) {
    if (map.has(point.sessionDate)) return fail(name, `duplicate daily performance ${point.sessionDate}`)
    map.set(point.sessionDate, point)
  }
  return Result.succeed(map)
}

const qualificationSeries = (
  runId: string,
  strategy: SimulationResult,
  buyAndHold: SimulationResult,
  directVolatility: SimulationResult,
  rebalanceExecutionDates: readonly IsoDate[],
): Result.Result<QualificationSeries, Candidate13Failure> =>
  pipe(
    Result.all({
      buyAndHold: performanceByDate(buyAndHold.dailyPerformance, 'buy-and-hold-series'),
      directVolatility: performanceByDate(directVolatility.dailyPerformance, 'direct-volatility-series'),
    }),
    Result.flatMap((benchmarks) => {
      const observations: QualificationObservation[] = []
      for (const point of strategy.dailyPerformance) {
        const buyAndHoldPoint = benchmarks.buyAndHold.get(point.sessionDate)
        const directVolatilityPoint = benchmarks.directVolatility.get(point.sessionDate)
        if (buyAndHoldPoint === undefined || directVolatilityPoint === undefined) {
          return fail('qualification-series', `benchmark alignment missing ${point.sessionDate}`)
        }
        observations.push({
          sessionDate: point.sessionDate,
          strategyReturn: point.netReturn,
          cashReturn: 0,
          buyAndHoldReturn: buyAndHoldPoint.netReturn,
          directVolatilityReturn: directVolatilityPoint.netReturn,
        })
      }
      if (
        observations.length !== buyAndHold.dailyPerformance.length ||
        observations.length !== directVolatility.dailyPerformance.length
      ) {
        return fail('qualification-series', 'daily performance lengths differ')
      }
      return Result.succeed({
        schemaVersion: 'bayn.qualification-series.v1',
        runId,
        observations,
        rebalanceExecutionDates,
      })
    }),
  )

interface Candidate13BenchmarkResults {
  readonly buyAndHold: SimulationResult
  readonly directVolatility: SimulationResult
  readonly terminalCash: boolean
}

const traceTerminalCash = (simulation: SimulationResult): boolean => {
  const lastMark = simulation.simulation?.dailyMarks.at(-1)
  return lastMark !== undefined && lastMark.positions.every((position) => position.quantityMicros === '0')
}

interface EvaluatedCandidate13Specification {
  readonly report: Candidate13SpecificationReport
  readonly baseline: SimulationResult & { readonly simulation: SimulationTrace }
  readonly stressed: SimulationResult & { readonly simulation: SimulationTrace }
}

const evaluateSpecification = (
  prepared: Candidate13PreparedData,
  plan: Candidate13Plan,
  familyStrategyHash: string,
  familyRunId: string,
  benchmarks: Candidate13BenchmarkResults,
): Result.Result<EvaluatedCandidate13Specification, Candidate13Failure> => {
  const strategyHash = canonicalHash('specification-strategy', {
    schemaVersion: 'bayn.candidate-13-specification-strategy.v1',
    familyStrategyHash,
    specification: plan.specification,
  })
  if (Result.isFailure(strategyHash)) return Result.fail(strategyHash.failure)

  const runId = canonicalHash('specification-run', {
    schemaVersion: 'bayn.candidate-13-specification-run.v1',
    familyRunId,
    strategyHash: strategyHash.success,
  })
  if (Result.isFailure(runId)) return Result.fail(runId.failure)

  const baseline = runSimulation(
    `strategy:${plan.specification.id}`,
    prepared.sessions,
    plan.targets,
    plan.simulationStartIndex,
    plan.evaluationStartIndex,
    candidate13SimulationProtocol,
    MICROS,
    runId.success,
    true,
  )
  if (Result.isFailure(baseline)) return Result.fail(baseline.failure)
  if (baseline.success.simulation === null) return fail('evaluation', 'baseline event trace is missing')
  const baselineWithTrace: SimulationResult & { readonly simulation: SimulationTrace } = {
    ...baseline.success,
    simulation: baseline.success.simulation,
  }

  const stressed = replayCandidate13FixedOrderCosts(
    prepared.sessions,
    baselineWithTrace,
    plan.simulationStartIndex,
    plan.evaluationStartIndex,
    candidate13SimulationProtocol,
    BigInt(candidate13SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
    runId.success,
  )
  if (Result.isFailure(stressed)) return Result.fail(stressed.failure)

  const causalPath = validateCandidateDevelopmentDoubledCostCausalPath(
    { signalDecisions: baselineWithTrace.signalDecisions, simulation: baselineWithTrace.simulation },
    {
      signalDecisions: stressed.success.result.signalDecisions,
      simulation: stressed.success.result.simulation,
    },
  )
  if (Result.isFailure(causalPath)) {
    const detail =
      causalPath.failure._tag === 'CandidateDevelopmentDoubledCostProtocolDeviation'
        ? causalPath.failure.reason
        : causalPath.failure._tag
    return Result.fail({
      _tag: 'Candidate13DoubledCostReplayInvalid',
      disposition: 'INVALID_PROTOCOL_DEVIATION',
      reason: detail,
    } satisfies Candidate13Failure)
  }

  const economicVerdict = buildVerdict(
    baselineWithTrace.metrics,
    benchmarks.buyAndHold.metrics,
    benchmarks.directVolatility.metrics,
    stressed.success.result.metrics,
    candidate13SimulationProtocol,
  )
  const series = qualificationSeries(
    runId.success,
    baselineWithTrace,
    benchmarks.buyAndHold,
    benchmarks.directVolatility,
    plan.rebalanceExecutionDates,
  )
  if (Result.isFailure(series)) return Result.fail(series.failure)
  const analysisResult = analyzeQualification(
    series.success,
    candidate13DevelopmentStatisticsPolicy,
    candidate13PriorAttemptIds,
  )
  if (Result.isFailure(analysisResult)) {
    return Result.fail({ _tag: 'Candidate13QualificationFailure', cause: analysisResult.failure })
  }
  const analysis = analysisResult.success
  const directIsStronger = benchmarks.directVolatility.metrics.sharpe > benchmarks.buyAndHold.metrics.sharpe
  const selectedBenchmark = directIsStronger ? ('direct-volatility-timing' as const) : ('buy-and-hold' as const)
  const benchmarkMetrics = directIsStronger ? benchmarks.directVolatility.metrics : benchmarks.buyAndHold.metrics
  const terminalCash = {
    strategy: traceTerminalCash(baselineWithTrace),
    buyAndHold: benchmarks.terminalCash,
    directVolatility: benchmarks.terminalCash,
    doubleCostStrategy: stressed.success.terminalCash,
  }
  const developmentPass =
    economicVerdict.status === 'PASS' && analysis.status === 'PASS' && Object.values(terminalCash).every(Boolean)
  const report: Candidate13SpecificationReport = {
    specification: plan.specification,
    identity: { strategyHash: strategyHash.success, runId: runId.success },
    metrics: {
      strategy: baselineWithTrace.metrics,
      buyAndHold: benchmarks.buyAndHold.metrics,
      directVolatility: benchmarks.directVolatility.metrics,
      doubleCostStrategy: stressed.success.result.metrics,
      benchmarkRelativeAnnualizedReturn: baselineWithTrace.metrics.annualizedReturn - benchmarkMetrics.annualizedReturn,
      benchmarkSharpeDifference: baselineWithTrace.metrics.sharpe - benchmarkMetrics.sharpe,
    },
    selectedBenchmark,
    economicVerdict,
    terminalCash,
    doubledCostCausalPath: causalPath.success,
    uncertainty: {
      status: analysis.status,
      reasonCodes: analysis.reasonCodes,
      adjustedOneSidedAlpha: analysis.bootstrap.adjustedOneSidedAlpha,
      producedBootstrapSamples: analysis.bootstrap.producedSamples,
      bootstrapSamplesHash: analysis.bootstrap.samplesHash,
      annualizedExcessReturnLowerBound: analysis.bootstrap.annualizedExcessReturnLowerBound,
      sharpeDifferenceLowerBound: analysis.bootstrap.sharpeDifferenceLowerBound,
      completeRebalanceBlocks: analysis.completeBlocks.length,
      requiredCompleteRebalanceBlocks: analysis.power.requiredCompleteRebalanceBlocks,
      availableCompleteSessions: analysis.power.availableCompleteSessions,
      requiredCompleteSessions: analysis.power.requiredSessions,
      walkForwardFolds: analysis.walkForward.folds.map((fold) => ({
        ordinal: fold.ordinal,
        trainingStart: fold.trainingStart,
        trainingEnd: fold.trainingEnd,
        testStart: fold.testStart,
        testEnd: fold.testEnd,
        testObservationCount: fold.testObservationCount,
        excessReturn: fold.excessReturn,
        maximumDrawdown: fold.maximumDrawdown,
        positiveExcess: fold.positiveExcess,
      })),
      positiveWalkForwardFolds: analysis.walkForward.positiveFolds,
      analysisHash: analysis.analysisHash,
    },
    developmentPass,
  }
  return Result.succeed({ report, baseline: baselineWithTrace, stressed: stressed.success.result })
}

export const evaluateCandidate13Development = (
  registration: Candidate13Registration,
  dataset: Candidate13Dataset,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate13DevelopmentEvaluation, Candidate13Failure> => {
  if (preflight.protocolIdentity.protocolHash !== CANDIDATE_13_PROTOCOL_HASH) {
    return fail('preflight', `protocol hash ${preflight.protocolIdentity.protocolHash} differs from Candidate 13`)
  }
  const prepared = prepareCandidate13DevelopmentData(dataset)
  if (Result.isFailure(prepared)) return Result.fail(prepared.failure)
  const parameterHash = canonicalHash('parameters', {
    strategy: candidate13Protocol,
    simulation: candidate13SimulationProtocol,
    statistics: candidate13DevelopmentStatisticsPolicy,
    selectionMultiplicity: candidate13SelectionMultiplicity,
    priorAttemptIds: candidate13PriorAttemptIds,
    candidateDevelopmentProtocolHash: preflight.protocolIdentity.protocolHash,
  })
  if (Result.isFailure(parameterHash)) return Result.fail(parameterHash.failure)
  const behaviorHash = canonicalHash('behavior', candidate13BehaviorMaterial)
  if (Result.isFailure(behaviorHash)) return Result.fail(behaviorHash.failure)
  const terminalCash = candidate13TerminalLiquidationIsComplete()
  if (Result.isFailure(terminalCash)) return Result.fail(terminalCash.failure)
  const familyStrategyHash = canonicalHash('family-strategy', {
    schemaVersion: 'bayn.candidate-13-family-strategy.v1',
    parameterHash: parameterHash.success,
    behaviorHash: behaviorHash.success,
    preregistrationHash: registration.preregistrationHash,
    preregistrationCommit: registration.preregistrationCommit,
  })
  if (Result.isFailure(familyStrategyHash)) return Result.fail(familyStrategyHash.failure)
  const familyRunId = canonicalHash('development-run', {
    schemaVersion: 'bayn.candidate-13-development-run.v1',
    evaluatedCommit: registration.evaluatedCommit,
    familyStrategyHash: familyStrategyHash.success,
    snapshotId: dataset.snapshotId,
    barsContentHash: dataset.barsContentHash,
    sessionsContentHash: dataset.sessionsContentHash,
    developmentStart: CANDIDATE_13_DEVELOPMENT_START,
    developmentEnd: CANDIDATE_13_DEVELOPMENT_END,
    selectedObservationStart: preflight.selectedObservationStart,
    selectedObservationEnd: preflight.selectedObservationEnd,
  })
  if (Result.isFailure(familyRunId)) return Result.fail(familyRunId.failure)
  const plans = Result.all(
    candidate13Specifications.map((specification) =>
      buildCandidate13Plan(prepared.success.sessions, preflight, specification),
    ),
  )
  if (Result.isFailure(plans)) return Result.fail(plans.failure)
  const firstPlan = plans.success.at(0)
  if (firstPlan === undefined) return fail('evaluation', 'no frozen specification plan')
  const targets = benchmarkTargets(prepared.success.sessions, firstPlan.targets, firstPlan.simulationStartIndex)
  if (Result.isFailure(targets)) return Result.fail(targets.failure)
  const benchmarkRunId = canonicalHash('benchmark-run', {
    schemaVersion: 'bayn.candidate-13-benchmark-run.v1',
    familyRunId: familyRunId.success,
    benchmark: 'SPY-buy-and-hold-and-direct-ten-percent-volatility',
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const buyAndHold = runSimulation(
    'buy-and-hold',
    prepared.success.sessions,
    targets.success.buyAndHold,
    firstPlan.simulationStartIndex,
    firstPlan.evaluationStartIndex,
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
    firstPlan.simulationStartIndex,
    firstPlan.evaluationStartIndex,
    spyBenchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(directVolatility)) return Result.fail(directVolatility.failure)
  const benchmarks: Candidate13BenchmarkResults = {
    buyAndHold: buyAndHold.success,
    directVolatility: directVolatility.success,
    terminalCash: terminalCash.success,
  }
  const specificationReports = Result.all(
    plans.success.map((plan) =>
      evaluateSpecification(prepared.success, plan, familyStrategyHash.success, familyRunId.success, benchmarks),
    ),
  )
  if (Result.isFailure(specificationReports)) return Result.fail(specificationReports.failure)
  const selected = specificationReports.success.find((entry) => entry.report.developmentPass)
  const alpha = specificationReports.success.at(0)?.report.uncertainty.adjustedOneSidedAlpha
  if (alpha === undefined) return fail('evaluation', 'specification analysis missing')
  const reportMaterial = {
    schemaVersion: 'bayn.candidate-13-development-report.v1' as const,
    status: selected === undefined ? ('HOLD_REJECT' as const) : ('PASS' as const),
    evaluatedCommit: registration.evaluatedCommit,
    preregistrationHash: registration.preregistrationHash,
    preregistrationCommit: registration.preregistrationCommit,
    identity: {
      parameterHash: parameterHash.success,
      behaviorHash: behaviorHash.success,
      familyStrategyHash: familyStrategyHash.success,
      familyRunId: familyRunId.success,
    },
    dataset: {
      snapshotId: dataset.snapshotId,
      firstSession: prepared.success.sessions.at(0)?.date ?? CANDIDATE_13_DEVELOPMENT_START,
      lastSession: prepared.success.sessions.at(-1)?.date ?? CANDIDATE_13_DEVELOPMENT_END,
      sessionCount: prepared.success.sessions.length,
      barCount: dataset.bars.length,
      sessionsContentHash: dataset.sessionsContentHash,
      barsContentHash: dataset.barsContentHash,
    },
    geometry: preflight,
    selection: {
      specificationCount: candidate13Specifications.length,
      familyMultiplicityDivisor: candidate13SelectionMultiplicity,
      priorAttemptCount: candidate13PriorAttemptIds.length,
      adjustedOneSidedAlpha: alpha,
      selectedSpecificationId: selected?.report.specification.id ?? null,
    },
    specifications: specificationReports.success.map((entry) => entry.report),
    holdout: {
      start: CANDIDATE_13_HOLDOUT_START,
      end: CANDIDATE_13_HOLDOUT_END,
      inspected: false as const,
      accessCount: 0 as const,
    },
  }
  const reportHash = canonicalHash('development-report', reportMaterial)
  if (Result.isFailure(reportHash)) return Result.fail(reportHash.failure)
  const firstEvaluation = specificationReports.success.at(0)
  if (firstEvaluation === undefined) return fail('evaluation', 'evaluated specification is missing')
  const report: Candidate13DevelopmentReport = {
    ...reportMaterial,
    identity: { ...reportMaterial.identity, reportHash: reportHash.success },
  }
  return Result.succeed({
    report,
    doubledCost: {
      baseline: {
        signalDecisions: firstEvaluation.baseline.signalDecisions,
        simulation: firstEvaluation.baseline.simulation,
      },
      stressed: {
        signalDecisions: firstEvaluation.stressed.signalDecisions,
        simulation: firstEvaluation.stressed.simulation,
      },
    },
  })
}
