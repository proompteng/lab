import { Result, Schema } from 'effect'

import {
  asset,
  decodeMacroEtfCorePolicy,
  type Etf,
  EtfSchema,
  type MacroEtfCoreEvidenceError,
  evidenceFailure,
  parameters,
  strict,
  universe,
} from './policy'
import { EpochMs, SessionDate, Sha256 } from './signals'

const PositiveMicros = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n))
const NonnegativeMicros = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n))
const sharesSchema = PositiveMicros
const Ticker = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,14}$/))
const OpenMarkSchema = Schema.Struct({
  symbol: EtfSchema,
  openAt: EpochMs,
  availableAt: EpochMs,
  openMicros: PositiveMicros,
  priorCloseAt: Schema.optional(EpochMs),
  priorCloseMicros: Schema.optional(PositiveMicros),
  marginable: Schema.Boolean,
})
const SignalSchema = Schema.Struct({
  policyHash: Sha256,
  signalDate: SessionDate,
  signalCloseAt: EpochMs,
  executionDate: SessionDate,
  executionOpenAt: EpochMs,
  weights: Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
})
const BookSchema = Schema.Struct({
  asOf: EpochMs,
  priorEquityMicros: PositiveMicros,
  cashMicros: Schema.BigInt,
  grossCapMicros: NonnegativeMicros,
  debitCapMicros: NonnegativeMicros,
  oneWayBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  // The reconciled caller passes only positions owned by this sleeve. Pending orders and foreign
  // holdings reserve capacity outside this plan; overlapping foreign symbols must be protected.
  positions: Schema.Array(Schema.Struct({ symbol: EtfSchema, shares: sharesSchema })),
  protectedSymbols: Schema.Array(Ticker),
  marks: Schema.Array(OpenMarkSchema),
})

const weightScale = 1_000_000_000_000n
const bpsScale = 10_000n
const dollar = 1_000_000n
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

export const withShyCarry = (weights: readonly number[]) => {
  const residual = Math.max(0, 1 - weights.reduce((sum, weight) => sum + weight, 0))
  return weights.map((weight, i) => weight + (i === asset.SHY ? residual : 0))
}

const fixedWeight = (weight: number) => BigInt(Math.floor(weight * Number(weightScale)))

/** The registered max(buy drift, sell drift) threshold, evaluated at the preceding close. */
export const rebalanceDue = (rows: readonly { weight: number; priorMicros: bigint }[], equity: bigint) => {
  let buys = 0n
  let sells = 0n
  for (const { weight, priorMicros } of rows) {
    const drift = fixedWeight(weight) * equity - priorMicros * weightScale
    if (drift > 0n) buys += drift
    else sells -= drift
  }
  return max(buys, sells) * bpsScale >= equity * weightScale * BigInt(parameters.deadbandBps)
}

export const wholeShareCost = (notionalMicros: bigint, side: 'sell' | 'buy', oneWayBps: number) => {
  const slippage = ceilDiv(notionalMicros * BigInt(oneWayBps), bpsScale)
  // 0.21 bp on sell proceeds, as in Wave 6C. Round charges against the sleeve.
  const fee = side === 'sell' ? ceilDiv((notionalMicros - slippage) * 21n, 1_000_000n) : 0n
  return slippage + fee
}

export type MacroEtfCoreOrder = {
  readonly symbol: Etf
  readonly side: 'sell' | 'buy'
  readonly shares: bigint
  readonly priceMicros: bigint
  readonly costMicros: bigint
}

export type MacroEtfCorePlan = {
  readonly orders: readonly MacroEtfCoreOrder[]
  readonly cashMicros: bigint
  readonly grossMicros: bigint
  readonly blocked: readonly Etf[]
  readonly deadband: boolean
}

type Mark = typeof OpenMarkSchema.Type

const marginBps = ({ openMicros, marginable }: Mark) => (!marginable || openMicros < 2_500_000n ? bpsScale : 5_000n)

