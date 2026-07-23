import { canonicalHashV1 } from './hash'
import type { ExecutionModel, IsoDate, OrderRejectionReason, OrderStatus } from './types'

export const MICROS = 1_000_000n
const PPM = 1_000_000n
const BPS = 10_000n
const WEIGHT_SCALE = 1_000_000_000_000n

export const defaultExecutionModel: ExecutionModel = {
  schemaVersion: 'bayn.execution-model.v1',
  venue: 'alpaca-paper',
  assetClass: 'us-equity',
  order: {
    type: 'market',
    timeInForce: 'day',
    extendedHours: false,
    submitAfter: 'signal-session-close',
    submitBefore: 'next-session-open',
    priceReference: 'next-session-open',
  },
  precision: {
    quantityIncrementMicros: '1',
    priceIncrementMicros: '100',
    minimumBuyNotionalMicros: '1000000',
  },
  priceImpact: {
    halfSpreadBps: 2.5,
    slippageBps: 2.5,
  },
  fees: {
    scheduleVersion: 'alpaca-brokerage-2026-07-01',
    commissionBps: 0,
    secSellBps: 0.206,
    tafSellPerShareMicros: '195',
    tafMaximumPerOrderMicros: '9790000',
    catPerShareMicros: '3',
    aggregation: 'session-by-fee-type',
    roundingIncrementMicros: '10000',
  },
  cash: {
    annualYieldBps: 0,
    dayCount: 'actual-365',
    accrual: 'session-open',
  },
  partialFills: {
    policy: 'deterministic-hash',
    probabilityPpm: 100_000,
    filledFractionPpm: 500_000,
    remainder: 'cancel',
  },
  doubleCostMultiplier: 2,
}

