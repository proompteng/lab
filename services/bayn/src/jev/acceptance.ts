import { BigDecimal, Data, Result, Schema } from 'effect'
import retainedProtocol from '../../../../docs/bayn/jev-migration-acceptance-v2.json'
import { retainedRegisteredWindowPolicy } from './retained-acceptance-policy'
import {
  NumericalAssessmentTermsSchema,
  validateBootstrapPlan,
  type NumericalAssessmentTerms,
  type BootstrapPlan,
} from './bootstrap-plan'

import { decimalToMicrosResult } from '../broker/alpaca/normalizers'
import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const protocol = {
  schemaVersion: 'bayn.jev-acceptance-policy.v4',
  programStartedAt: '2026-09-21T08:31:54Z',
  evaluation: {
    window: 'PROSPECTIVE_NONEMPTY_REGISTERED_CALENDAR',
    uncertainty: 'REGISTERED_PAIRED_CIRCULAR_BLOCK_BOOTSTRAP',
    familywiseAlpha: 0.05,
    attemptCorrection: 'ALPHA_OVER_ATTEMPT_TIMES_NEXT_ATTEMPT_AND_REGISTERED_CLAIM_COUNT',
    resolution: 'REGISTER_ADEQUATE_BOUNDED_WORK_BUDGET_BEFORE_FIRST_OPEN',
    claims: ['MEAN_NET_PROFIT', 'EACH_REGISTERED_PAIRED_NET_EDGE'],
  },
  requiredOutcomes: {
    positiveFullyCostedNetProfit: true,
    positiveProfitLowerBound: true,
    positivePairedNetEdgeLowerBounds: true,
    registeredRiskLimits: true,
  },
  diagnostics: [
    'ACTIVITY',
    'TURNOVER',
    'CONTROL_PROFIT_RATIO',
    'DROP_BEST_SESSION',
    'ADDITIONAL_10_BPS',
    'P95_LATENCY',
    'TARIFF_PREMIUM',
  ],
}

export enum JevAcceptanceVersion {
  Current = 'RESEARCH_EVIDENCE_V5',
  RetainedV4 = 'ECONOMIC_EVIDENCE_V4',
  RetainedV3 = 'REGISTERED_WINDOW_V3',
  RetainedV2 = 'RETAINED_V2',
}

export const usesLegacyAcceptance = (version: JevAcceptanceVersion) =>
  version === JevAcceptanceVersion.RetainedV2 || version === JevAcceptanceVersion.RetainedV3

