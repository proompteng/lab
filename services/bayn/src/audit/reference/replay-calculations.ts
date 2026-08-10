import { pipe, Result } from 'effect'

import {
  calculateSessionFees,
  desiredQuantityMicros,
  makeFillTerms,
  makeOrderOutcome,
  microsToNumber,
  notionalMicros,
  referencePriceMicros,
  scaleQuantityMicros,
  type FeeInput,
  type FillTerms,
} from '../../execution-model'
import type {
  CashChange,
  DailyBar,
  DecisionEvent,
  FeeEvent,
  FillEvent,
  IsoDate,
  PerformanceMetrics,
  SimulatedOrder,
  SimulationProtocol,
} from '../../types'
import { average, sampleDeviation, tradingDays } from './decisions'
import {
  makeReferenceCashChangeIdentity,
  makeReferenceFillIdentity,
  makeReferenceOrderIdentity,
} from './replay/identities'
import type { Position, ReferenceComputation, Session } from './model'

export const calculateReplayMetrics = (
  equityMicros: readonly bigint[],
  turnoverMicros: bigint,
  feeMicros: bigint,
  spreadMicros: bigint,
  slippageMicros: bigint,
  yieldMicros: bigint,
  initialMicros: bigint,
): ReferenceComputation<PerformanceMetrics> => {
  const firstNonPositiveIndex = equityMicros.findIndex((value) => value <= 0n)
  if (equityMicros.length < 2 || firstNonPositiveIndex !== -1) {
    return Result.fail({
      _tag: 'ReferenceInvalidEquityCurve',
      observationCount: equityMicros.length,
      firstNonPositiveIndex: firstNonPositiveIndex === -1 ? null : firstNonPositiveIndex,
      firstNonPositiveValueMicros:
        firstNonPositiveIndex === -1 ? null : (equityMicros[firstNonPositiveIndex]?.toString() ?? null),
    })
  }
  const endingEquityMicros = equityMicros.at(-1)
  if (endingEquityMicros === undefined) {
    return Result.fail({
      _tag: 'ReferenceInvalidEquityCurve',
      observationCount: equityMicros.length,
      firstNonPositiveIndex: null,
      firstNonPositiveValueMicros: null,
    })
  }
  const equity = equityMicros.map(microsToNumber)
  const initial = microsToNumber(initialMicros)
  const endingEquity = microsToNumber(endingEquityMicros)
  const returns: number[] = []
  let previousEquity = initial
  for (const value of equity) {
    returns.push(value / previousEquity - 1)
    previousEquity = value
  }
  const totalReturn = endingEquity / initial - 1
  const annualizedReturn = Math.pow(endingEquity / initial, tradingDays / equity.length) - 1
  const annualizedVolatility = sampleDeviation(returns) * Math.sqrt(tradingDays)
  const sharpe = annualizedVolatility === 0 ? 0 : (average(returns) * tradingDays) / annualizedVolatility
  let peak = initial
  let maximumDrawdown = 0
  for (const value of equity) {
    peak = Math.max(peak, value)
    maximumDrawdown = Math.max(maximumDrawdown, 1 - value / peak)
  }
  return Result.succeed({
    observations: equity.length,
    totalReturn,
    annualizedReturn,
    annualizedVolatility,
    sharpe,
    maximumDrawdown,
    annualTurnover: microsToNumber(turnoverMicros) / initial / (equity.length / tradingDays),
    totalFeesMicros: feeMicros.toString(),
    totalSpreadCostMicros: spreadMicros.toString(),
    totalSlippageCostMicros: slippageMicros.toString(),
    totalCashYieldMicros: yieldMicros.toString(),
    endingEquityMicros: endingEquityMicros.toString(),
  })
}

