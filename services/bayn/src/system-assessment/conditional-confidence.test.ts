import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import fc from 'fast-check'

import {
  ceilSquareRoot,
  conditionalBound,
  conditionalConfidence,
  ConditionalStatisticalPlanSchema,
  type ConditionalStatisticalPlan,
} from './conditional-confidence'
import { JevResearchPolicy } from '../jev/acceptance'
import { evaluateSystemAssessment, QualificationVerdict, EdgeStatus } from './assessment'
import {
  registrationFixture,
  supportedAssessmentFixture,
  testHash,
  knownPayoffAssessmentFixture,
} from './fixtures.test-support'

const plan = (lower = '-3', upper = '1'): ConditionalStatisticalPlan => ({
  method: 'CONDITIONAL_HOEFFDING_V1',
  meanModel: 'DETERMINISTIC_CONDITIONAL_SESSION_MEANS',
  supports: [
    {
      policy: JevResearchPolicy.Candidate,
      lowerMicros: lower,
      upperMicros: upper,
      sourceHash: testHash('registered support'),
      assumption: 'Synthetic bounded process fixed before any observation.',
    },
    {
      policy: JevResearchPolicy.Momentum,
      lowerMicros: '-4',
      upperMicros: '-4',
      sourceHash: testHash('registered control support'),
      assumption: 'Synthetic deterministic control fixed before observations.',
    },
  ],
})
const confidence = (values: readonly string[], attemptIndex = 1, support = plan()) =>
  conditionalConfidence(
    support,
    { policy: JevResearchPolicy.Candidate, netProfitMicros: values },
    [{ policy: JevResearchPolicy.Momentum, netProfitMicros: values.map(() => '-4') }],
    attemptIndex,
  )

test('radius rounds outward exactly, including zero and arbitrary-precision boundaries', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 10n ** 100n }), (value) => {
      const radius = ceilSquareRoot(value)
      expect(radius * radius >= value).toBe(true)
      expect(value === 0n || (radius - 1n) * (radius - 1n) < value).toBe(true)
    }),
    { seed: 251106, numRuns: 300 },
  )
  for (const value of [0n, 1n, 2n, 4n, 9n, 10n, 10n ** 100n]) expect(ceilSquareRoot(value) ** 2n >= value).toBe(true)
})

test('two winning sessions from a negative-expectancy process cannot establish profit or edge against a losing control', () => {
  for (const values of [
    ['1', '1'],
    ['1', '-3'],
    ['-3', '1'],
    ['-3', '-3'],
  ]) {
    const result = Result.getOrThrow(confidence(values))
    expect(BigInt(result.profit.lowerSumMicros) <= 0n).toBe(true)
    expect(result.alpha).toEqual({ numerator: '1', denominator: '80' })
  }
})

test('the lower bound has conservative finite-sample coverage on an exactly enumerated negative-mean process', () => {
  // X=1 or -3 with equal probability has mean -1. Enumerate the binomial law, not a Monte Carlo approximation.
  const n = 100
  let combinations = 1n,
    excluded = 0n
  for (let wins = 0; wins <= n; wins++) {
    const values = [...Array<bigint>(wins).fill(1n), ...Array<bigint>(n - wins).fill(-3n)]
    const bound = conditionalBound(values, -3n, 1n, 80n)
    if (BigInt(bound.lowerSumMicros) > -BigInt(n)) excluded += combinations
    if (wins < n) combinations = (combinations * BigInt(n - wins)) / BigInt(wins + 1)
  }
  expect(excluded > 0n).toBe(true)
  expect(80n * excluded <= 2n ** BigInt(n)).toBe(true)
})

test('all attempted policies share the immutable error budget without a resampling work quota', () => {
  for (const attempt of [1, 13, 1000, 1000000]) {
    const result = Result.getOrThrow(confidence(['1'], attempt))
    expect(BigInt(result.alpha.denominator)).toBe(40n * BigInt(attempt) * BigInt(attempt + 1))
    const bits = BigInt(result.profit.logUpperBound)
    expect(2n ** bits >= BigInt(result.alpha.denominator)).toBe(true)
    expect(2n ** (bits - 1n) < BigInt(result.alpha.denominator)).toBe(true)
  }
})