const protocolFor = (version: JevAcceptanceVersion) =>
  version === JevAcceptanceVersion.RetainedV3
    ? retainedRegisteredWindowPolicy
    : {
        ...retainedProtocol,
        programStartedAt: retainedProtocol.frozenAt,
        requiredOutcomes: {
          ...retainedProtocol.requiredOutcomes,
          netPnlUsdAtLeast: retainedProtocol.requiredOutcomes.netPnlOver20SessionsUsdAtLeast,
        },
      }

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
    analysis: Schema.optionalKey(NumericalAssessmentTermsSchema),
    sessions: Schema.Array(
      Schema.Struct({ sessionDate: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema }),
    ).check(Schema.isMinLength(1)),
  }),
  policies: Schema.Array(
    Schema.Struct({
      policy: Schema.Enum(JevResearchPolicy),
      definitionHash: Sha256Schema,
      sessions: Schema.Array(Session).check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
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

export const jevAcceptanceProtocolHash = (version = JevAcceptanceVersion.Current) =>
  canonicalHashV1Result(
    !usesLegacyAcceptance(version)
      ? protocol
      : version === JevAcceptanceVersion.RetainedV3
        ? retainedRegisteredWindowPolicy
        : retainedProtocol,
  )

export const jevAcceptanceExecutionRiskLimits = (version = JevAcceptanceVersion.Current) => {
  const limits = protocolFor(version).riskAcceptance
  return {
    maxOrderNotionalMicros: BigInt(limits.existingMaximumOrderAndSymbolNotionalUsd) * 1_000_000n,
    maxSymbolExposureMicros: BigInt(limits.existingMaximumOrderAndSymbolNotionalUsd) * 1_000_000n,
    maxGrossExposureMicros: BigInt(limits.existingMaximumGrossAndNetExposureUsd) * 1_000_000n,
    maxNetExposureMicros: BigInt(limits.existingMaximumGrossAndNetExposureUsd) * 1_000_000n,
    maxDailyTradedNotionalMicros: BigInt(limits.existingMaximumDailyTradedNotionalUsd) * 1_000_000n,
  }
}

export const jevAcceptanceInferenceRateFloor = (version = JevAcceptanceVersion.Current) => {
  const protocol = protocolFor(version)
  return Result.all({
    inputMicrosPerMillionTokens: decimalToMicrosResult(
      protocol.executionEvidence.modelCost.usdPerMillionInputTokens,
      false,
      'frozen Jev input tariff',
    ),
    outputMicrosPerMillionTokens: decimalToMicrosResult(
      protocol.executionEvidence.modelCost.usdPerMillionOutputTokens,
      false,
      'frozen Jev output tariff',
    ),
  }).pipe(Result.mapError((cause) => new JevAcceptanceError({ message: 'Invalid frozen inference tariff', cause })))
}

const sum = (values: ReadonlyArray<bigint>): bigint => values.reduce((total, value) => total + value, 0n)
const maximum = (values: ReadonlyArray<bigint>): bigint =>
  values.reduce((largest, value) => (value > largest ? value : largest))

const moneyScale = (
  series: ReadonlyArray<CompleteSeries>,
  protocol: ReturnType<typeof protocolFor>,
  terms: NumericalAssessmentTerms,
) => {
  const values = series.flatMap(({ sessions }) =>
    sessions.flatMap((session) => [
      ...Object.values(session).filter((value): value is number => typeof value === 'number'),
      ...(session.p95LatencyStress.status === 'COMPLETE' ? [session.p95LatencyStress.netPnlUsd] : []),
    ]),
  )
  const scale = Math.max(
    0,
    ...[...values, terms.allocationUsd, terms.maximumSessionLossUsd, terms.maximumDrawdownUsd].map(
      (value) => BigDecimal.fromNumberUnsafe(value).scale,
    ),
    BigDecimal.fromStringUnsafe(protocol.requiredOutcomes.netPnlVsBestMatchedControlAtLeastMultiplier).scale,
  )
  const units = (value: number): bigint => {
    const decimal = BigDecimal.fromNumberUnsafe(value)
    return decimal.value * 10n ** BigInt(scale - decimal.scale)
  }
  const usd = (value: bigint, divisor = 1): number => {
    if (divisor === 1) return BigDecimal.toNumberUnsafe(BigDecimal.make(value, scale))
    // Binary64's smallest midpoint is 2^-1075. Retain the input scale and divisor digits before the sole Number rounding.
    const precision = 1075 + String(divisor).length
    const quotient = (value * 10n ** BigInt(precision)) / BigInt(divisor)
    return BigDecimal.toNumberUnsafe(BigDecimal.make(quotient, scale + precision))
  }
  return { units, usd }
}

const percentile = (values: ReadonlyArray<bigint>, probability: number, denominator?: bigint): bigint => {
  const selectedIndex =
    denominator === undefined
      ? Math.floor((values.length - 1) * probability)
      : Number((BigInt(values.length) - 1n) / denominator)
  return values
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .reduce((selected, value, index) => (index <= selectedIndex ? value : selected))
}

const confidenceBounds = (
  candidate: CompleteSeries,
  controls: ReadonlyArray<CompleteSeries>,
  attemptIndex: number,
  money: ReturnType<typeof moneyScale>,
  plan: BootstrapPlan,
  legacy: boolean,
) => {
  let state = plan.seed >>> 0
  const nextStart = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return Number((BigInt(state >>> 0) * BigInt(candidate.sessions.length)) / 4294967296n)
  }
  const candidatePnl = candidate.sessions.map((session) => money.units(session.netPnlUsd))
  const totals: bigint[] = []
  const comparisons = controls.map((control) => ({
    control,
    pnl: control.sessions.map((session) => money.units(session.netPnlUsd)),
    differences: [] as bigint[],
  }))
  for (let replicate = 0; replicate < plan.replicates; replicate += 1) {
    const weights = new Map<number, number>()
    let sampled = 0
    while (sampled < candidate.sessions.length) {
      const start = nextStart()
      for (let offset = 0; offset < plan.blockLengthSessions; offset += 1) {
        const index = (start + offset) % candidate.sessions.length
        if (sampled === candidate.sessions.length) break
        weights.set(index, (weights.get(index) ?? 0) + 1)
        sampled += 1
      }
    }
    const weightedTotal = (pnl: ReadonlyArray<bigint>): bigint =>
      pnl.reduce((total, value, index) => total + value * BigInt(weights.get(index) ?? 0), 0n)
    const candidateTotal = weightedTotal(candidatePnl)
    totals.push(candidateTotal)
    for (const comparison of comparisons) comparison.differences.push(candidateTotal - weightedTotal(comparison.pnl))
  }
  const comparisonAlpha = 0.05 / (attemptIndex * (attemptIndex + 1)) / (legacy ? controls.length : controls.length + 1)
  return {
    netPnlLowerBound: percentile(
      totals,
      legacy ? 0.05 : comparisonAlpha,
      legacy ? undefined : 20n * BigInt(controls.length + 1) * BigInt(attemptIndex) * BigInt(attemptIndex + 1),
    ),
    comparisonAlpha,
    paired: comparisons.map(({ control, pnl, differences }) => ({
      control: control.policy,
      incrementalNetPnl: sum(candidatePnl) - sum(pnl),
      incrementalNetPnlLowerBound: percentile(
        differences,
        comparisonAlpha,
        legacy ? undefined : 20n * BigInt(controls.length + 1) * BigInt(attemptIndex) * BigInt(attemptIndex + 1),
      ),
    })),
  }
}

const numericalReport = (
  candidate: CompleteSeries,
  controls: ReadonlyArray<CompleteSeries>,
  attemptIndex: number,
  version: JevAcceptanceVersion,
  terms: NumericalAssessmentTerms,
) => {
  const protocol = protocolFor(version)
  const legacy = usesLegacyAcceptance(version)
  const rows = candidate.sessions
  const money = moneyScale([candidate, ...controls], protocol, terms)
  const sessionCount = BigInt(rows.length)
  const netPnl = sum(rows.map((s) => money.units(s.netPnlUsd)))
  const filledNotional = sum(rows.map((s) => money.units(s.filledNotionalUsd)))
  const completedEpisodes = rows.reduce((total, session) => total + session.completedEpisodes, 0)
  const controlNetPnl = controls.map((control) => ({
    policy: control.policy,
    netPnl: sum(control.sessions.map((s) => money.units(s.netPnlUsd))),
  }))
  const bounds = confidenceBounds(candidate, controls, attemptIndex, money, terms.bootstrap, legacy)
  let peak = money.units(terms.allocationUsd)
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
  const checks = legacy
    ? {
        frequency:
          completedEpisodes >= protocol.evaluation.minimumCompletedEpisodes &&
          completedEpisodes >= protocol.requiredOutcomes.completedEpisodesPerSessionAtLeast * rows.length,
        volume:
          filledNotional >=
          money.units(protocol.requiredOutcomes.filledBuyPlusSellNotionalPerSessionUsdAtLeast) * sessionCount,
        netProfit: netPnl >= money.units(protocol.requiredOutcomes.netPnlUsdAtLeast),
        observedControlAdvantage:
          netPnl * 10n ** BigInt(multiplier.scale) >= maximum(controlNetPnl.map((c) => c.netPnl)) * multiplier.value,
        positiveProfitLowerBound:
          bounds.netPnlLowerBound >
          money.units(protocol.evaluation.uncertainty.oneSided95PercentLowerBoundForMeanNetPnlGreaterThan) *
            sessionCount,
        pairedIncrementalLowerBounds: bounds.paired.every(
          (c) =>
            c.incrementalNetPnlLowerBound >
            money.units(protocol.evaluation.uncertainty.pairedMeanIncrementalNetPnlUsdLowerBoundGreaterThan) *
              sessionCount,
        ),
        profitWithoutBestSession:
          netAfterDroppingBestSession >
          money.units(protocol.requiredOutcomes.minimumNetAfterDroppingBestSessionUsdExclusive),
        additionalExecutionCost: netAfterAdditionalCostBps > 0n,
        p95BatchLatency: p95LatencyStressNetPnl > 0n,
        drawdown: maximumDrawdown <= money.units(protocol.riskAcceptance.maximumMarkedPeakToTroughDrawdownUsd),
        sessionLoss: maximumSessionLoss <= money.units(protocol.riskAcceptance.maximumSessionLossUsd),
      }
    : {
        netProfit: netPnl > 0n,
        positiveProfitLowerBound: bounds.netPnlLowerBound > 0n,
        pairedIncrementalLowerBounds: bounds.paired.every((c) => c.incrementalNetPnlLowerBound > 0n),
        drawdown: maximumDrawdown <= money.units(terms.maximumDrawdownUsd),
        sessionLoss: maximumSessionLoss <= money.units(terms.maximumSessionLossUsd),
      }
  return {
    verdict: Object.values(checks).every(Boolean) ? JevNumericalVerdict.Passed : JevNumericalVerdict.Missed,
    checks,
    metrics: {
      netPnlUsd: money.usd(netPnl),
      filledNotionalUsd: money.usd(filledNotional),
      completedEpisodes,
      completedEpisodesPerSession: completedEpisodes / rows.length,
      filledNotionalPerSessionUsd: money.usd(filledNotional, rows.length),
      maximumDrawdownUsd: money.usd(maximumDrawdown),
      maximumSessionLossUsd: money.usd(maximumSessionLoss),
      netAfterDroppingBestSessionUsd: money.usd(netAfterDroppingBestSession),
      netAfterAdditionalCostUsd: money.usd(netAfterAdditionalCostBps, 10_000),
      p95LatencyStressNetPnlUsd:
        !legacy && rows.some((session) => session.p95LatencyStress.status !== 'COMPLETE')
          ? null
          : money.usd(p95LatencyStressNetPnl),
      controlNetPnlUsd: controlNetPnl.map((control) => ({
        policy: control.policy,
        netPnlUsd: money.usd(control.netPnl),
      })),
    },
    confidence: {
      meanNetPnlUsdLowerBound: money.usd(bounds.netPnlLowerBound, rows.length),
      comparisonAlpha: bounds.comparisonAlpha,
      ...(legacy ? {} : { profitAlpha: bounds.comparisonAlpha }),
      paired: bounds.paired.map((comparison) => ({
        control: comparison.control,
        meanIncrementalNetPnlUsd: money.usd(comparison.incrementalNetPnl, rows.length),
        meanIncrementalNetPnlUsdLowerBound: money.usd(comparison.incrementalNetPnlLowerBound, rows.length),
      })),
    },
  }
}

export const evaluateJevAcceptance = (input: unknown, version = JevAcceptanceVersion.Current) =>
  Schema.decodeUnknownResult(
    JevAcceptanceInputSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevAcceptanceError({ message: 'Jev acceptance input is malformed', cause })),
    Result.flatMap((data) =>
      Result.gen(function* () {
        const protocol = protocolFor(version)
        const legacy = usesLegacyAcceptance(version)
        const protocolHash = yield* jevAcceptanceProtocolHash(version)
        if (
          version === JevAcceptanceVersion.RetainedV2 &&
          data.registration.sessions.length !== retainedProtocol.evaluation.consecutiveSessions
        )
          return yield* Result.fail(
            new JevAcceptanceError({ message: 'Retained v2 evidence must retain its original calendar length' }),
          )
        const inputHash = yield* canonicalHashV1Result(data)
        const invalid = (message: string) => Result.fail(new JevAcceptanceError({ message }))
        if (data.protocolHash !== protocolHash)
          return yield* invalid('Acceptance protocol hash differs from the active policy')
        if (Date.parse(data.registration.lockedAt) < Date.parse(protocol.programStartedAt))
          return yield* invalid('Candidate registration predates the evaluation program')
        if (
          new Set(data.policies.map((p) => p.policy)).size !== data.policies.length ||
          (legacy && data.policies.length !== 4)
        )
          return yield* invalid(
            legacy
              ? 'Acceptance requires the candidate and all three distinct controls'
              : 'Acceptance requires distinct selected policies',
          )
        const analysis = data.registration.analysis
        if (!legacy && analysis === undefined)
          return yield* invalid('Current evaluation requires prospectively registered analysis terms')
        const terms: NumericalAssessmentTerms = analysis ?? {
          allocationUsd: protocol.riskAcceptance.allocationUsd,
          maximumSessionLossUsd: protocol.riskAcceptance.maximumSessionLossUsd,
          maximumDrawdownUsd: protocol.riskAcceptance.maximumMarkedPeakToTroughDrawdownUsd,
          maximumMarkGapMs: 60_000,
          bootstrap: { blockLengthSessions: 2, replicates: 10000, seed: 20260921 },
        }
        if (!legacy) {
          const plan = validateBootstrapPlan(
            terms.bootstrap,
            data.registration.sessions.length,
            data.registration.attemptIndex,
            data.policies.length - 1,
          )
          if (Result.isFailure(plan)) return yield* invalid(plan.failure)
        }
        let previousClose = data.registration.lockedAt
        let previousDate = ''
        for (const session of data.registration.sessions) {
          if (
            session.openAt <= previousClose ||
            session.closeAt <= session.openAt ||
            session.sessionDate <= previousDate ||
            session.openAt.slice(0, 10) !== session.sessionDate ||
            (legacy && session.closeAt.slice(0, 10) !== session.sessionDate)
          )
            return yield* invalid(
              'Registered sessions must be ordered, nonoverlapping and locked before the first open',
            )
          previousClose = session.closeAt
          previousDate = session.sessionDate
        }
        const series: CompleteSeries[] = []
        const unresolved: { policy: JevResearchPolicy; sessionDate: string; kind: string }[] = []
        if (!legacy && data.registration.sessions.length <= terms.bootstrap.blockLengthSessions)
          unresolved.push({
            policy: JevResearchPolicy.Candidate,
            sessionDate: data.registration.sessions[0]?.sessionDate ?? '',
            kind: 'INSUFFICIENT_INDEPENDENT_BLOCKS',
          })
        for (const policy of data.policies) {
          if (policy.sessions.length !== data.registration.sessions.length)
            return yield* invalid('Policy sessions do not cover the complete registered calendar')
          const complete: (typeof CompleteSession.Type)[] = []
          let previousEquity = terms.allocationUsd
          for (const [index, session] of policy.sessions.entries()) {
            if (session.sessionDate !== data.registration.sessions[index]?.sessionDate)
              return yield* invalid('Policy sessions differ from the registered calendar')
            if (session.status === 'UNRESOLVED') {
              unresolved.push({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'BASE' })
              continue
            }
            if (legacy && session.p95LatencyStress.status === 'UNRESOLVED')
              unresolved.push({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'P95_LATENCY' })
            if (session.maximumMarkGapMs > terms.maximumMarkGapMs)
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
        if (legacy && comparisonAlpha * protocol.evaluation.uncertainty.replicates < 1)
          return yield* invalid(
            'The registered attempt requires more tail resolution than the frozen bootstrap supplies',
          )
        const report = {
          schemaVersion: 'bayn.jev-acceptance-report.v1',
          scope:
            'Numerical targets only. Source receipts, preregistration, execution, costs and deployment require independent verification. This report grants no trading authority.',
          ...(version === JevAcceptanceVersion.Current
            ? { statisticalEvidence: { status: 'RESEARCH_ONLY', reason: 'STATISTICAL_COVERAGE_NOT_ESTABLISHED' } }
            : {}),
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
                version,
                terms,
              )),
        }
        const reportHash = yield* canonicalHashV1Result(report)
        return { ...report, reportHash }
      }),
    ),
  )
