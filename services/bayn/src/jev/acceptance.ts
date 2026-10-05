import { BigDecimal, Data, Result, Schema } from 'effect'

import protocol from '../../../../docs/bayn/jev-migration-acceptance-v2.json'
import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

export enum JevResearchPolicy {
  Candidate = 'JEV',
  Deployed = 'DEPLOYED_BAYN',
  Momentum = 'REPEATED_MOMENTUM',
  Ablation = 'JEV_ABLATION',
}

export enum JevNumericalVerdict {
  Passed = 'NUMERICAL_TARGETS_PASSED',
  Missed = 'TARGETS_MISSED',
  Inconclusive = 'INCONCLUSIVE',
}

const Money = Schema.Finite.check(Schema.isBetween({ minimum: -1_000_000_000, maximum: 1_000_000_000 }))
const NonNegativeMoney = Money.check(Schema.isGreaterThanOrEqualTo(0))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const CompleteSession = Schema.Struct({
  status: Schema.Literal('COMPLETE'),
  sessionDate: IsoDateSchema,
  evidenceHash: Sha256Schema,
  completedEpisodes: Count,
  filledNotionalUsd: NonNegativeMoney,
  netPnlUsd: Money,
  openingEquityUsd: NonNegativeMoney,
  closingEquityUsd: NonNegativeMoney,
  minimumEquityUsd: NonNegativeMoney,
  maximumEquityUsd: NonNegativeMoney,
  maximumDrawdownUsd: NonNegativeMoney,
  maximumMarkGapMs: Count,
  p95LatencyStress: Schema.Union([
    Schema.Struct({ status: Schema.Literal('COMPLETE'), netPnlUsd: Money, evidenceHash: Sha256Schema }),
    Schema.Struct({ status: Schema.Literal('UNRESOLVED'), evidenceHash: Sha256Schema }),
  ]),
})

const Session = Schema.Union([
  CompleteSession,
  Schema.Struct({ status: Schema.Literal('UNRESOLVED'), sessionDate: IsoDateSchema, evidenceHash: Sha256Schema }),
])

export const JevAcceptanceInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-acceptance-input.v1'),
  protocolHash: Sha256Schema,
  registration: Schema.Struct({
    planHash: Sha256Schema,
    lockedAt: UtcInstantSchema,
    attemptIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
    sessions: Schema.Array(
      Schema.Struct({ sessionDate: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema }),
    ).check(Schema.isMinLength(20), Schema.isMaxLength(20)),
  }),
  policies: Schema.Array(
    Schema.Struct({
      policy: Schema.Enum(JevResearchPolicy),
      definitionHash: Sha256Schema,
      sessions: Schema.Array(Session).check(Schema.isMinLength(20), Schema.isMaxLength(20)),
    }),
  ).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
})

export type JevAcceptanceInput = typeof JevAcceptanceInputSchema.Type
type CompleteSeries = {
  readonly policy: JevResearchPolicy
  readonly sessions: ReadonlyArray<typeof CompleteSession.Type>
}