/** Uses reconciled sleeve cash and already-reserved residual caps. This is a plan, not broker authority. */
export const planMacroEtfCoreRebalance = (
  policyInput: unknown,
  signalInput: unknown,
  bookInput: unknown,
): Result.Result<MacroEtfCorePlan, MacroEtfCoreEvidenceError> => {
  const policy = decodeMacroEtfCorePolicy(policyInput)
  if (Result.isFailure(policy)) return Result.fail(policy.failure)
  const decodedSignal = Schema.decodeUnknownResult(SignalSchema)(signalInput, strict)
  if (Result.isFailure(decodedSignal)) return evidenceFailure('Invalid macro ETF target', decodedSignal.failure)
  const book = Schema.decodeUnknownResult(BookSchema)(bookInput, strict)
  if (Result.isFailure(book)) return evidenceFailure('Invalid macro ETF opening book', book.failure)
  const signal = decodedSignal.success
  const { asOf, cashMicros, grossCapMicros, debitCapMicros, priorEquityMicros, oneWayBps } = book.success
  const sum = signal.weights.reduce((total, weight) => total + weight, 0)
  if (
    signal.policyHash !== policy.success.hash ||
    signal.signalDate >= signal.executionDate ||
    signal.signalCloseAt >= signal.executionOpenAt ||
    new Date(signal.signalCloseAt).toISOString().slice(0, 10) !== signal.signalDate ||
    new Date(signal.executionOpenAt).toISOString().slice(0, 10) !== signal.executionDate ||
    asOf !== signal.executionOpenAt ||
    signal.weights.length !== universe.length ||
    sum > 1 + 1e-12
  )
    return evidenceFailure('Policy, next-open binding or allocation mismatch')
  const positions = new Map(book.success.positions.map(({ symbol, shares }) => [symbol, shares]))
  const marks = new Map(book.success.marks.map((mark) => [mark.symbol, mark]))
  const protectedSymbols = new Set(book.success.protectedSymbols)
  if (
    positions.size !== book.success.positions.length ||
    marks.size !== book.success.marks.length ||
    protectedSymbols.size !== book.success.protectedSymbols.length ||
    book.success.marks.some(
      (mark) =>
        mark.openAt !== signal.executionOpenAt ||
        mark.availableAt < mark.openAt ||
        mark.availableAt > asOf ||
        (mark.priorCloseAt === undefined) !== (mark.priorCloseMicros === undefined) ||
        (mark.priorCloseAt !== undefined && mark.priorCloseAt !== signal.signalCloseAt),
    )
  )
    return evidenceFailure('Duplicate position/protection/price or unbound execution price')
  const weights = withShyCarry(signal.weights)
  const blocked: Etf[] = []
  const rows = []
  let gross = 0n
  let margin = 0n
  let priorGross = 0n
  for (const [i, symbol] of universe.entries()) {
    const held = positions.get(symbol) ?? 0n
    const weight = weights[i]
    if (weight === undefined) return evidenceFailure('Incomplete macro ETF weights')
    const protectedSymbol = protectedSymbols.has(symbol)
    if (protectedSymbol && (weight > 0 || held > 0n)) blocked.push(symbol)
    if (held === 0n && (weight === 0 || protectedSymbol)) continue
    const mark = marks.get(symbol)
    if (mark === undefined || (held > 0n && mark.priorCloseMicros === undefined))
      return evidenceFailure(`Missing required execution pricing: ${symbol} ${signal.executionDate}`)
    const current = held * mark.openMicros
    const prior = held * (mark.priorCloseMicros ?? 0n)
    const marginRate = marginBps(mark)
    gross += current
    margin += current * marginRate
    priorGross += prior
    rows.push({ symbol, held, price: mark.openMicros, marginRate, weight, priorMicros: prior, protectedSymbol })
  }
  const equity = cashMicros + gross
  if (priorGross > priorEquityMicros + debitCapMicros || equity <= 0n)
    return evidenceFailure('Unfunded prior or opening sleeve')
  const compliant = (cash: bigint, exposure: bigint, requirement: bigint) =>
    cash + exposure > 0n &&
    exposure <= grossCapMicros &&
    cash >= -(cash + exposure >= 2_000n * dollar ? debitCapMicros : 0n) &&
    requirement <= (cash + exposure) * bpsScale
  const deadband = !rebalanceDue(
    rows.filter((row) => !row.protectedSymbol),
    priorEquityMicros,
  )
  if (deadband) {
    if (!compliant(cashMicros, gross, margin)) return evidenceFailure('Opening sleeve exceeds limits inside deadband')
    return Result.succeed<MacroEtfCorePlan>({ orders: [], cashMicros, grossMicros: gross, blocked, deadband })
  }

  let cash = cashMicros
  const budget = min(equity, grossCapMicros)
  const changes = rows.map((row) => ({
    ...row,
    desired: row.protectedSymbol ? row.held : (fixedWeight(row.weight) * budget) / (weightScale * row.price),
  }))
  const orders: MacroEtfCoreOrder[] = []
  for (const { symbol, held, desired, price, marginRate } of changes) {
    if (desired >= held) continue
    const shares = held - desired
    const notional = shares * price
    const costMicros = wholeShareCost(notional, 'sell', oneWayBps)
    orders.push({ symbol, side: 'sell', shares, priceMicros: price, costMicros })
    cash += notional - costMicros
    gross -= notional
    margin -= notional * marginRate
  }
  if (!compliant(cash, gross, margin)) return evidenceFailure('Sell leg cannot restore a compliant opening sleeve')
  for (const { symbol, held, desired, price, marginRate } of changes) {
    if (desired <= held) continue
    let lo = 0n
    let hi = min(desired - held, (grossCapMicros - gross) / price)
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n
      const notional = mid * price
      const cost = wholeShareCost(notional, 'buy', oneWayBps)
      if (compliant(cash - notional - cost, gross + notional, margin + notional * marginRate)) lo = mid
      else hi = mid - 1n
    }
    if (lo === 0n) continue
    const notional = lo * price
    const costMicros = wholeShareCost(notional, 'buy', oneWayBps)
    orders.push({ symbol, side: 'buy', shares: lo, priceMicros: price, costMicros })
    cash -= notional + costMicros
    gross += notional
    margin += notional * marginRate
  }
  return Result.succeed<MacroEtfCorePlan>({ orders, cashMicros: cash, grossMicros: gross, blocked, deadband })
}
