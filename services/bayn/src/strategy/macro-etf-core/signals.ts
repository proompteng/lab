import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'

import {
  asset,
  decodeMacroEtfCorePolicy,
  emptyWeights,
  type Etf,
  type MacroEtfCoreEvidenceError,
  EtfSchema,
  evidenceFailure,
  parameters,
  Profile,
  strict,
  universe,
} from './policy'

export const PositivePrice = Schema.Finite.check(Schema.isGreaterThan(0))
export const EpochMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8.64e15 }))
export const SessionDate = Schema.String.check(
  Schema.makeFilter((date) => {
    const time = Date.parse(date)
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
    )
  }),
)
const SessionSchema = Schema.Struct({ date: SessionDate, openAt: EpochMs, closeAt: EpochMs })
const CloseBarSchema = Schema.Struct({
  symbol: EtfSchema,
  date: SessionDate,
  open: PositivePrice,
  high: PositivePrice,
  low: PositivePrice,
  close: PositivePrice,
  availableAt: EpochMs,
})
export const closeSnapshotSchema = 'bayn.macro-etf-core-close-snapshot.v1'
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const CloseSnapshot = Schema.Struct({
  schema: Schema.Literal(closeSnapshotSchema),
  datasetVersion: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/)),
  adjustment: Schema.Literal('all'),
  calendar: Schema.Array(SessionSchema),
  bars: Schema.Array(Schema.Array(CloseBarSchema)),
})
const EvidenceSchema = Schema.Struct({
  asOf: EpochMs,
  snapshot: CloseSnapshot,
  snapshotHash: Sha256,
})

export type MacroEtfCoreSignal = {
  readonly policyHash: string
  readonly signalDate: string
  readonly signalCloseAt: number
  readonly executionDate: string
  readonly executionOpenAt: number
  readonly weights: readonly number[]
}

const optional = new Set<Etf>(parameters.optionalCandidates)
const required = universe.filter((symbol) => !optional.has(symbol))
type Closes = readonly (readonly (number | undefined)[])[]
type Matrix = number[][]

// Indexed vectors below are built in lockstep, after checking the external evidence.
const atIndex = <A>(values: readonly A[], i: number): A => {
  const value = values[i]
  if (value === undefined) throw new Error(`Macro ETF vector dimension mismatch at index ${i}`)
  return value
}

const validateCloses = (input: unknown) => {
  const decoded = Schema.decodeUnknownResult(EvidenceSchema)(input, strict)
  if (Result.isFailure(decoded)) return evidenceFailure('Invalid macro ETF close evidence', decoded.failure)
  const { asOf, snapshot, snapshotHash } = decoded.success
  const { calendar, bars } = snapshot
  if (calendar.length !== bars.length + 1 || calendar[0]?.date !== parameters.epoch)
    return evidenceFailure(
      'Expected epoch-anchored calendar with exactly one execution session after the close history',
    )
  if (bars.length < parameters.warmup) return evidenceFailure('Insufficient macro ETF warmup')
  for (const [i, session] of calendar.entries()) {
    const prior = calendar[i - 1]
    if (
      session.openAt >= session.closeAt ||
      new Date(session.openAt).toISOString().slice(0, 10) !== session.date ||
      new Date(session.closeAt).toISOString().slice(0, 10) !== session.date ||
      (prior !== undefined && (session.date <= prior.date || session.openAt <= prior.closeAt))
    )
      return evidenceFailure(`Invalid or non-monotonic session: ${session.date}`)
  }
  const closes: (number | undefined)[][] = []
  for (const [i, rows] of bars.entries()) {
    const session = calendar[i]
    const next = calendar[i + 1]
    if (session === undefined || next === undefined) return evidenceFailure('Unbound close history')
    const cutoff = Math.min(asOf, next.openAt)
    const close = Array<number | undefined>(universe.length).fill(undefined)
    for (const row of rows) {
      if (
        row.date !== session.date ||
        row.availableAt < session.closeAt ||
        row.availableAt > cutoff ||
        row.low > Math.min(row.open, row.close) ||
        row.high < Math.max(row.open, row.close) ||
        close[asset[row.symbol]] !== undefined
      )
        return evidenceFailure(`Premature, malformed, unordered or duplicate close: ${row.symbol} ${row.date}`)
      close[asset[row.symbol]] = row.close
    }
    const missing = required.find((symbol) => close[asset[symbol]] === undefined)
    if (missing !== undefined) return evidenceFailure(`Missing required close: ${missing} ${session.date}`)
    closes.push(close)
  }
  const digest = canonicalHashV1Result(snapshot)
  if (Result.isFailure(digest)) return evidenceFailure('Cannot hash canonical close snapshot', digest.failure)
  if (digest.success !== snapshotHash) return evidenceFailure('Close snapshot SHA-256 mismatch')
  return Result.succeed({ closes, asOf, calendar })
}