export class JevAcceptanceError extends Data.TaggedError('JevAcceptanceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const jevAcceptanceProtocolHash = () => canonicalHashV1Result(protocol)

const sum = (values: ReadonlyArray<bigint>): bigint => values.reduce((total, value) => total + value, 0n)
const maximum = (values: ReadonlyArray<bigint>): bigint =>
  values.reduce((largest, value) => (value > largest ? value : largest))

const moneyScale = (series: ReadonlyArray<CompleteSeries>) => {
  const values = series.flatMap(({ sessions }) =>
    sessions.flatMap((session) => [
      ...Object.values(session).filter((value): value is number => typeof value === 'number'),
      ...(session.p95LatencyStress.status === 'COMPLETE' ? [session.p95LatencyStress.netPnlUsd] : []),
    ]),
  )
  const scale = Math.max(
    0,
    ...values.map((value) => BigDecimal.fromNumberUnsafe(value).scale),
    BigDecimal.fromStringUnsafe(protocol.requiredOutcomes.netPnlVsBestMatchedControlAtLeastMultiplier).scale,
  )
  const units = (value: number): bigint => {
    const decimal = BigDecimal.fromNumberUnsafe(value)
    return decimal.value * 10n ** BigInt(scale - decimal.scale)
  }
  const usd = (value: bigint, factor = 1): number =>
    BigDecimal.toNumberUnsafe(BigDecimal.multiply(BigDecimal.make(value, scale), BigDecimal.fromNumberUnsafe(factor)))
  return { units, usd }
}

const percentile = (values: ReadonlyArray<bigint>, probability: number): bigint => {
  const selectedIndex = Math.floor((values.length - 1) * probability)
  return values
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .reduce((selected, value, index) => (index <= selectedIndex ? value : selected))
}

const confidenceBounds = (
  candidate: CompleteSeries,
  controls: ReadonlyArray<CompleteSeries>,
  attemptIndex: number,
  money: ReturnType<typeof moneyScale>,
) => {
  let state = protocol.evaluation.uncertainty.seed >>> 0
  const nextStart = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return Math.floor(((state >>> 0) / 2 ** 32) * candidate.sessions.length)
  }
  const candidatePnl = candidate.sessions.map((session) => money.units(session.netPnlUsd))
  const totals: bigint[] = []
  const comparisons = controls.map((control) => ({
    control,
    pnl: control.sessions.map((session) => money.units(session.netPnlUsd)),
    differences: [] as bigint[],
  }))
  for (let replicate = 0; replicate < protocol.evaluation.uncertainty.replicates; replicate += 1) {
    const weights = new Map<number, number>()
    for (let block = 0; block < candidate.sessions.length / 2; block += 1) {
      const start = nextStart()
      for (const index of [start, (start + 1) % candidate.sessions.length])
        weights.set(index, (weights.get(index) ?? 0) + 1)
    }
    const weightedTotal = (pnl: ReadonlyArray<bigint>): bigint =>
      pnl.reduce((total, value, index) => total + value * BigInt(weights.get(index) ?? 0), 0n)
    const candidateTotal = weightedTotal(candidatePnl)
    totals.push(candidateTotal)
    for (const comparison of comparisons) comparison.differences.push(candidateTotal - weightedTotal(comparison.pnl))
  }
  const comparisonAlpha =
    protocol.evaluation.uncertainty.familywiseAlpha / (attemptIndex * (attemptIndex + 1)) / controls.length
  return {
    netPnlLowerBound: percentile(totals, 0.05),
    comparisonAlpha,
    paired: comparisons.map(({ control, pnl, differences }) => ({
      control: control.policy,
      incrementalNetPnl: sum(candidatePnl) - sum(pnl),
      incrementalNetPnlLowerBound: percentile(differences, comparisonAlpha),
    })),
  }
}