test('bounded returns with a common shock need an explicit population-mean model', () => {
  // Both equally likely paths have population mean zero. Arbitrary dependence alone would give 50% miscoverage.
  const paths = [Array<bigint>(100).fill(1n), Array<bigint>(100).fill(-1n)]
  const excluded = paths.filter((values) => BigInt(conditionalBound(values, -1n, 1n, 80n).lowerSumMicros) > 0n).length
  expect(excluded).toBe(1)
  expect(excluded * 80 > paths.length).toBe(true)
  const { meanModel: _meanModel, ...unregistered } = plan()
  expect(Result.isFailure(Schema.decodeUnknownResult(ConditionalStatisticalPlanSchema)(unregistered))).toBe(true)
})

test('missing, substituted, duplicated and out-of-support evidence is rejected rather than clipped or filled with zero', () => {
  expect(Result.isFailure(confidence([]))).toBe(true)
  expect(Result.isFailure(confidence(['2']))).toBe(true)
  expect(Result.isFailure(confidence(['1'], 1, { ...plan(), supports: plan().supports.slice(1) }))).toBe(true)
  expect(
    Result.isFailure(confidence(['1'], 1, { ...plan(), supports: [plan().supports[0]!, plan().supports[0]!] })),
  ).toBe(true)
  expect(
    Result.isFailure(
      conditionalConfidence(
        plan(),
        { policy: JevResearchPolicy.Candidate, netProfitMicros: ['1'] },
        [{ policy: JevResearchPolicy.Momentum, netProfitMicros: [] }],
        1,
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      conditionalConfidence(
        plan(),
        { policy: JevResearchPolicy.Candidate, netProfitMicros: ['1'] },
        [{ policy: JevResearchPolicy.Candidate, netProfitMicros: ['1'] }],
        1,
      ),
    ),
  ).toBe(true)
})

test('current complete qualification is reachable in one registered session under an explicit deterministic model, with no bootstrap quota', () => {
  const { input, verifiedSources } = knownPayoffAssessmentFixture()
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  expect(report.verdict).toBe(QualificationVerdict.Qualified)
  expect(report.edge.status).toBe(EdgeStatus.Established)
  expect(report.edge.statisticalAssumptions.some((text) => text.includes('not establish future profitability'))).toBe(
    true,
  )
  expect(report.reliability.target).toEqual({ numerator: '999', denominator: '1000' })
  expect(report.safety.violations).toEqual([])
  expect(input.registration).not.toHaveProperty('bootstrap')
  const missing = new Set(verifiedSources)
  missing.delete(testHash('prospectively fixed synthetic deterministic payouts'))
  expect(Result.getOrThrow(evaluateSystemAssessment(input, missing)).verdict).not.toBe(QualificationVerdict.Qualified)
})

test('wide registered supports retain exact lower bounds without overflowing display numbers', () => {
  const base = registrationFixture(undefined, 1)
  if (base.schemaVersion !== 'bayn.system-registration.v4') throw new Error('Expected current registration')
  const magnitude = 10n ** 400n
  const registration = {
    ...base,
    statisticalPlan: {
      ...base.statisticalPlan,
      supports: base.statisticalPlan.supports.map((support) => ({
        ...support,
        lowerMicros: String(-magnitude),
        upperMicros: String(magnitude),
      })),
    },
  }
  const { input, verifiedSources } = supportedAssessmentFixture(1, registration)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  expect(report.verdict).toBe(QualificationVerdict.Rejected)
  expect(report.edge.status).toBe(EdgeStatus.NotEstablished)
  expect(report.profitability.netEconomicPnlMicros).toBe('1000000000')
})
