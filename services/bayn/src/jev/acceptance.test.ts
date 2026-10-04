import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { checkProperty } from '../testing/property-test-support'

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

const numerical = (input: unknown) => {
  const report = Result.getOrThrow(evaluateJevAcceptance(input))
  if (!('checks' in report)) throw new Error('Expected a complete numerical report')
  return report
}

const sampledTotals = (microDollars: ReadonlyArray<bigint>) => {
  let state = 20260921
  const totals: bigint[] = []
  for (let replicate = 0; replicate < 10_000; replicate += 1) {
    let total = 0n
    for (let block = 0; block < 10; block += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      const start = Math.floor(((state >>> 0) * 20) / 4294967296)
      const first = microDollars[start]
      const second = microDollars[(start + 1) % 20]
      if (first === undefined || second === undefined) throw new Error('Oracle requires twenty observations')
      total += first + second
    }
    totals.push(total)
  }
  return totals.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

describe('Jev frozen numerical acceptance', () => {
  test('rejects an exact $50 paired bootstrap lower bound with fractional-dollar inputs', () => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(
        inputFixture(
          () => 300.000005,
          (index) => (index < 10 ? 256.000005 : 216.000005),
        ),
      ),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Missed)
    if (!('checks' in report)) throw new Error('Expected a complete numerical report')
    expect(report.checks.pairedIncrementalLowerBounds).toBe(false)
    expect(report.confidence.paired.map((comparison) => comparison.meanIncrementalNetPnlUsdLowerBound)).toEqual([
      50, 50, 50,
    ])
  })

  test('accepts an exact $5,000 total without losing fractional dollars during summation', () => {
    const report = Result.getOrThrow(
      evaluateJevAcceptance(inputFixture((index) => (index < 19 ? 249.999997 : 250.000057))),
    )
    expect(report.verdict).toBe(JevNumericalVerdict.Passed)
    if (!('checks' in report)) throw new Error('Expected a complete numerical report')
    expect(report.checks.netProfit).toBe(true)
    expect(report.metrics.netPnlUsd).toBe(5000)
  })

  test('rounds a mixed-scale mean only once when its exact value exceeds a binary64 midpoint', () => {
    const values = [6000, 5.684341886080801e-13, 4.86968994140625e-29, Number.MIN_VALUE]
    const report = numerical(
      inputFixture(
        (index) => values[index] ?? 0,
        () => 0,
      ),
    )
    expect(report.confidence.paired.map((comparison) => comparison.meanIncrementalNetPnlUsd)).toEqual([
      300.00000000000006, 300.00000000000006, 300.00000000000006,
    ])
  })

  test.each([-1, 0, 1])('keeps submicro strict gate direction for decimal offset %s', (direction) => {
    const epsilon = direction / 10_000_000
    const paired = numerical(
      inputFixture(
        () => 300 + epsilon,
        (index) => (index < 10 ? 256 : 216),
      ),
    )
    expect(paired.checks.pairedIncrementalLowerBounds).toBe(direction > 0)
    expect(paired.confidence.paired[0]?.meanIncrementalNetPnlUsdLowerBound).toBe(50 + epsilon)

    const cost = numerical(
      changeCandidate(
        inputFixture(() => 300 + epsilon),
        (session) => ({ ...session, filledNotionalUsd: 300_000 }),
      ),
    )
    expect(cost.checks.additionalExecutionCost).toBe(direction > 0)
    expect(cost.metrics.netAfterAdditionalCostUsd).toBe(direction / 500_000)
  })

  test.each([Number.MIN_VALUE, 1e-100, 1e-7, -Number.MIN_VALUE, -1e-100, -1e-7, -0])(
    'preserves exponent and signed-zero inputs at strict zero gates for %s',
    (value) => {
      const report = numerical(
        changeCandidate(
          inputFixture(
            () => value,
            () => 0,
          ),
          (session) => ({
            ...session,
            p95LatencyStress: { status: 'COMPLETE', netPnlUsd: value, evidenceHash: 'f'.repeat(64) },
          }),
        ),
      )
      expect(report.checks.positiveProfitLowerBound).toBe(value > 0)
      expect(report.checks.p95BatchLatency).toBe(value > 0)
      expect(report.checks.profitWithoutBestSession).toBe(value > 0)
      expect(report.confidence.meanNetPnlUsdLowerBound).toBe(value === 0 ? 0 : value)
      expect(report.metrics.p95LatencyStressNetPnlUsd).toBe(value === 0 ? 0 : value * 20)
      expect(report.verdict).toBe(JevNumericalVerdict.Missed)
    },
  )

  test.each([-1_000_000_000, 1_000_000_000])('retains the accepted money schema endpoint %s', (value) => {
    const report = numerical(
      changeCandidate(inputFixture(), (session) => ({
        ...session,
        filledNotionalUsd: 1_000_000_000,
        p95LatencyStress: { status: 'COMPLETE', netPnlUsd: value, evidenceHash: 'f'.repeat(64) },
      })),
    )
    expect(report.metrics.filledNotionalUsd).toBe(20_000_000_000)
    expect(report.metrics.p95LatencyStressNetPnlUsd).toBe(value * 20)
    expect(report.checks.p95BatchLatency).toBe(value > 0)
  })

  test('keeps exact inclusive volume, multiplier and risk thresholds', () => {
    for (const direction of [-1, 0, 1]) {
      const report = numerical(
        changeCandidate(
          inputFixture(
            () => 250.0000005 + direction / 10_000_000,
            () => 200.0000004,
          ),
          (session) => ({ ...session, filledNotionalUsd: 100_000 + direction / 10_000_000 }),
        ),
      )
      expect(report.checks.observedControlAdvantage).toBe(direction >= 0)
      expect(report.checks.volume).toBe(direction >= 0)
    }
    for (const loss of [1000, 1000.000001]) {
      const report = numerical(
        changeCandidate(inputFixture(), (session) =>
          session.status === 'COMPLETE'
            ? { ...session, minimumEquityUsd: session.openingEquityUsd - loss, maximumDrawdownUsd: loss }
            : session,
        ),
      )
      expect(report.checks.sessionLoss).toBe(loss <= 1000)
    }
  })

  test('property: exact totals retain boundary direction under session permutations', () => {
    checkProperty(
      'jev-acceptance-decimal-totals',
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 19, maxLength: 19 }),
        fc.integer({ min: -1, max: 1 }),
        (offsets, direction) => {
          const totalOffset = offsets.reduce((total, value) => total + value, 0)
          const values = [...offsets, direction - totalOffset].map((value) => (250_000_000 + value) / 1_000_000)
          for (const ordered of [values, values.toReversed()]) {
            const report = numerical(inputFixture((index) => ordered[index] ?? 0))
            expect(report.checks.netProfit).toBe(direction >= 0)
            expect(report.metrics.netPnlUsd).toBe((5_000_000_000 + direction) / 1_000_000)
          }
        },
      ),
      20,
    )
  })

  test('property: a common decimal shift cannot pass an exact $50 paired lower bound', () => {
    checkProperty(
      'jev-acceptance-paired-equality',
      fc.property(fc.integer({ min: 1, max: 999_999 }), (shift) => {
        const report = numerical(
          inputFixture(
            () => (300_000_000 + shift) / 1_000_000,
            (index) => ((index < 10 ? 256_000_000 : 216_000_000) + shift) / 1_000_000,
          ),
        )
        expect(report.confidence.paired.map((comparison) => comparison.meanIncrementalNetPnlUsdLowerBound)).toEqual([
          50, 50, 50,
        ])
        expect(report.checks.pairedIncrementalLowerBounds).toBe(false)
        expect(report.verdict).toBe(JevNumericalVerdict.Missed)
      }),
      20,
    )
  })

  test('property: frozen resampling agrees with an independent micro-dollar oracle', () => {
    checkProperty(
      'jev-acceptance-resampling-oracle',
      fc.property(
        fc.array(fc.integer({ min: -40_000_000, max: 40_000_000 }), { minLength: 20, maxLength: 20 }),
        fc.integer({ min: 1, max: 12 }),
        (offsets, attemptIndex) => {
          const candidate = offsets.map((offset) => BigInt(300_000_000 + offset))
          const differences = candidate.map((value, index) => value - BigInt(index < 10 ? 256_000_005 : 216_000_005))
          const candidateLower = sampledTotals(candidate)[499]
          const pairedLower = sampledTotals(differences)[Math.floor(9999 / (60 * attemptIndex * (attemptIndex + 1)))]
          if (candidateLower === undefined || pairedLower === undefined) throw new Error('Oracle percentile is missing')
          const input = inputFixture(
            (index) => Number(candidate[index]) / 1_000_000,
            (index) => (index < 10 ? 256.000005 : 216.000005),
          )
          const report = numerical({
            ...input,
            registration: { ...input.registration, attemptIndex },
            policies: input.policies.toReversed(),
          })
          expect(report.confidence.meanNetPnlUsdLowerBound).toBe(Number(candidateLower) / 20_000_000)
          expect(report.confidence.paired.map((comparison) => comparison.meanIncrementalNetPnlUsdLowerBound)).toEqual([
            Number(pairedLower) / 20_000_000,
            Number(pairedLower) / 20_000_000,
            Number(pairedLower) / 20_000_000,
          ])
          expect(report.checks.pairedIncrementalLowerBounds).toBe(pairedLower > 1_000_000_000n)
        },
      ),
      20,
    )
  })

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