const numericalReport = (candidate: CompleteSeries, controls: ReadonlyArray<CompleteSeries>, attemptIndex: number) => {
  const rows = candidate.sessions
  const money = moneyScale([candidate, ...controls])
  const sessionCount = BigInt(rows.length)
  const netPnl = sum(rows.map((s) => money.units(s.netPnlUsd)))
  const filledNotional = sum(rows.map((s) => money.units(s.filledNotionalUsd)))
  const completedEpisodes = rows.reduce((total, session) => total + session.completedEpisodes, 0)
  const controlNetPnl = controls.map((control) => ({
    policy: control.policy,
    netPnl: sum(control.sessions.map((s) => money.units(s.netPnlUsd))),
  }))
  const bounds = confidenceBounds(candidate, controls, attemptIndex, money)
  let peak = money.units(protocol.riskAcceptance.allocationUsd)
  let maximumDrawdown = 0n
  for (const session of rows) {
    maximumDrawdown = maximum([
      maximumDrawdown,
      peak - money.units(session.minimumEquityUsd),
      money.units(session.maximumDrawdownUsd),
    ])
    peak = maximum([peak, money.units(session.maximumEquityUsd)])
  }
  const maximumSessionLoss = maximum(rows.map((s) => money.units(s.openingEquityUsd) - money.units(s.minimumEquityUsd)))
  const netAfterDroppingBestSession = netPnl - maximum(rows.map((s) => money.units(s.netPnlUsd)))
  const netAfterAdditionalCostBps =
    netPnl * 10_000n - filledNotional * BigInt(protocol.executionEvidence.stress.additionalCostBpsOnEachFilledLeg)
  const p95LatencyStressNetPnl = sum(
    rows.flatMap((s) => (s.p95LatencyStress.status === 'COMPLETE' ? [money.units(s.p95LatencyStress.netPnlUsd)] : [])),
  )
  const multiplier = BigDecimal.fromStringUnsafe(protocol.requiredOutcomes.netPnlVsBestMatchedControlAtLeastMultiplier)
  const checks = {
    frequency:
      completedEpisodes >= protocol.evaluation.minimumCompletedEpisodes &&
      completedEpisodes >= protocol.requiredOutcomes.completedEpisodesPerSessionAtLeast * rows.length,
    volume:
      filledNotional >=
      money.units(protocol.requiredOutcomes.filledBuyPlusSellNotionalPerSessionUsdAtLeast) * sessionCount,
    netProfit: netPnl >= money.units(protocol.requiredOutcomes.netPnlOver20SessionsUsdAtLeast),
    observedControlAdvantage:
      netPnl * 10n ** BigInt(multiplier.scale) >= maximum(controlNetPnl.map((c) => c.netPnl)) * multiplier.value,
    positiveProfitLowerBound:
      bounds.netPnlLowerBound >
      money.units(protocol.evaluation.uncertainty.oneSided95PercentLowerBoundForMeanNetPnlGreaterThan) * sessionCount,
    pairedIncrementalLowerBounds: bounds.paired.every(
      (c) =>
        c.incrementalNetPnlLowerBound >
        money.units(protocol.evaluation.uncertainty.pairedMeanIncrementalNetPnlUsdLowerBoundGreaterThan) * sessionCount,
    ),
    profitWithoutBestSession:
      netAfterDroppingBestSession >
      money.units(protocol.requiredOutcomes.minimumNetAfterDroppingBestSessionUsdExclusive),
    additionalExecutionCost: netAfterAdditionalCostBps > 0n,
    p95BatchLatency: p95LatencyStressNetPnl > 0n,
    drawdown: maximumDrawdown <= money.units(protocol.riskAcceptance.maximumMarkedPeakToTroughDrawdownUsd),
    sessionLoss: maximumSessionLoss <= money.units(protocol.riskAcceptance.maximumSessionLossUsd),
  }
  return {
    verdict: Object.values(checks).every(Boolean) ? JevNumericalVerdict.Passed : JevNumericalVerdict.Missed,
    checks,
    metrics: {
      netPnlUsd: money.usd(netPnl),
      filledNotionalUsd: money.usd(filledNotional),
      completedEpisodes,
      completedEpisodesPerSession: completedEpisodes / rows.length,
      filledNotionalPerSessionUsd: money.usd(filledNotional, 1 / rows.length),
      maximumDrawdownUsd: money.usd(maximumDrawdown),
      maximumSessionLossUsd: money.usd(maximumSessionLoss),
      netAfterDroppingBestSessionUsd: money.usd(netAfterDroppingBestSession),
      netAfterAdditionalCostUsd: money.usd(netAfterAdditionalCostBps, 1 / 10_000),
      p95LatencyStressNetPnlUsd: money.usd(p95LatencyStressNetPnl),
      controlNetPnlUsd: controlNetPnl.map((control) => ({
        policy: control.policy,
        netPnlUsd: money.usd(control.netPnl),
      })),
    },
    confidence: {
      meanNetPnlUsdLowerBound: money.usd(bounds.netPnlLowerBound, 1 / rows.length),
      comparisonAlpha: bounds.comparisonAlpha,
      paired: bounds.paired.map((comparison) => ({
        control: comparison.control,
        meanIncrementalNetPnlUsd: money.usd(comparison.incrementalNetPnl, 1 / rows.length),
        meanIncrementalNetPnlUsdLowerBound: money.usd(comparison.incrementalNetPnlLowerBound, 1 / rows.length),
      })),
    },
  }
}

