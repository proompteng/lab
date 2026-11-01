import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { evaluateJevAcceptance, JevNumericalVerdict, JevResearchPolicy } from './acceptance'
import { bootstrapResolutionSupported, validateBootstrapPlan } from './bootstrap-plan'
import { registrationFixture } from '../system-assessment/fixtures.test-support'
import { registeredAssessmentTerms } from '../system-assessment/policy'

const inputFixture = () => {
  const registration = registrationFixture(undefined, 4)
  const definition = registration.policies[0]!
  return {
    schemaVersion: 'bayn.jev-acceptance-input.v1',
    protocolHash: registration.acceptanceProtocolHash,
    registration: {
      planHash: 'a'.repeat(64),
      lockedAt: registration.registeredAt,
      attemptIndex: 1,
      sessions: registration.calendar.sessions,
      analysis: registeredAssessmentTerms(registration, definition.riskPolicy),
    },
    policies: registration.policies.map(({ policy }) => {
      let equity = 100_000
      return {
        policy,
        definitionHash: 'b'.repeat(64),
        sessions: registration.calendar.sessions.map((session) => {
          const opening = equity
          const pnl = policy === JevResearchPolicy.Candidate ? 1 : 0.9
          equity += pnl
          return {
            status: 'COMPLETE',
            sessionDate: session.sessionDate,
            evidenceHash: 'c'.repeat(64),
            completedEpisodes: 1,
            filledNotionalUsd: 1000,
            netPnlUsd: pnl,
            openingEquityUsd: opening,
            closingEquityUsd: equity,
            minimumEquityUsd: opening,
            maximumEquityUsd: equity,
            maximumDrawdownUsd: 0,
            maximumMarkGapMs: 60_000,
            p95LatencyStress: { status: 'UNRESOLVED', evidenceHash: 'd'.repeat(64) },
          }
        }),
      }
    }),
  }
}

