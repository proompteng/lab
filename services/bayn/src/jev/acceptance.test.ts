import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  evaluateJevAcceptance,
  jevAcceptanceProtocolHash,
  JevNumericalVerdict,
  JevResearchPolicy,
  type JevAcceptanceInput,
} from './acceptance'

const dates = [
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
  '2026-10-12',
  '2026-10-13',
  '2026-10-14',
  '2026-10-15',
  '2026-10-16',
] as const

const inputFixture = (
  candidatePnl: (index: number) => number = () => 300,
  controlPnl: (index: number) => number = () => 100,
): JevAcceptanceInput => ({
  schemaVersion: 'bayn.jev-acceptance-input.v1',
  protocolHash: Result.getOrThrow(jevAcceptanceProtocolHash()),
  registration: {
    planHash: 'a'.repeat(64),
    lockedAt: '2026-09-21T09:00:00.000Z',
    attemptIndex: 1,
    sessions: dates.map((sessionDate) => ({
      sessionDate,
      openAt: `${sessionDate}T13:30:00.000Z`,
      closeAt: `${sessionDate}T20:00:00.000Z`,
    })),
  },
  policies: Object.values(JevResearchPolicy).map((policy, policyIndex) => {
    let equity = 100_000
    return {
      policy,
      definitionHash: String(policyIndex + 1).repeat(64),
      sessions: dates.map((sessionDate, index) => {
        const openingEquityUsd = equity
        const netPnlUsd = policy === JevResearchPolicy.Candidate ? candidatePnl(index) : controlPnl(index)
        equity += netPnlUsd
        return {
          status: 'COMPLETE',
          sessionDate,
          evidenceHash: 'e'.repeat(64),
          completedEpisodes: 10,
          filledNotionalUsd: 100_000,
          netPnlUsd,
          openingEquityUsd,
          closingEquityUsd: equity,
          minimumEquityUsd: Math.min(openingEquityUsd, equity),
          maximumEquityUsd: Math.max(openingEquityUsd, equity),
          maximumDrawdownUsd: Math.max(0, -netPnlUsd),
          maximumMarkGapMs: 60_000,
          p95LatencyStress: { status: 'COMPLETE', netPnlUsd: netPnlUsd - 20, evidenceHash: 'f'.repeat(64) },
        }
      }),
    }
  }),
})

const changeCandidate = (
  input: JevAcceptanceInput,
  change: (session: JevAcceptanceInput['policies'][number]['sessions'][number]) => unknown,
) => ({
  ...input,
  policies: input.policies.map((policy) =>
    policy.policy === JevResearchPolicy.Candidate ? { ...policy, sessions: policy.sessions.map(change) } : policy,
  ),
})