const prefix = (values: readonly number[]) => {
  const sums = [0]
  for (const value of values) sums.push(atIndex(sums, sums.length - 1) + value)
  return sums
}

const riskParity = (covariance: Matrix, budget: readonly number[]) => {
  const x = budget.map((b, i) => Math.sqrt(b / atIndex(atIndex(covariance, i), i)))
  // Solve x_i (Σx)_i = b_i by the registered positive cyclic coordinate descent.
  for (let pass = 0; pass < parameters.riskParityPasses; pass++) {
    for (const [i, b] of budget.entries()) {
      const row = atIndex(covariance, i)
      const diagonal = atIndex(row, i)
      const other = x.reduce((sum, value, j) => (i === j ? sum : sum + atIndex(row, j) * value), 0)
      const root = Math.sqrt(other * other + 4 * diagonal * b)
      x[i] = other > 0 ? (2 * b) / (root + other) : (root - other) / (2 * diagonal)
    }
  }
  const total = x.reduce((sum, value) => sum + value, 0)
  return x.map((value) => value / total)
}

const riskBasis = (closes: Closes) => {
  const sleeves = parameters.riskParitySleeves
  const indices = sleeves.flat().map((symbol) => asset[symbol])
  const budget = sleeves.flatMap((sleeve) => sleeve.map(() => 1 / (sleeves.length * sleeve.length)))
  const returns = indices.map((index) =>
    closes.map((row, i) => {
      // Required risk-parity closes are validated before this calculation.
      if (i === 0) return 0
      return Math.log((row[index] ?? NaN) / (atIndex(closes, i - 1)[index] ?? NaN))
    }),
  )
  const sums = returns.map(prefix)
  const products = returns.map((a, i) => returns.slice(0, i + 1).map((b) => prefix(a.map((v, t) => v * atIndex(b, t)))))
  return (t: number) => {
    const covariance = (n: number) => {
      const trailing = (series: readonly number[]) => (atIndex(series, t + 1) - atIndex(series, t + 1 - n)) / n
      return indices.map((_, i) =>
        indices.map(
          (__, j) =>
            trailing(atIndex(atIndex(products, Math.max(i, j)), Math.min(i, j))) -
            trailing(atIndex(sums, i)) * trailing(atIndex(sums, j)),
        ),
      )
    }
    const [fast, mid, slow] = parameters.covarianceWindows
    const long = covariance(slow)
    const core = riskParity(
      long.map((row, i) =>
        row.map((value, j) =>
          i === j
            ? value + parameters.annualVarianceFloor / parameters.annualSessions
            : value * parameters.covarianceOffDiagonal,
        ),
      ),
      budget,
    )
    const volatility = (matrix: Matrix) => {
      const variance = core.reduce(
        (total, weight, i) =>
          total + weight * core.reduce((row, value, j) => row + value * atIndex(atIndex(matrix, i), j), 0),
        0,
      )
      return Math.sqrt(Math.max(0, variance) * parameters.annualSessions)
    }
    const base = emptyWeights()
    indices.forEach((index, i) => {
      base[index] = atIndex(core, i)
    })
    return { base, fast: volatility(covariance(fast)), mid: volatility(covariance(mid)), slow: volatility(long) }
  }
}