export const evaluateJevAcceptance = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevAcceptanceInputSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevAcceptanceError({ message: 'Jev acceptance input is malformed', cause })),
    Result.flatMap((data) =>
      Result.gen(function* () {
        const protocolHash = yield* jevAcceptanceProtocolHash()
        const inputHash = yield* canonicalHashV1Result(data)
        const invalid = (message: string) => Result.fail(new JevAcceptanceError({ message }))
        if (data.protocolHash !== protocolHash)
          return yield* invalid('Acceptance protocol hash differs from the frozen version')
        if (Date.parse(data.registration.lockedAt) < Date.parse(protocol.frozenAt))
          return yield* invalid('Candidate registration predates the frozen acceptance protocol')
        if (new Set(data.policies.map((p) => p.policy)).size !== 4)
          return yield* invalid('Acceptance requires the candidate and all three distinct controls')
        let previousClose = data.registration.lockedAt
        let previousDate = ''
        for (const session of data.registration.sessions) {
          if (
            session.openAt <= previousClose ||
            session.closeAt <= session.openAt ||
            session.sessionDate <= previousDate ||
            session.openAt.slice(0, 10) !== session.sessionDate ||
            session.closeAt.slice(0, 10) !== session.sessionDate
          )
            return yield* invalid(
              'Registered sessions must be ordered, nonoverlapping and locked before the first open',
            )
          previousClose = session.closeAt
          previousDate = session.sessionDate
        }
        const series: CompleteSeries[] = []
        const unresolved: { policy: JevResearchPolicy; sessionDate: string; kind: string }[] = []
        for (const policy of data.policies) {
          const complete: (typeof CompleteSession.Type)[] = []
          let previousEquity = protocol.riskAcceptance.allocationUsd
          for (const [index, session] of policy.sessions.entries()) {
            if (session.sessionDate !== data.registration.sessions[index]?.sessionDate)
              return yield* invalid('Policy sessions differ from the registered calendar')
            if (session.status === 'UNRESOLVED') {
              unresolved.push({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'BASE' })
              continue
            }
            if (session.p95LatencyStress.status === 'UNRESOLVED')
              unresolved.push({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'P95_LATENCY' })
            if (session.maximumMarkGapMs > 60_000)
              unresolved.push({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'MARK_COVERAGE' })
            if (
              session.minimumEquityUsd > Math.min(session.openingEquityUsd, session.closingEquityUsd) ||
              session.maximumEquityUsd < Math.max(session.openingEquityUsd, session.closingEquityUsd) ||
              session.maximumDrawdownUsd <
                Math.max(
                  session.openingEquityUsd - session.minimumEquityUsd,
                  session.maximumEquityUsd - session.closingEquityUsd,
                ) -
                  1e-6 ||
              Math.abs(session.closingEquityUsd - session.openingEquityUsd - session.netPnlUsd) > 1e-6
            )
              return yield* invalid('Session equity, marks, drawdown or net profit are inconsistent')
            if (complete.length === index && Math.abs(session.openingEquityUsd - previousEquity) > 1e-6)
              return yield* invalid('Session equity does not continue from the allocation and prior close')
            previousEquity = session.closingEquityUsd
            complete.push(session)
          }
          series.push({ policy: policy.policy, sessions: complete })
        }
        const candidate = series.find((s) => s.policy === JevResearchPolicy.Candidate)
        if (candidate === undefined) return yield* invalid('Candidate results are missing')
        const comparisonAlpha =
          protocol.evaluation.uncertainty.familywiseAlpha /
          (data.registration.attemptIndex * (data.registration.attemptIndex + 1)) /
          3
        if (comparisonAlpha * protocol.evaluation.uncertainty.replicates < 1)
          return yield* invalid(
            'The registered attempt requires more tail resolution than the frozen bootstrap supplies',
          )
        const report = {
          schemaVersion: 'bayn.jev-acceptance-report.v1',
          scope:
            'Numerical targets only. Source receipts, preregistration, execution, costs and deployment require independent verification. This report grants no trading authority.',
          protocolHash,
          inputHash,
          registration: data.registration,
          policyDefinitions: data.policies.map(({ policy, definitionHash }) => ({ policy, definitionHash })),
          ...(unresolved.length > 0
            ? { verdict: JevNumericalVerdict.Inconclusive, unresolved }
            : numericalReport(
                candidate,
                series.filter((s) => s.policy !== JevResearchPolicy.Candidate),
                data.registration.attemptIndex,
              )),
        }
        const reportHash = yield* canonicalHashV1Result(report)
        return { ...report, reportHash }
      }),
    ),
  )