export const makeReferenceOrder = (
  runId: string,
  decision: DecisionEvent,
  sessionDate: IsoDate,
  symbol: string,
  side: 'buy' | 'sell',
  requestedQuantityMicros: bigint,
  referencePrice: bigint,
  protocol: SimulationProtocol,
  forceFullFill = false,
): ReferenceComputation<SimulatedOrder> =>
  pipe(
    makeOrderOutcome({
      identity: {
        schemaVersion: 'bayn.partial-fill-seed.v1',
        signalDate: decision.signalDate,
        executionDate: decision.executionDate,
        symbol,
        side,
        ...(forceFullFill ? { forceFullFill: true } : {}),
      },
      side,
      requestedQuantityMicros,
      referencePriceMicros: referencePrice,
      model: protocol.executionModel,
      forceFullFill,
    }),
    Result.flatMap((outcome) => {
      const material = {
        decisionId: decision.id,
        sessionDate,
        symbol,
        side,
        requestedQuantityMicros: outcome.requestedQuantityMicros.toString(),
        filledQuantityMicros: outcome.filledQuantityMicros.toString(),
        status: outcome.status,
        rejectionReason: outcome.rejectionReason,
        unfilledRemainder: outcome.unfilledRemainder,
      }
      return makeReferenceOrderIdentity(runId, material)
    }),
  )

export const restrictReferenceBuyFill = (
  runId: string,
  simulatedOrder: SimulatedOrder,
  permittedQuantity: bigint,
): ReferenceComputation<SimulatedOrder> => {
  const modeledQuantity = BigInt(simulatedOrder.filledQuantityMicros)
  if (modeledQuantity === 0n || modeledQuantity === permittedQuantity) return Result.succeed(simulatedOrder)
  if (permittedQuantity < 0n || permittedQuantity > modeledQuantity) {
    return Result.fail({
      _tag: 'ReferenceBuyFillRestrictionInvalid',
      orderId: simulatedOrder.id,
      modeledQuantityMicros: modeledQuantity.toString(),
      permittedQuantityMicros: permittedQuantity.toString(),
    })
  }
  const material = {
    decisionId: simulatedOrder.decisionId,
    sessionDate: simulatedOrder.sessionDate,
    symbol: simulatedOrder.symbol,
    side: simulatedOrder.side,
    requestedQuantityMicros: simulatedOrder.requestedQuantityMicros,
    filledQuantityMicros: permittedQuantity.toString(),
    status: permittedQuantity === 0n ? ('rejected' as const) : ('partially-filled' as const),
    rejectionReason: permittedQuantity === 0n ? ('insufficient-buying-power' as const) : null,
    unfilledRemainder: 'canceled' as const,
  }
  return makeReferenceOrderIdentity(runId, material)
}

export const makeReferenceFill = (
  runId: string,
  decision: DecisionEvent,
  simulatedOrder: SimulatedOrder,
  terms: FillTerms,
  costBasisMicros: bigint,
): ReferenceComputation<FillEvent> => {
  const material = {
    orderId: simulatedOrder.id,
    decisionId: decision.id,
    sessionDate: simulatedOrder.sessionDate,
    symbol: simulatedOrder.symbol,
    side: simulatedOrder.side,
    quantityMicros: simulatedOrder.filledQuantityMicros,
    referencePriceMicros: terms.referencePriceMicros.toString(),
    priceMicros: terms.fillPriceMicros.toString(),
    notionalMicros: terms.notionalMicros.toString(),
    spreadCostMicros: terms.spreadCostMicros.toString(),
    slippageCostMicros: terms.slippageCostMicros.toString(),
    costBasisMicros: costBasisMicros.toString(),
  }
  return makeReferenceFillIdentity(runId, material)
}

export const makeCashChange = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | { kind: 'cash-yield'; id: string; sessionDate: IsoDate },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): ReferenceComputation<CashChange> => makeReferenceCashChangeIdentity(runId, source, amountMicros, cashAfterMicros)