const trends = (closes: Closes) => {
  const cache = new Map<string, readonly number[]>()
  return (a: Etf, b?: Etf) => {
    const key = `${a}/${b ?? ''}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let ema = 0
    const path = closes.map((row, i) => {
      const value = (row[asset[a]] ?? NaN) / (b === undefined ? 1 : (row[asset[b]] ?? NaN))
      const seen = i + 1
      ema += (value - ema) * (seen <= parameters.ema ? 1 / seen : 2 / (parameters.ema + 1))
      return seen < parameters.ema ? 0 : value / ema - 1
    })
    cache.set(key, path)
    return path
  }
}

const haven = (trend: (a: Etf, b?: Etf) => number) => {
  const duration = Math.sign(trend('TLT', 'IEF')) + Math.sign(trend('TLT', 'SHY'))
  const inflation = Math.sign(trend('DBC', 'TLT')) + Math.sign(trend('GLD', 'TLT'))
  let best: Etf | undefined
  let highest = 0
  for (const symbol of parameters.havens) {
    if (
      (symbol === 'TLT' && (duration < 0 || inflation > 0)) ||
      (symbol === 'IEF' && duration < 0 && inflation > 0) ||
      (symbol === 'DBC' && inflation < 0) ||
      (symbol === 'UUP' && trend('UUP', 'SHY') <= 0)
    )
      continue
    const score = trend(symbol)
    if (score > highest) {
      best = symbol
      highest = score
    }
  }
  return best
}

const evaluate = (
  policyInput: unknown,
  input: unknown,
  atNextOpen: boolean,
): Result.Result<readonly MacroEtfCoreSignal[], MacroEtfCoreEvidenceError> => {
  const policy = decodeMacroEtfCorePolicy(policyInput)
  if (Result.isFailure(policy)) return Result.fail(policy.failure)
  const evidence = validateCloses(input)
  if (Result.isFailure(evidence)) return Result.fail(evidence.failure)
  const { profile, settings, hash } = policy.success
  const { closes, asOf, calendar } = evidence.success
  const next = atIndex(calendar, calendar.length - 1)
  if (atNextOpen && asOf > next.openAt) return evidenceFailure(`Missed next-open cutoff: ${next.date}`)
  const trend = trends(closes)
  const basis = profile === Profile.F4 ? riskBasis(closes) : undefined
  const consecutive = emptyWeights()
  let smoothed = emptyWeights()
  const observations: MacroEtfCoreSignal[] = []
  for (const [t, row] of closes.entries()) {
    row.forEach((price, i) => {
      consecutive[i] = price === undefined ? 0 : atIndex(consecutive, i) + 1
    })
    const elapsed = t - parameters.warmup + 1
    if (elapsed < 0) continue
    const at = (a: Etf, b?: Etf) => atIndex(trend(a, b), t)
    const session = atIndex(calendar, t)
    const primary = at('HYG', settings.credit)
    const secondary = at('HYG', settings.secondary)
    const defensive = haven(at)
    if (
      ![
        primary,
        secondary,
        at('TLT', 'IEF'),
        at('TLT', 'SHY'),
        at('DBC', 'TLT'),
        at('GLD', 'TLT'),
        at('UUP', 'SHY'),
        ...parameters.havens.map((symbol) => at(symbol)),
      ].every(Number.isFinite)
    )
      return evidenceFailure(`Nonfinite trend calculation: ${session.date}`)
    const { primaryVotes, secondaryVotes } = parameters
    const offense =
      (Number(primary > 0) * primaryVotes + Number(secondary > 0) * secondaryVotes) / (primaryVotes + secondaryVotes)
    const target = emptyWeights()
    for (const group of parameters.offense) {
      const eligible = group.members.filter(
        (symbol) => atIndex(consecutive, asset[symbol]) >= parameters.minimumCandidateHistory,
      )
      for (const symbol of eligible) target[asset[symbol]] = (offense * group.budget) / eligible.length
    }
    if (defensive !== undefined) target[asset[defensive]] = 1 - offense
    smoothed = target.map(
      (value, i) => atIndex(smoothed, i) + (2 / (parameters.smoothing + 1)) * (value - atIndex(smoothed, i)),
    )
    if (elapsed % parameters.cadence !== 0) continue
    let weights = smoothed
    if (basis !== undefined && 'mix' in settings) {
      const { base, fast, mid, slow } = basis(t)
      if (![fast, mid, slow].every(Number.isFinite))
        return evidenceFailure(`Invalid macro ETF volatility: ${session.date}`)
      const scale = (vol: number) =>
        Math.min(
          1,
          (parameters.targetVolatility / Math.max(vol, parameters.volatilityFloor)) ** settings.volatilityPower,
        )
      const compression =
        1 -
        (parameters.compressionCut *
          (Number(fast > parameters.compressionRatio * mid) + Number(mid > parameters.compressionRatio * slow))) /
          2
      const [w1, w2, w3] = settings.mix
      weights = base.map(
        (weight, i) => weight * (w1 * scale(mid) + w3 * scale(slow) * compression) + w2 * atIndex(smoothed, i),
      )
    }
    if (
      weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
      weights.reduce((sum, weight) => sum + weight, 0) > 1 + 1e-12
    )
      return evidenceFailure(`Invalid macro ETF allocation: ${session.date}`)
    if (atNextOpen && t !== closes.length - 1) continue
    observations.push(
      Object.freeze({
        policyHash: hash,
        signalDate: session.date,
        signalCloseAt: session.closeAt,
        executionDate: atIndex(calendar, t + 1).date,
        executionOpenAt: atIndex(calendar, t + 1).openAt,
        weights: Object.freeze(weights),
      }),
    )
  }
  return Result.succeed(observations)
}

/** Offline replay. Every review uses only its own and preceding closes; no partial path is returned on invalid evidence. */
export const replayMacroEtfCoreSignals = (policy: unknown, input: unknown) => evaluate(policy, input, false)

/** Production observation. A valid off-cadence observation returns no target, not a zero allocation. */
export const computeMacroEtfCoreSignal = (policy: unknown, input: unknown) =>
  evaluate(policy, input, true).pipe(Result.map((observations) => observations[0]))
