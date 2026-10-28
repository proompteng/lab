import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import { costReportFromEvidence } from '../inference-expense.test-support'
import { makeOperatingCostReport } from '../operating-costs'
import { operatingCostFixture } from '../operating-costs.test-support'
import { proportionalCost, indexOperatingCosts } from './cost-attribution'
import { registrationFixture, supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'
import { evaluateSystemAssessment } from './assessment'
import { assessSession } from './session'
import { inferenceExpenseRateCard } from '../inference-expense'
import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from '../jev/entry-inference.test-support'
import { JevFailure } from '../jev/contract'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'

const at = (ms: number) => new Date(ms).toISOString()
const session = { openAt: at(0), closeAt: at(10000) }
const request = (key: string, ms: number, inputTokens: number, missing = false, rejected = false) => {
  const {
    accountId: _,
    sessionDate: _date,
    asOf: _cut,
    ...row
  } = expenseSourceFixture({
    key,
    observedAt: at(ms),
    inputTokens,
    missing,
    rejected,
  })
  return row
}
const fixture = (requests = [request('a', 2500, 100000), request('b', 7500, 300000)]) => {
  const raw = operatingCostFixture({
    netTradingPnlMicros: '0',
    inferenceInvoiceMicros: '8400',
    inferenceTariffMicros: '0',
    dataCostMicros: '0',
    infrastructureCostMicros: '4000',
    researchCostMicros: '0',
  })
  const inference = Result.getOrThrow(
    costReportFromEvidence(
      {
        schemaVersion: 'bayn.inference-cost-evidence.v2',
        accountBindingHash: raw.evidence.accountBindingHash,
        sessionDate: raw.evidence.sessionDate,
        asOf: raw.evidence.asOf,
        requests,
      },
      expenseRateFixture,
    ),
  )
  const costs = Result.getOrThrow(makeOperatingCostReport(inference, raw.evidence, raw.verifiedSources))
  return { inference, costs }
}

test('fixed allocations accrue by clock time and invoice plus premium follow measured request usage', () => {
  const { inference, costs } = fixture()
  expect(inference.requestTimings).toHaveLength(2)
  expect(inference.requestTimings.map((timing) => timing.startedAt)).toEqual(
    expect.arrayContaining([at(2500), at(7500)]),
  )
  expect(costs.qualificationPnlMicros).toBe('-20800')
  expect(
    [0, 2500, 5000, 7500, 10000].map((ms) => indexOperatingCosts(costs, inference, session)?.(at(ms)) ?? null),
  ).toEqual([
    { operatingCostMicros: '0', qualificationPremiumMicros: '0' },
    { operatingCostMicros: '3100', qualificationPremiumMicros: '2100' },
    { operatingCostMicros: '4100', qualificationPremiumMicros: '2100' },
    { operatingCostMicros: '11400', qualificationPremiumMicros: '8400' },
    { operatingCostMicros: '12400', qualificationPremiumMicros: '8400' },
  ])
})

test('historical rejected usage retains its cost without inventing a provider start time', () => {
  const { inference, costs } = fixture([request('a', 2500, 100000, false, true)])
  expect(inference.requestTimings[0]?.startedAt).toBeNull()
  expect(costs.netEconomicPnlMicros).toBe('-12400')
  expect(indexOperatingCosts(costs, inference, session)?.(at(10000)) ?? null).toBeNull()
})

test('no-call sessions retain fixed invoices and all four categories without inventing usage', () => {
  const { inference, costs } = fixture([])
  expect(costs.netEconomicPnlMicros).toBe('-12400')
  expect(indexOperatingCosts(costs, inference, session)?.(at(5000)) ?? null).toEqual({
    operatingCostMicros: '6200',
    qualificationPremiumMicros: '0',
  })
  expect(indexOperatingCosts(costs, inference, session)?.(at(10000)) ?? null).toEqual({
    operatingCostMicros: '12400',
    qualificationPremiumMicros: '0',
  })
})

test('the frozen boundary rule retains costs allocated to the session when calls occur outside its hours', () => {
  const { inference, costs } = fixture([request('a', 0, 100000), request('b', 10000, 300000)])
  const window = { openAt: at(2000), closeAt: at(8000) }
  expect(indexOperatingCosts(costs, inference, window)?.(at(2000)) ?? null).toEqual({
    operatingCostMicros: '2100',
    qualificationPremiumMicros: '2100',
  })
  expect(indexOperatingCosts(costs, inference, window)?.(at(8000)) ?? null).toEqual({
    operatingCostMicros: '12400',
    qualificationPremiumMicros: '8400',
  })
})

test('missing, replaced, repeated or unpriced timing cannot produce a cost path', () => {
  const { inference, costs } = fixture()
  const first = inference.requestTimings[0]
  if (first === undefined) throw new Error('Missing inference timing')
  for (const requestTimings of [
    [],
    [first, first],
    inference.requestTimings.map((timing) => ({ ...timing, startedAt: null })),
    inference.requestTimings.map((timing) => ({ ...timing, requestKey: 'foreign request' })),
    inference.requestTimings.map((timing) => ({ ...timing, estimatedCostPicoUsd: '1' })),
    inference.requestTimings.map((timing) => ({ ...timing, startedAt: '1971-01-01T00:00:00.000Z' })),
  ])
    expect(indexOperatingCosts(costs, { ...inference, requestTimings }, session)?.(at(10000)) ?? null).toBeNull()
  const unknown = fixture([request('a', 2500, 100000, true)])
  expect(indexOperatingCosts(unknown.costs, unknown.inference, session)?.(at(10000)) ?? null).toBeNull()
  expect(indexOperatingCosts(costs, inference, session)?.(at(-1)) ?? null).toBeNull()
  expect(indexOperatingCosts(costs, inference, session)?.(at(10001)) ?? null).toBeNull()
})

test('fractional allocation preserves the terminal microdollar and rejects an impossible weight domain', () => {
  expect([0n, 1n, 2n, 3n].map((weight) => proportionalCost(10n, weight, 3n))).toEqual([0n, 3n, 6n, 10n])
  for (const [amount, weight, total] of [
    [-1n, 1n, 2n],
    [1n, -1n, 2n],
    [1n, 2n, 1n],
    [1n, 0n, 0n],
  ] as const)
    expect(proportionalCost(amount, weight, total)).toBeNull()
})

test('fixed accrual preserves integer milliseconds across the full supported date range', () => {
  const { inference } = fixture([])
  const raw = operatingCostFixture({
    netTradingPnlMicros: '0',
    inferenceInvoiceMicros: '0',
    inferenceTariffMicros: '0',
    dataCostMicros: '0',
    infrastructureCostMicros: '17280000000000000',
    researchCostMicros: '0',
  })
  const costs = Result.getOrThrow(makeOperatingCostReport(inference, raw.evidence, raw.verifiedSources))
  expect(
    indexOperatingCosts(costs, inference, { openAt: at(-8640000000000000), closeAt: at(8640000000000000) })?.(
      at(8639999999999999),
    ) ?? null,
  ).toEqual({ operatingCostMicros: '17279999999999999', qualificationPremiumMicros: '0' })
})

test('registration cannot substitute a different cost model and input marks cannot override accrued expenses', () => {
  const registration = registrationFixture()
  for (const policy of registration.policies)
    expect(
      Result.isFailure(
        validateSystemRegistration({
          ...registration,
          policies: registration.policies.map((definition) =>
            definition === policy ? { ...definition, costAllocationRuleHash: testHash('different rule') } : definition,
          ),
        }),
      ),
    ).toBe(true)
  const { input, verifiedSources } = supportedAssessmentFixture()
  expect(
    Result.isFailure(
      evaluateSystemAssessment(
        {
          ...input,
          policies: input.policies.map((policy) => ({
            ...policy,
            sessions: policy.sessions.map((session) => ({
              ...session,
              marks: session.marks.map((mark) => ({ ...mark, accruedOperatingCostMicros: '0' })),
            })),
          })),
        },
        verifiedSources,
      ),
    ),
  ).toBe(true)
})

test('a known metered expense without its request clock retains daily profit but cannot pass marked-risk qualification', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const originalDefinition = input.registration.policies[0]
  const original = input.policies[0]?.sessions[0]
  const calendar = input.registration.calendar.sessions[0]
  if (originalDefinition === undefined || original === undefined || calendar === undefined)
    throw new Error('Missing assessment fixture')
  const definition = { ...originalDefinition, inferenceRateCard: inferenceExpenseRateCard }
  const registration = {
    ...input.registration,
    policies: input.registration.policies.map((policy) => (policy === originalDefinition ? definition : policy)),
  }
  const request = entryEvaluationRequestFixture(calendar.openAt)
  const completion = entryCompletionFixture(request)
  for (const meteredFailure of [false, true]) {
    const completed = meteredFailure
      ? {
          ...completion,
          jev: {
            status: 'FAILED' as const,
            failure: JevFailure.Response,
            httpStatus: 429,
            responseHash: null,
            usage: { input_tokens: 200, output_tokens: 0 },
          },
        }
      : completion
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: completed.completedAt,
        outcome: { status: JevOutcome.Completed, completion: completed },
      }),
    )
    const inferenceEvidence = {
      schemaVersion: 'bayn.inference-cost-evidence.v4',
      accountBindingHash: definition.accountBindingHash,
      sessionDate: original.sessionDate,
      asOf: input.asOf,
      requests: [
        {
          requestId: request.requestId,
          cycleId: request.cycleId,
          authorityGenerationHash: request.authorityGenerationHash,
          request,
          receipt,
          resolution: null,
          handoff: completion.handoff,
          stagedCheckpoint: stagedCheckpointFixture(request),
        },
      ],
    }
    const inference = Result.getOrThrow(costReportFromEvidence(inferenceEvidence, inferenceExpenseRateCard))
    verifiedSources.add(inference.evidenceHash)
    verifiedSources.add(inference.rateCardHash)
    const session = {
      ...original,
      definitionHash: testHash(definition),
      inferenceEvidence,
      inferenceRateCard: inferenceExpenseRateCard,
      p95LatencyStress:
        original.p95LatencyStress === null
          ? null
          : {
              ...original.p95LatencyStress,
              image: { ...original.p95LatencyStress.image, policyDefinitionHash: testHash(definition) },
            },
    }
    const result = Result.getOrThrow(assessSession(session, registration, definition, input.asOf, verifiedSources))
    expect(result.netEconomicPnlMicros).toBe('1000000000')
    expect(inference.estimatedTotalCostMicros).toBe('29')
    expect(result.qualificationPnlMicros).toBe('999999971')
    expect(result.economicEvidenceComplete).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.missing).toEqual(meteredFailure ? ['INCOMPLETE_COST_ATTRIBUTION'] : [])
    expect(result.numerical.status).toBe(meteredFailure ? 'UNRESOLVED' : 'COMPLETE')
  }
})

test('indexed accrual includes coincident starts and supports repeated and reversed lookups', () => {
  const { inference, costs } = fixture([
    request('d', 10000, 400000),
    request('b', 5000, 200000),
    request('a', 0, 100000),
    request('c', 5000, 300000),
  ])
  const costsAt = indexOperatingCosts(costs, inference, session)
  expect(costsAt).not.toBeNull()
  expect([5000, 0, 10000, 4999, 5000].map((ms) => costsAt?.(at(ms)))).toEqual([
    { operatingCostMicros: '7040', qualificationPremiumMicros: '20160' },
    { operatingCostMicros: '840', qualificationPremiumMicros: '3360' },
    { operatingCostMicros: '12400', qualificationPremiumMicros: '33600' },
    { operatingCostMicros: '2839', qualificationPremiumMicros: '3360' },
    { operatingCostMicros: '7040', qualificationPremiumMicros: '20160' },
  ])
})