const ensureUnsigned = (value: string, name: string): bigint => {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an unsigned integer string`)
  return BigInt(value)
}

const scaledNumber = (value: number, name: string, scale = Number(MICROS)): bigint => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
  const scaled = value * scale
  const rounded = Math.round(scaled)
  const floatingPointTolerance = Math.max(1e-9, Number.EPSILON * Math.abs(scaled) * 4)
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > floatingPointTolerance) {
    throw new Error(`${name} exceeds fixed-point precision`)
  }
  return BigInt(rounded)
}

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (numerator < 0n || denominator <= 0n) throw new Error('ceilDiv requires non-negative numerator and denominator')
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n
}

const roundDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (numerator < 0n || denominator <= 0n) throw new Error('roundDiv requires non-negative numerator and denominator')
  return (numerator + denominator / 2n) / denominator
}

const quantizeDown = (value: bigint, increment: bigint): bigint => {
  if (value < 0n || increment <= 0n) throw new Error('quantization requires non-negative value and positive increment')
  return (value / increment) * increment
}

const quantizeUp = (value: bigint, increment: bigint): bigint => ceilDiv(value, increment) * increment

const quantizeNearest = (value: bigint, increment: bigint): bigint => roundDiv(value, increment) * increment

export const numberToMicros = (value: number, name = 'value'): bigint => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
  const scaled = Math.round(value * Number(MICROS))
  if (!Number.isSafeInteger(scaled)) throw new Error(`${name} exceeds monetary precision`)
  return BigInt(scaled)
}

export const microsToNumber = (value: bigint): number => Number(value) / Number(MICROS)

export const referencePriceMicros = (price: number, model: ExecutionModel): bigint => {
  if (!Number.isFinite(price) || price <= 0) throw new Error('reference price must be finite and positive')
  const increment = ensureUnsigned(model.precision.priceIncrementMicros, 'price increment')
  if (increment === 0n) throw new Error('price increment must be positive')
  const quantized = quantizeNearest(numberToMicros(price, 'reference price'), increment)
  if (quantized === 0n) throw new Error('reference price rounds to zero')
  return quantized
}

export const notionalMicros = (quantityMicros: bigint, priceMicros: bigint): bigint =>
  roundDiv(quantityMicros * priceMicros, MICROS)

export const desiredQuantityMicros = (
  equityMicros: bigint,
  weight: number,
  priceMicros: bigint,
  model: Pick<ExecutionModel, 'precision'>,
): bigint => {
  if (equityMicros < 0n || priceMicros <= 0n) throw new Error('desired quantity requires valid equity and price')
  const weightUnits = scaledNumber(weight, 'target weight', Number(WEIGHT_SCALE))
  if (weightUnits > WEIGHT_SCALE) throw new Error('target weight exceeds one')
  const increment = ensureUnsigned(model.precision.quantityIncrementMicros, 'quantity increment')
  if (increment === 0n) throw new Error('quantity increment must be positive')
  const raw = (equityMicros * weightUnits * MICROS) / (WEIGHT_SCALE * priceMicros)
  return quantizeDown(raw, increment)
}

const impactedDelta = (reference: bigint, bps: number, costMultiplierMicros: bigint): bigint => {
  const bpsMicros = scaledNumber(bps, 'execution cost basis points')
  return ceilDiv(reference * bpsMicros * costMultiplierMicros, BPS * MICROS * MICROS)
}

export interface FillTerms {
  readonly referencePriceMicros: bigint
  readonly fillPriceMicros: bigint
  readonly notionalMicros: bigint
  readonly spreadCostMicros: bigint
  readonly slippageCostMicros: bigint
}

export const makeFillTerms = (
  side: 'buy' | 'sell',
  quantityMicros: bigint,
  referencePrice: bigint,
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): FillTerms => {
  if (quantityMicros <= 0n || referencePrice <= 0n) throw new Error('fill terms require positive quantity and price')
  if (costMultiplierMicros <= 0n) throw new Error('cost multiplier must be positive')
  const increment = ensureUnsigned(model.precision.priceIncrementMicros, 'price increment')
  if (increment === 0n) throw new Error('price increment must be positive')
  const spreadDelta = impactedDelta(referencePrice, model.priceImpact.halfSpreadBps, costMultiplierMicros)
  const slippageDelta = impactedDelta(referencePrice, model.priceImpact.slippageBps, costMultiplierMicros)
  const spreadPrice =
    side === 'buy'
      ? quantizeUp(referencePrice + spreadDelta, increment)
      : quantizeDown(referencePrice > spreadDelta ? referencePrice - spreadDelta : 0n, increment)
  const fillPrice =
    side === 'buy'
      ? quantizeUp(referencePrice + spreadDelta + slippageDelta, increment)
      : quantizeDown(
          referencePrice > spreadDelta + slippageDelta ? referencePrice - spreadDelta - slippageDelta : 0n,
          increment,
        )
  if (spreadPrice <= 0n || fillPrice <= 0n) throw new Error('execution costs consume the reference price')
  return {
    referencePriceMicros: referencePrice,
    fillPriceMicros: fillPrice,
    notionalMicros: notionalMicros(quantityMicros, fillPrice),
    spreadCostMicros: notionalMicros(
      quantityMicros,
      spreadPrice > referencePrice ? spreadPrice - referencePrice : referencePrice - spreadPrice,
    ),
    slippageCostMicros: notionalMicros(
      quantityMicros,
      fillPrice > spreadPrice ? fillPrice - spreadPrice : spreadPrice - fillPrice,
    ),
  }
}

export interface OrderOutcome {
  readonly requestedQuantityMicros: bigint
  readonly filledQuantityMicros: bigint
  readonly status: OrderStatus
  readonly rejectionReason: OrderRejectionReason | null
  readonly unfilledRemainder: 'none' | 'canceled'
}

export const makeOrderOutcome = (input: {
  readonly identity: unknown
  readonly side: 'buy' | 'sell'
  readonly requestedQuantityMicros: bigint
  readonly referencePriceMicros: bigint
  readonly model: ExecutionModel
}): OrderOutcome => {
  const quantityIncrement = ensureUnsigned(input.model.precision.quantityIncrementMicros, 'quantity increment')
  if (quantityIncrement === 0n) throw new Error('quantity increment must be positive')
  const requested = quantizeDown(input.requestedQuantityMicros, quantityIncrement)
  const reject = (reason: OrderRejectionReason): OrderOutcome => ({
    requestedQuantityMicros: requested,
    filledQuantityMicros: 0n,
    status: 'rejected',
    rejectionReason: reason,
    unfilledRemainder: 'canceled',
  })
  if (requested === 0n) return reject('zero-after-rounding')
  if (
    input.side === 'buy' &&
    notionalMicros(requested, input.referencePriceMicros) <
      ensureUnsigned(input.model.precision.minimumBuyNotionalMicros, 'minimum buy notional')
  ) {
    return reject('below-minimum-buy-notional')
  }

  const probability = BigInt(input.model.partialFills.probabilityPpm)
  const bucket = BigInt(`0x${canonicalHashV1(input.identity).slice(0, 16)}`) % PPM
  if (bucket >= probability) {
    return {
      requestedQuantityMicros: requested,
      filledQuantityMicros: requested,
      status: 'filled',
      rejectionReason: null,
      unfilledRemainder: 'none',
    }
  }
  const filled = quantizeDown((requested * BigInt(input.model.partialFills.filledFractionPpm)) / PPM, quantityIncrement)
  if (filled === 0n) return reject('zero-after-rounding')
  return {
    requestedQuantityMicros: requested,
    filledQuantityMicros: filled,
    status: 'partially-filled',
    rejectionReason: null,
    unfilledRemainder: 'canceled',
  }
}

export interface FeeInput {
  readonly side: 'buy' | 'sell'
  readonly quantityMicros: bigint
  readonly notionalMicros: bigint
}

export interface FeeBreakdown {
  readonly commissionMicros: bigint
  readonly secMicros: bigint
  readonly tafMicros: bigint
  readonly catMicros: bigint
  readonly totalMicros: bigint
}

const roundedFee = (numerator: bigint, denominator: bigint, increment: bigint): bigint =>
  numerator === 0n ? 0n : ceilDiv(numerator, denominator * increment) * increment

export const calculateSessionFees = (
  fills: readonly FeeInput[],
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): FeeBreakdown => {
  if (costMultiplierMicros <= 0n) throw new Error('cost multiplier must be positive')
  const rounding = ensureUnsigned(model.fees.roundingIncrementMicros, 'fee rounding increment')
  if (rounding === 0n) throw new Error('fee rounding increment must be positive')
  const totalNotional = fills.reduce((sum, fill) => sum + fill.notionalMicros, 0n)
  const sellNotional = fills.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.notionalMicros : 0n), 0n)
  const totalQuantity = fills.reduce((sum, fill) => sum + fill.quantityMicros, 0n)
  const commission = roundedFee(
    totalNotional * scaledNumber(model.fees.commissionBps, 'commission basis points') * costMultiplierMicros,
    BPS * MICROS * MICROS,
    rounding,
  )
  const sec = roundedFee(
    sellNotional * scaledNumber(model.fees.secSellBps, 'SEC basis points') * costMultiplierMicros,
    BPS * MICROS * MICROS,
    rounding,
  )
  const tafRate = ensureUnsigned(model.fees.tafSellPerShareMicros, 'TAF share rate')
  const tafCap = ensureUnsigned(model.fees.tafMaximumPerOrderMicros, 'TAF order cap')
  const tafNumerator = fills.reduce(
    (sum, fill) =>
      fill.side === 'sell'
        ? sum + (fill.quantityMicros * tafRate < tafCap * MICROS ? fill.quantityMicros * tafRate : tafCap * MICROS)
        : sum,
    0n,
  )
  const taf = roundedFee(tafNumerator * costMultiplierMicros, MICROS * MICROS, rounding)
  const catRate = ensureUnsigned(model.fees.catPerShareMicros, 'CAT share rate')
  const cat = roundedFee(totalQuantity * catRate * costMultiplierMicros, MICROS * MICROS, rounding)
  const total = commission + sec + taf + cat
  return {
    commissionMicros: commission,
    secMicros: sec,
    tafMicros: taf,
    catMicros: cat,
    totalMicros: total,
  }
}

export const accrueCashYield = (cashMicros: bigint, elapsedDays: number, model: ExecutionModel): bigint => {
  if (cashMicros < 0n) throw new Error('cash yield cannot accrue on negative cash')
  if (!Number.isInteger(elapsedDays) || elapsedDays < 0) throw new Error('elapsed days must be a non-negative integer')
  const annualYieldBps = scaledNumber(model.cash.annualYieldBps, 'annual cash yield basis points')
  return (cashMicros * annualYieldBps * BigInt(elapsedDays)) / (BPS * MICROS * 365n)
}

export const elapsedCalendarDays = (from: IsoDate, to: IsoDate): number => {
  const fromTime = Date.parse(`${from}T00:00:00Z`)
  const toTime = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) {
    throw new Error('cash accrual dates are invalid or unordered')
  }
  return (toTime - fromTime) / 86_400_000
}

export const saleCostBasisMicros = (
  positionCostBasisMicros: bigint,
  soldQuantityMicros: bigint,
  positionQuantityMicros: bigint,
): bigint => {
  if (positionCostBasisMicros < 0n || soldQuantityMicros < 0n || positionQuantityMicros <= 0n) {
    throw new Error('sale cost basis requires a positive position and non-negative values')
  }
  if (soldQuantityMicros > positionQuantityMicros) throw new Error('sale quantity exceeds the position')
  return roundDiv(positionCostBasisMicros * soldQuantityMicros, positionQuantityMicros)
}

export const scaleQuantityMicros = (quantityMicros: bigint, scalePpm: bigint, model: ExecutionModel): bigint => {
  if (scalePpm < 0n || scalePpm > PPM) throw new Error('quantity scale must be between zero and one million')
  const increment = ensureUnsigned(model.precision.quantityIncrementMicros, 'quantity increment')
  return quantizeDown((quantityMicros * scalePpm) / PPM, increment)
}

export const ppm = PPM
