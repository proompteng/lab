import { BigDecimal, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { decimalToMicrosResult } from '../broker/alpaca/normalizers'
import { JevNumericalVerdict, JevResearchPolicy } from '../jev/acceptance'
import { conditionalConfidence } from './conditional-confidence'
import { SystemAssessmentError } from './economics'
import type { SystemRegistration } from './policy'
import { registeredAllocationMicros } from './policy'
import type { assessSession } from './session'

interface EvaluatedPolicy {
  readonly policy: JevResearchPolicy
  readonly definitionHash: string
  readonly sessions: readonly Result.Result.Success<ReturnType<typeof assessSession>>[]
}
const micros = (usd: number) =>
  decimalToMicrosResult(String(usd), true, 'assessed session amount').pipe(Result.map(BigInt))
const usd = (micros: string | bigint, count = 1) =>
  BigDecimal.toNumberUnsafe(
    BigDecimal.divideUnsafe(BigDecimal.fromBigInt(BigInt(micros)), BigDecimal.fromBigInt(1000000n * BigInt(count))),
  )
const maximum = (...values: readonly bigint[]) => values.reduce((a, b) => (a > b ? a : b))

/** Current qualification uses exact assessed economics and registered conditional bounds, never resampling. */
export const evaluateEconomicQualification = (
  registration: SystemRegistration,
  evaluated: readonly EvaluatedPolicy[],
) =>
  Result.gen(function* () {
    if (registration.schemaVersion !== 'bayn.system-registration.v4')
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Conditional qualification requires its prospective statistical registration',
        }),
      )
    const candidate = evaluated.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    const definition = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined || definition === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing candidate economics' }))
    const commitment = {
      planHash: yield* canonicalHashV1Result(registration),
      lockedAt: registration.registeredAt,
      attemptIndex: registration.attemptIndex,
      sessions: registration.calendar.sessions,
      analysis: {
        allocationUsd: usd(registration.allocationMicros),
        maximumSessionLossUsd: usd(definition.riskPolicy.maxDailyLossMicros),
        maximumDrawdownUsd: usd(definition.riskPolicy.maxDrawdownMicros),
        maximumMarkGapMs: registration.obligations.decisionIntervalMs,
      },
      statisticalPlan: registration.statisticalPlan,
    }
    const unresolved = evaluated.flatMap((policy) =>
      policy.sessions
        .filter(
          (session) =>
            session.numerical.status !== 'COMPLETE' ||
            !session.economicEvidenceComplete ||
            session.netEconomicPnlMicros === null,
        )
        .map((session) => ({ policy: policy.policy, sessionDate: session.sessionDate, kind: 'INCOMPLETE_ECONOMICS' })),
    )
    if (unresolved.length > 0)
      return {
        schemaVersion: 'bayn.economic-qualification.v1' as const,
        registration: commitment,
        verdict: JevNumericalVerdict.Inconclusive,
        unresolved,
      }
    const series = []
    let filledNotional = 0n,
      completedEpisodes = 0,
      stressProfit: bigint | null = 0n
    let bestSession: bigint | undefined
    let maximumSessionLoss = 0n,
      maximumDrawdown = 0n,
      peak = BigInt(registeredAllocationMicros(registration)),
      total = 0n
    for (const policy of evaluated) {
      if (policy.sessions.length !== registration.calendar.sessions.length)
        return yield* Result.fail(new SystemAssessmentError({ message: 'Economic series omits registered sessions' }))
      const netProfitMicros = []
      let prior = BigInt(registration.allocationMicros)
      for (const [index, session] of policy.sessions.entries()) {
        if (
          session.sessionDate !== registration.calendar.sessions[index]?.sessionDate ||
          session.numerical.status !== 'COMPLETE' ||
          session.netEconomicPnlMicros === null
        )
          return yield* Result.fail(
            new SystemAssessmentError({ message: 'Economic series substitutes or omits registered evidence' }),
          )
        const row = session.numerical
        const opening = yield* micros(row.openingEquityUsd),
          closing = yield* micros(row.closingEquityUsd)
        const minimum = yield* micros(row.minimumEquityUsd),
          high = yield* micros(row.maximumEquityUsd),
          drawdown = yield* micros(row.maximumDrawdownUsd)
        const profit = BigInt(session.netEconomicPnlMicros)
        if (
          opening !== prior ||
          closing - opening !== profit ||
          minimum > opening ||
          minimum > closing ||
          high < opening ||
          high < closing ||
          drawdown < maximum(opening - minimum, high - closing)
        )
          return yield* Result.fail(
            new SystemAssessmentError({ message: 'Cost-inclusive equity and actual profit do not reconcile' }),
          )
        prior = closing
        netProfitMicros.push(session.netEconomicPnlMicros)
        if (policy.policy === JevResearchPolicy.Candidate) {
          filledNotional += yield* micros(row.filledNotionalUsd)
          completedEpisodes += row.completedEpisodes
          bestSession = bestSession === undefined ? profit : maximum(bestSession, profit)
          stressProfit =
            row.p95LatencyStress.status === 'COMPLETE' && stressProfit !== null
              ? stressProfit + (yield* micros(row.p95LatencyStress.netPnlUsd))
              : null
          maximumSessionLoss = maximum(maximumSessionLoss, opening - minimum)
          maximumDrawdown = maximum(maximumDrawdown, peak - minimum, drawdown)
          peak = maximum(peak, high)
          total += profit
        }
      }
      series.push({ policy: policy.policy, netProfitMicros })
    }
    const candidateSeries = series.find((row) => row.policy === candidate.policy)
    if (candidateSeries === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing candidate statistical identity' }))
    const confidence = yield* conditionalConfidence(
      registration.statisticalPlan,
      candidateSeries,
      series.filter((row) => row !== candidateSeries),
      registration.attemptIndex,
    )
    const checks = {
      netProfit: total > 0n,
      positiveProfitLowerBound: BigInt(confidence.profit.lowerSumMicros) > 0n,
      pairedIncrementalLowerBounds: confidence.paired.every((bound) => BigInt(bound.lowerSumMicros) > 0n),
      drawdown: maximumDrawdown <= BigInt(definition.riskPolicy.maxDrawdownMicros),
      sessionLoss: maximumSessionLoss <= BigInt(definition.riskPolicy.maxDailyLossMicros),
    }
    const count = candidate.sessions.length
    if (bestSession === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing candidate sessions' }))
    return {
      schemaVersion: 'bayn.economic-qualification.v1' as const,
      registration: commitment,
      policyDefinitions: evaluated.map(({ policy, definitionHash }) => ({ policy, definitionHash })),
      scope:
        'Conditional PAPER evidence over the complete fixed calendar. It grants no capital authority or guarantee of future profit.',
      verdict: Object.values(checks).every(Boolean) ? JevNumericalVerdict.Passed : JevNumericalVerdict.Missed,
      checks,
      metrics: {
        netPnlUsd: usd(total),
        filledNotionalUsd: usd(filledNotional),
        completedEpisodes,
        completedEpisodesPerSession: completedEpisodes / count,
        filledNotionalPerSessionUsd: usd(filledNotional, count),
        netAfterDroppingBestSessionUsd: usd(total - bestSession),
        netAfterAdditionalCostUsd: usd(total * 10000n - filledNotional * 10n, 10000),
        maximumSessionLossUsd: usd(maximumSessionLoss),
        maximumDrawdownUsd: usd(maximumDrawdown),
        p95LatencyStressNetPnlUsd: stressProfit === null ? null : usd(stressProfit),
        controlNetPnlUsd: series
          .filter((row) => row !== candidateSeries)
          .map((row) => ({
            policy: row.policy,
            netPnlUsd: usd(row.netProfitMicros.reduce((sum, value) => sum + BigInt(value), 0n)),
          })),
      },
      confidence,
    }
  })