export const replayPrices = (
  session: Session,
  protocol: SimulationProtocol,
  price: (bar: DailyBar) => number,
): ReferenceComputation<Readonly<Record<string, bigint>>> =>
  pipe(
    Result.all(
      protocol.universe.map((symbol) => {
        const bar = session.bars[symbol]
        if (bar === undefined) {
          return Result.fail({
            _tag: 'ReferenceIncompleteSession' as const,
            sessionDate: session.date,
            missingSymbols: [symbol],
            actualSymbolCount: Object.keys(session.bars).length,
            expectedSymbolCount: protocol.universe.length,
          })
        }
        return pipe(
          referencePriceMicros(price(bar), protocol.executionModel),
          Result.map((priceMicros) => [symbol, priceMicros] as const),
        )
      }),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

export const replayPositionValue = (
  prices: Readonly<Record<string, bigint>>,
  positions: ReadonlyMap<string, Position>,
  protocol: SimulationProtocol,
): ReferenceComputation<bigint> => {
  let total = 0n
  for (const symbol of protocol.universe) {
    const priceMicros = prices[symbol]
    if (priceMicros === undefined) return Result.fail({ _tag: 'ReferenceMissingPrice', symbol })
    const notional = notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, priceMicros)
    if (Result.isFailure(notional)) return Result.fail(notional.failure)
    total += notional.success
  }
  return Result.succeed(total)
}

export const replayPriceFor = (
  prices: Readonly<Record<string, bigint>>,
  symbol: string,
): ReferenceComputation<bigint> => {
  const priceMicros = prices[symbol]
  return priceMicros === undefined
    ? Result.fail({ _tag: 'ReferenceMissingPrice', symbol })
    : Result.succeed(priceMicros)
}

export const replayQuantityFor = (
  quantities: Readonly<Record<string, bigint>>,
  symbol: string,
): ReferenceComputation<bigint> => {
  const quantityMicros = quantities[symbol]
  return quantityMicros === undefined
    ? Result.fail({ _tag: 'ReferenceMissingQuantity', symbol })
    : Result.succeed(quantityMicros)
}

export const replayDesiredQuantities = (
  equityMicros: bigint,
  weights: Readonly<Record<string, number>>,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
): ReferenceComputation<Readonly<Record<string, bigint>>> =>
  pipe(
    Result.all(
      protocol.universe.map((symbol) => {
        const weight = weights[symbol]
        if (weight === undefined) return Result.fail({ _tag: 'ReferenceMissingWeight' as const, symbol })
        const priceMicros = prices[symbol]
        if (priceMicros === undefined) return Result.fail({ _tag: 'ReferenceMissingPrice' as const, symbol })
        return pipe(
          desiredQuantityMicros(equityMicros, weight, priceMicros, protocol.executionModel),
          Result.map((quantityMicros) => [symbol, quantityMicros] as const),
        )
      }),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

interface ReferenceBuyCandidate {
  readonly symbol: string
  readonly quantityMicros: bigint
}

const replayBuyFeeInputs = (
  buys: readonly ReferenceBuyCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  minimumNotionalMicros?: bigint,
): ReferenceComputation<readonly FeeInput[]> => {
  const inputs: FeeInput[] = []
  for (const buy of buys) {
    const quantity = scaleQuantityMicros(buy.quantityMicros, scalePpm, protocol.executionModel)
    if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
    if (quantity.success === 0n) continue
    const priceMicros = prices[buy.symbol]
    if (priceMicros === undefined) return Result.fail({ _tag: 'ReferenceMissingPrice', symbol: buy.symbol })
    const referenceNotional = notionalMicros(quantity.success, priceMicros)
    if (Result.isFailure(referenceNotional)) return Result.fail(referenceNotional.failure)
    if (minimumNotionalMicros !== undefined && referenceNotional.success < minimumNotionalMicros) continue
    const terms = makeFillTerms('buy', quantity.success, priceMicros, protocol.executionModel, costMultiplierMicros)
    if (Result.isFailure(terms)) return Result.fail(terms.failure)
    inputs.push({ side: 'buy', quantityMicros: quantity.success, notionalMicros: terms.success.notionalMicros })
  }
  return Result.succeed(inputs)
}

export const replayBuysFitCash = (
  buys: readonly ReferenceBuyCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  availableCashMicros: bigint,
  minimumNotionalMicros?: bigint,
): ReferenceComputation<boolean> =>
  pipe(
    replayBuyFeeInputs(buys, scalePpm, prices, protocol, costMultiplierMicros, minimumNotionalMicros),
    Result.flatMap((inputs) =>
      pipe(
        calculateSessionFees(inputs, protocol.executionModel, costMultiplierMicros),
        Result.map(
          (fees) =>
            inputs.reduce((total, candidate) => total + candidate.notionalMicros, 0n) + fees.totalMicros <=
            availableCashMicros,
        ),
      ),
    ),
  )