describe('Jev frozen numerical acceptance', () => {
  test('requires all numerical outcomes and retains reproducible identity without granting authority', () => {
    const input = inputFixture()
    const report = Result.getOrThrow(evaluateJevAcceptance(input))
    expect(report.verdict).toBe(JevNumericalVerdict.Passed)
    if ('metrics' in report) {
      expect(report.metrics.netPnlUsd).toBe(6000)
      expect(report.metrics.completedEpisodes).toBe(200)
      expect(report.metrics.filledNotionalUsd).toBe(2_000_000)
      expect(report.confidence.paired.every((c) => c.meanIncrementalNetPnlUsdLowerBound === 200)).toBe(true)
    }
    expect(report.scope).toContain('grants no trading authority')
    expect(Result.getOrThrow(evaluateJevAcceptance(input))).toEqual(report)
  })

  test('rejects the oracle counterexample that passes absolute profitability and the observed 1.25 multiplier', () => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(
        inputFixture(
          () => 300,
          (index) => (Math.floor(index / 5) % 2 === 0 ? 900 : -420),
        ),
      ),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Missed)
    if ('checks' in report) {
      expect(report.checks.netProfit).toBe(true)
      expect(report.checks.observedControlAdvantage).toBe(true)
      expect(report.checks.positiveProfitLowerBound).toBe(true)
      expect(report.checks.pairedIncrementalLowerBounds).toBe(false)
      expect(report.confidence.paired.every((c) => c.meanIncrementalNetPnlUsdLowerBound < 0)).toBe(true)
    }
  })

  test.each([
    ['frequency', { completedEpisodes: 9 }],
    ['volume', { filledNotionalUsd: 99_999 }],
    ['additionalExecutionCost', { filledNotionalUsd: 300_000 }],
    ['p95BatchLatency', { p95LatencyStress: { status: 'COMPLETE', netPnlUsd: -1, evidenceHash: 'f'.repeat(64) } }],
  ] as const)('misses the %s target even when the ordinary net result is positive', (check, change) => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(changeCandidate(inputFixture(), (session) => ({ ...session, ...change }))),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Missed)
    if ('checks' in report) expect(report.checks[check]).toBe(false)
  })

  test('does not confuse modest positive profit with the required absolute profit target', () => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(
        inputFixture(
          () => 100,
          () => 0,
        ),
      ),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Missed)
    if ('checks' in report) expect(report.checks.netProfit).toBe(false)
  })

  test('tracks drawdown across session boundaries', () => {
    const report = Result.getOrThrow(evaluateJevAcceptance(inputFixture((index) => (index < 6 ? -500 : 1000))))
    if ('checks' in report) {
      expect(report.metrics.maximumDrawdownUsd).toBe(3000)
      expect(report.checks.drawdown).toBe(false)
      expect(report.checks.sessionLoss).toBe(true)
    }
  })

  test('checks marked intraday losses even when the session closes profitably', () => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(
        changeCandidate(inputFixture(), (session) =>
          session.status === 'COMPLETE'
            ? { ...session, minimumEquityUsd: session.openingEquityUsd - 1500, maximumDrawdownUsd: 1500 }
            : session,
        ),
      ),
    )
    if ('checks' in report) expect(report.checks.sessionLoss).toBe(false)
  })

  test.each(['base', 'latency', 'marks'] as const)(
    'retains unresolved %s evidence instead of excluding the session',
    (kind) => {
      const report = Result.getOrThrow(
        evaluateJevAcceptance(
          changeCandidate(inputFixture(), (session) =>
            kind === 'base'
              ? { status: 'UNRESOLVED', sessionDate: session.sessionDate, evidenceHash: session.evidenceHash }
              : kind === 'latency'
                ? { ...session, p95LatencyStress: { status: 'UNRESOLVED', evidenceHash: 'f'.repeat(64) } }
                : { ...session, maximumMarkGapMs: 60_001 },
          ),
        ),
      )
      expect(report.verdict).toBe(JevNumericalVerdict.Inconclusive)
      expect('checks' in report).toBe(false)
      if ('unresolved' in report) expect(report.unresolved).toHaveLength(20)
    },
  )

  test('an unresolved control also prevents a pass', () => {
    const input = inputFixture()
    const report = Result.getOrThrow(
      evaluateJevAcceptance({
        ...input,
        policies: input.policies.map((policy) =>
          policy.policy === JevResearchPolicy.Ablation
            ? {
                ...policy,
                sessions: policy.sessions.map((session) => ({
                  status: 'UNRESOLVED',
                  sessionDate: session.sessionDate,
                  evidenceHash: session.evidenceHash,
                })),
              }
            : policy,
        ),
      }),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Inconclusive)
  })

  test('rejects altered calendars, protocols, late registrations and missing controls', () => {
    const input = inputFixture()
    for (const changed of [
      { ...input, protocolHash: '0'.repeat(64) },
      { ...input, registration: { ...input.registration, lockedAt: '2026-09-20T09:00:00.000Z' } },
      { ...input, registration: { ...input.registration, lockedAt: dates[0] + 'T13:30:00.000Z' } },
      { ...input, registration: { ...input.registration, sessions: input.registration.sessions.toReversed() } },
      { ...input, policies: input.policies.map((p) => ({ ...p, policy: JevResearchPolicy.Candidate })) },
      { ...input, policies: input.policies.map((p) => ({ ...p, sessions: p.sessions.slice(1) })) },
      changeCandidate(input, (session) => ({ ...session, sessionDate: '2026-09-21' })),
      changeCandidate(input, (session) => ({ ...session, netPnlUsd: Number.NaN })),
      changeCandidate(input, (session) => ({ ...session, netPnlUsd: 5000 })),
    ])
      expect(Result.isFailure(evaluateJevAcceptance(changed))).toBe(true)
  })

  test('spends less comparison error on later attempts and rejects insufficient bootstrap resolution', () => {
    const input = inputFixture(
      () => 300,
      (i) => (i % 2 === 0 ? 400 : -200),
    )
    const first = Result.getOrThrow(evaluateJevAcceptance(input))
    const second = Result.getOrThrow(
      evaluateJevAcceptance({ ...input, registration: { ...input.registration, attemptIndex: 2 } }),
    )
    if ('confidence' in first && 'confidence' in second)
      expect(second.confidence.comparisonAlpha).toBeLessThan(first.confidence.comparisonAlpha)
    expect(
      Result.isFailure(evaluateJevAcceptance({ ...input, registration: { ...input.registration, attemptIndex: 100 } })),
    ).toBe(true)
  })
})
