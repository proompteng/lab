import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { Result, Schema } from 'effect'

import { OperatingCostEvidenceSchema } from '../operating-costs'
import { operatingCostFixture } from '../operating-costs.test-support'
import { evaluateSystemAssessment, QualificationVerdict } from './assessment'
import {
  allocateCostByWeights,
  CostAllocationPlanSchema,
  validateCostAllocationPlans,
  validateFrozenCostAllocations,
} from './cost-allocation'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'

const fixture = () => {
  const original = operatingCostFixture({
    netTradingPnlMicros: '0',
    inferenceInvoiceMicros: '0',
    inferenceTariffMicros: '0',
    dataCostMicros: '0',
    infrastructureCostMicros: '0',
    researchCostMicros: '11',
  }).evidence
  const line = original.consumption.at(-1)
  if (line === undefined) throw new Error('Missing cost fixture')
  const plan = Schema.decodeUnknownSync(CostAllocationPlanSchema)({
    provider: line.provider,
    category: line.category,
    serviceStartDate: '1970-01-01',
    serviceEndDateExclusive: '1970-01-04',
    basisSourceHash: testHash('reviewed basis'),
    weights: [
      { accountBindingHash: original.accountBindingHash, sessionDate: '1970-01-01', weight: '1' },
      { accountBindingHash: original.accountBindingHash, sessionDate: '1970-01-02', weight: '2' },
      { accountBindingHash: original.accountBindingHash, sessionDate: '1970-01-03', weight: '3' },
    ],
  })
  const evidence = Schema.decodeUnknownSync(OperatingCostEvidenceSchema)({
    ...original,
    consumption: [
      {
        ...line,
        serviceEndDateExclusive: plan.serviceEndDateExclusive,
        credits: [{ documentId: testHash('credit'), sourceHash: testHash('credit source'), amountMicros: '1' }],
        allocations: plan.weights.map((weight, index) => ({
          accountBindingHash: weight.accountBindingHash,
          sessionDate: weight.sessionDate,
          amountMicros: ['1', '4', '5'][index],
          sourceHash: plan.basisSourceHash,
        })),
      },
    ],
  })
  return { plan, evidence }
}

test('weighted allocation conserves exact microdollars with credits, outside-window shares and fixed remainders', () => {
  const { plan, evidence } = fixture()
  expect(
    Result.isSuccess(
      validateCostAllocationPlans([plan], new Set([evidence.accountBindingHash]), new Set([evidence.sessionDate])),
    ),
  ).toBe(true)
  expect(Result.getOrThrow(validateFrozenCostAllocations([plan], evidence))).toEqual([plan.basisSourceHash])
  expect(allocateCostByWeights(10n, [1n, 2n, 3n])).toEqual([1n, 4n, 5n])
  expect(allocateCostByWeights(1n, [1n, 1n, 1n])).toEqual([0n, 0n, 1n])
  expect(allocateCostByWeights(0n, [1n, 2n])).toEqual([0n, 0n])
  for (const [amount, weights] of [
    [-1n, [1n]],
    [1n, []],
    [1n, [0n]],
    [1n, [-1n, 2n]],
  ] as const)
    expect(allocateCostByWeights(amount, weights)).toBeNull()
})

test('property: arbitrary large allocation totals conserve money and each cumulative prefix rounds down', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 40n }),
      fc.array(fc.bigInt({ min: 1n, max: 10n ** 20n }), { minLength: 1, maxLength: 50 }),
      (amount, weights) => {
        const allocations = allocateCostByWeights(amount, weights)
        if (allocations === null) throw new Error('Valid allocation rejected')
        expect(allocations.reduce((sum, value) => sum + value, 0n)).toBe(amount)
        expect(allocations.every((value) => value >= 0n)).toBe(true)
        expect(
          allocateCostByWeights(
            amount,
            weights.map((value) => value * 17n),
          ),
        ).toEqual(allocations)
        const total = weights.reduce((sum, value) => sum + value, 0n)
        for (let length = 1; length <= weights.length; length++) {
          const prefix = allocations.slice(0, length).reduce((sum, value) => sum + value, 0n)
          const exactNumerator = amount * weights.slice(0, length).reduce((sum, value) => sum + value, 0n)
          expect(prefix * total <= exactNumerator && exactNumerator < (prefix + 1n) * total).toBe(true)
        }
      },
    ),
    { seed: 20261026, numRuns: 500 },
  )
})

test('prospective plans reject competing, unordered, nonpositive and out-of-period weights', () => {
  const { plan, evidence } = fixture()
  const accounts = new Set([evidence.accountBindingHash])
  const dates = new Set([evidence.sessionDate])
  for (const plans of [
    [plan, { ...plan, basisSourceHash: testHash('competing basis') }],
    [{ ...plan, weights: [...plan.weights].reverse() }],
    [{ ...plan, weights: [...plan.weights, ...plan.weights] }],
    [{ ...plan, weights: plan.weights.map((weight) => ({ ...weight, weight: '0' })) }],
    [{ ...plan, serviceEndDateExclusive: plan.serviceStartDate }],
    [{ ...plan, serviceStartDate: '1970-01-02' }],
    [{ ...plan, weights: plan.weights.map((weight) => ({ ...weight, accountBindingHash: testHash('foreign') })) }],
  ])
    expect(
      Result.isFailure(
        validateCostAllocationPlans(
          Schema.decodeUnknownSync(Schema.Array(CostAllocationPlanSchema))(plans),
          accounts,
          dates,
        ),
      ),
    ).toBe(true)
})