describe('fully costed economic qualification', () => {
  test('a negative-expectancy process can pass bootstrap diagnostics without a coverage certificate', () => {
    const base = inputFixture()
    for (const payoffs of [
      [1, 1],
      [1, -3],
      [-3, 1],
      [-3, -3],
    ]) {
      const input = {
        ...base,
        registration: {
          ...base.registration,
          sessions: base.registration.sessions.slice(0, 2),
          analysis: {
            ...base.registration.analysis,
            bootstrap: { blockLengthSessions: 1, replicates: 80, seed: 20260921 },
          },
        },
        policies: base.policies.slice(0, 2).map((policy) => {
          let equity = 100000
          return {
            ...policy,
            sessions: policy.sessions.slice(0, 2).map((session, index) => {
              const pnl = policy.policy === JevResearchPolicy.Candidate ? (payoffs[index] ?? 0) : -1
              const opening = equity
              equity += pnl
              return {
                ...session,
                netPnlUsd: pnl,
                openingEquityUsd: opening,
                closingEquityUsd: equity,
                minimumEquityUsd: Math.min(opening, equity),
                maximumEquityUsd: Math.max(opening, equity),
                maximumDrawdownUsd: Math.max(0, -pnl),
              }
            }),
          }
        }),
      }
      const report = Result.getOrThrow(evaluateJevAcceptance(input))
      expect(report.statisticalEvidence?.status).toBe('RESEARCH_ONLY')
      expect(report.verdict).toBe(payoffs.every((p) => p > 0) ? JevNumericalVerdict.Passed : JevNumericalVerdict.Missed)
      if (!('confidence' in report)) throw new Error('Expected numerical diagnostics')
      expect(report.confidence.meanNetPnlUsdLowerBound).toBe(payoffs.every((p) => p > 0) ? 1 : -3)
    }
    expect((1 + -3) / 2).toBe(-1)
    expect(0.5 * 0.5).toBe(0.25)
  })
  test('low activity, low turnover, small positive net edge and a failed cost stress are not rejected research targets', () => {
    const result = Result.getOrThrow(evaluateJevAcceptance(inputFixture()))
    expect(result.verdict).toBe(JevNumericalVerdict.Passed)
    if (!('metrics' in result)) throw new Error('Missing complete economic metrics')
    expect(result.metrics.completedEpisodes).toBe(4)
    expect(result.metrics.netPnlUsd).toBe(4)
    expect(result.metrics.netAfterAdditionalCostUsd).toBe(0)
    expect(result.metrics.p95LatencyStressNetPnlUsd).toBeNull()
    expect(Object.keys(result.checks).sort()).toEqual([
      'drawdown',
      'netProfit',
      'pairedIncrementalLowerBounds',
      'positiveProfitLowerBound',
      'sessionLoss',
    ])
  })

  test('one prospectively selected control is sufficient', () => {
    const input = inputFixture()
    const result = Result.getOrThrow(evaluateJevAcceptance({ ...input, policies: input.policies.slice(0, 2) }))
    expect(result.verdict).toBe(JevNumericalVerdict.Passed)
    if (!('confidence' in result)) throw new Error('Missing confidence')
    expect(result.confidence.paired).toHaveLength(1)
  })

  test('attempt 13 can reserve adequate resolution without resetting attempt history', () => {
    const input = inputFixture()
    const registration = {
      ...input.registration,
      attemptIndex: 13,
      analysis: {
        ...input.registration.analysis,
        bootstrap: { ...input.registration.analysis.bootstrap, replicates: 20_000 },
      },
    }
    expect(Result.getOrThrow(evaluateJevAcceptance({ ...input, registration })).verdict).toBe(
      JevNumericalVerdict.Passed,
    )
    expect(bootstrapResolutionSupported(10_000, 13, 3)).toBe(false)
    expect(bootstrapResolutionSupported(20_000, 13, 3)).toBe(true)
    expect(
      Result.isSuccess(
        validateBootstrapPlan({ blockLengthSessions: 2, replicates: 80_000_080_000_000, seed: 1 }, 20, 1_000_000, 3),
      ),
    ).toBe(true)
  })

  test('missing evidence and an uninformative whole-window block cannot establish edge', () => {
    const input = inputFixture()
    const missing = {
      ...input,
      policies: input.policies.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) => ({
          status: 'UNRESOLVED',
          sessionDate: s.sessionDate,
          evidenceHash: s.evidenceHash,
        })),
      })),
    }
    expect(Result.getOrThrow(evaluateJevAcceptance(missing)).verdict).toBe(JevNumericalVerdict.Inconclusive)
    const uninformative = {
      ...input,
      registration: {
        ...input.registration,
        analysis: {
          ...input.registration.analysis,
          bootstrap: { ...input.registration.analysis.bootstrap, blockLengthSessions: 4 },
        },
      },
    }
    expect(Result.getOrThrow(evaluateJevAcceptance(uninformative)).verdict).toBe(JevNumericalVerdict.Inconclusive)
  })

  test('fractional-dollar registered risk limits retain exact comparison precision', () => {
    const input = inputFixture()
    const result = Result.getOrThrow(
      evaluateJevAcceptance({
        ...input,
        registration: {
          ...input.registration,
          analysis: { ...input.registration.analysis, maximumSessionLossUsd: 0.000001, maximumDrawdownUsd: 0.000001 },
        },
      }),
    )
    expect(result.verdict).toBe(JevNumericalVerdict.Passed)
  })

  test('source-bound loss limits remain mandatory', () => {
    const input = inputFixture()
    const policies = input.policies.map((p) =>
      p.policy !== JevResearchPolicy.Candidate
        ? p
        : {
            ...p,
            sessions: p.sessions.map((s, i) =>
              i !== 0 ? s : { ...s, minimumEquityUsd: s.openingEquityUsd - 6000, maximumDrawdownUsd: 6001 },
            ),
          },
    )
    const result = Result.getOrThrow(evaluateJevAcceptance({ ...input, policies }))
    expect(result.verdict).toBe(JevNumericalVerdict.Missed)
    if (!('checks' in result)) throw new Error('Missing risk checks')
    expect(result.checks.sessionLoss).toBe(false)
  })
})