test('later invoice totals may change while the recipient weights remain frozen', () => {
  const { plan, evidence } = fixture()
  const changed = {
    ...evidence,
    consumption: evidence.consumption.map((line) => ({
      ...line,
      grossAmountMicros: '21',
      allocations: line.allocations.map((allocation, index) => ({
        ...allocation,
        amountMicros: ['3', '7', '10'][index],
      })),
    })),
  }
  expect(
    Result.isSuccess(
      validateFrozenCostAllocations([plan], Schema.decodeUnknownSync(OperatingCostEvidenceSchema)(changed)),
    ),
  ).toBe(true)
  for (const update of [
    { provider: 'another billing account' },
    { serviceEndDateExclusive: '1970-01-05' },
    { grossAmountMicros: '0' },
    {
      allocations: evidence.consumption.flatMap((line) => line.allocations.map((a) => ({ ...a, amountMicros: '0' }))),
      unallocatedMicros: '10',
    },
  ])
    expect(
      Result.isFailure(
        validateFrozenCostAllocations(
          [plan],
          Schema.decodeUnknownSync(OperatingCostEvidenceSchema)({
            ...evidence,
            consumption: evidence.consumption.map((line) => ({ ...line, ...update })),
          }),
        ),
      ),
    ).toBe(true)
})

test('missing allocated shares remain explicitly unallocated and cannot be represented as zero', () => {
  const { plan, evidence } = fixture()
  const partial = {
    ...evidence,
    consumption: evidence.consumption.map((line) => ({
      ...line,
      allocations: line.allocations.slice(0, 1),
      unallocatedMicros: '9',
    })),
  }
  expect(Result.isSuccess(validateFrozenCostAllocations([plan], partial))).toBe(true)
  expect(
    Result.isFailure(
      validateFrozenCostAllocations([plan], {
        ...partial,
        consumption: partial.consumption.map((line) => ({ ...line, unallocatedMicros: '0' })),
      }),
    ),
  ).toBe(true)
})

test('registered outside-account shares stay in the denominator instead of being charged to the evaluated account', () => {
  const { plan, evidence } = fixture()
  const account = '0'.repeat(64)
  const outside = 'f'.repeat(64)
  const sharedPlan = {
    ...plan,
    weights: [
      { accountBindingHash: account, sessionDate: evidence.sessionDate, weight: '1' },
      { accountBindingHash: outside, sessionDate: evidence.sessionDate, weight: '3' },
    ],
  }
  const shared = {
    ...evidence,
    accountBindingHash: account,
    consumption: evidence.consumption.map((line) => ({
      ...line,
      allocations: [
        {
          accountBindingHash: account,
          sessionDate: evidence.sessionDate,
          amountMicros: '2',
          sourceHash: plan.basisSourceHash,
        },
        {
          accountBindingHash: outside,
          sessionDate: evidence.sessionDate,
          amountMicros: '8',
          sourceHash: plan.basisSourceHash,
        },
      ],
    })),
  }
  expect(
    Result.isSuccess(validateCostAllocationPlans([sharedPlan], new Set([account]), new Set([evidence.sessionDate]))),
  ).toBe(true)
  expect(Result.isSuccess(validateFrozenCostAllocations([sharedPlan], shared))).toBe(true)
  expect(
    Result.isFailure(
      validateFrozenCostAllocations([sharedPlan], {
        ...shared,
        consumption: shared.consumption.map((line) => ({
          ...line,
          allocations: line.allocations.map((allocation) => ({
            ...allocation,
            amountMicros: allocation.accountBindingHash === account ? '10' : '0',
          })),
        })),
      }),
    ),
  ).toBe(true)
})

test('a complete assessment cannot move all costs to an unregistered external account', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const result = evaluateSystemAssessment(
    {
      ...input,
      policies: input.policies.map((policy) => ({
        ...policy,
        sessions: policy.sessions.map((session) => ({
          ...session,
          operatingCosts: {
            ...session.operatingCosts,
            consumption: session.operatingCosts.consumption.map((line) => ({
              ...line,
              allocations: line.allocations.map((allocation) => ({
                ...allocation,
                accountBindingHash: testHash('unregistered expense recipient'),
              })),
            })),
          },
        })),
      })),
    },
    verifiedSources,
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: 'OperatingCostError',
      message: 'Invoice allocation differs from its prospectively registered weights',
    })
})

test('missing frozen basis evidence prevents qualification and the registration hash binds every weight', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const plan = input.registration.costAllocationPlans[0]
  if (plan === undefined) throw new Error('Missing registered cost plan')
  verifiedSources.delete(plan.basisSourceHash)
  const assessment = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  expect(assessment.evidenceComplete).toBe(false)
  expect(assessment.verdict).not.toBe(QualificationVerdict.Qualified)
  const original = Result.getOrThrow(validateSystemRegistration(input.registration))
  const changed = Result.getOrThrow(
    validateSystemRegistration({
      ...input.registration,
      costAllocationPlans: input.registration.costAllocationPlans.map((p) => ({
        ...p,
        weights: p.weights.map((weight) => ({ ...weight, weight: '2' })),
      })),
    }),
  )
  expect(changed.registrationHash).not.toBe(original.registrationHash)
})
