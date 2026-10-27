import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { validateOperatingCostWindow } from './operating-cost-window'
import { OperatingCostEvidenceSchema } from './operating-costs'
import { operatingCostFixture } from './operating-costs.test-support'
import { evaluateSystemAssessment, QualificationVerdict } from './system-assessment/assessment'
import { supportedAssessmentFixture, testHash } from './system-assessment/fixtures.test-support'

const fixture = () => {
  const base = operatingCostFixture({
    netTradingPnlMicros: '0',
    inferenceInvoiceMicros: '8',
    inferenceTariffMicros: '0',
    dataCostMicros: '0',
    infrastructureCostMicros: '0',
    researchCostMicros: '0',
  }).evidence
  const original = base.consumption[0]
  if (original === undefined) throw new Error('Missing cost fixture')
  const line = {
    ...original,
    serviceEndDateExclusive: '1970-01-03',
    allocations: ['1970-01-01', '1970-01-02'].map((sessionDate, index) => ({
      accountBindingHash: base.accountBindingHash,
      sessionDate,
      amountMicros: String(index === 0 ? 3 : 5),
      sourceHash: original.sourceHash,
    })),
  }
  return ['1970-01-01', '1970-01-02'].map((sessionDate) =>
    Schema.decodeUnknownSync(OperatingCostEvidenceSchema)({
      ...base,
      sessionDate,
      asOf: '1970-01-03T00:00:00.000Z',
      consumption: [line],
    }),
  )
}

test('one invoice has one allocation map across sessions and ordering does not change its identity', () => {
  const rows = fixture()
  expect(Result.isSuccess(validateOperatingCostWindow(rows))).toBe(true)
  expect(
    Result.isSuccess(
      validateOperatingCostWindow(
        rows.map((row) => ({
          ...row,
          consumption: row.consumption.map((line) => ({ ...line, allocations: [...line.allocations].reverse() })),
        })),
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      validateOperatingCostWindow(
        rows.map((row, index) => ({
          ...row,
          consumption: row.consumption.map((line) => ({
            ...line,
            allocations: line.allocations.map((allocation, at) => ({
              ...allocation,
              amountMicros: index === at ? '0' : '8',
            })),
          })),
        })),
      ),
    ),
  ).toBe(true)
})

test('an observed in-window allocation cannot disappear from its recipient session', () => {
  const rows = fixture()
  expect(
    Result.isFailure(
      validateOperatingCostWindow(
        rows.map((row, index) =>
          index === 0
            ? row
            : {
                ...row,
                consumption: [],
              },
        ),
      ),
    ),
  ).toBe(true)
  expect(Result.isSuccess(validateOperatingCostWindow(rows.slice(0, 1)))).toBe(true)
})

test('invoice aliases and prepaid reclassification cannot evade window identity checks', () => {
  const rows = fixture()
  expect(
    Result.isFailure(
      validateOperatingCostWindow(
        rows.map((row, index) =>
          index === 0
            ? row
            : {
                ...row,
                consumption: row.consumption.map((line) => ({ ...line, documentId: testHash('other invoice') })),
              },
        ),
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      validateOperatingCostWindow(
        rows.map((row, index) =>
          index === 0
            ? row
            : {
                ...row,
                prepaidFunding: row.consumption.map((line) => ({
                  provider: line.provider,
                  documentId: line.documentId,
                  invoiceSourceHash: line.sourceHash,
                  issuedOn: row.sessionDate,
                  creditAmountMicros: line.grossAmountMicros,
                  payment: null,
                })),
              },
        ),
      ),
    ),
  ).toBe(true)
})

test('one credit or payment cannot fund different documents in separate session reports', () => {
  const rows = fixture()
  const separate = rows.map((row, index) => ({
    ...row,
    consumption: row.consumption.map((line) => ({
      ...line,
      documentId: testHash(`invoice ${index}`),
      sourceHash: testHash(`invoice source ${index}`),
      allocations: [
        {
          accountBindingHash: row.accountBindingHash,
          sessionDate: row.sessionDate,
          amountMicros: '7',
          sourceHash: testHash(`allocation ${index}`),
        },
      ],
      credits: [
        { documentId: testHash(`credit ${index}`), sourceHash: testHash(`credit source ${index}`), amountMicros: '1' },
      ],
    })),
  }))
  expect(Result.isSuccess(validateOperatingCostWindow(separate))).toBe(true)
  const credited = separate.map((row) => ({
    ...row,
    consumption: row.consumption.map((line) => ({
      ...line,
      credits: line.credits.map((credit) => ({
        ...credit,
        documentId: testHash('shared credit'),
        sourceHash: testHash('shared credit source'),
      })),
    })),
  }))
  expect(Result.isFailure(validateOperatingCostWindow(credited))).toBe(true)
  const funded = rows.map((row, index) => ({
    ...row,
    prepaidFunding: [
      {
        provider: 'synthetic provider',
        documentId: testHash(`funding ${index}`),
        invoiceSourceHash: testHash(`funding source ${index}`),
        issuedOn: row.sessionDate,
        creditAmountMicros: '1',
        payment: { paidOn: row.sessionDate, paidMicros: '1', receiptSourceHash: testHash(`payment ${index}`) },
      },
    ],
  }))
  expect(Result.isSuccess(validateOperatingCostWindow(funded))).toBe(true)
  const reusedPayment = funded.map((row) => ({
    ...row,
    prepaidFunding: row.prepaidFunding.map((funding) => ({
      ...funding,
      payment: { ...funding.payment, receiptSourceHash: testHash('shared payment') },
    })),
  }))
  expect(Result.isFailure(validateOperatingCostWindow(reusedPayment))).toBe(true)
})

test('moving one invoice to another day in every copy cannot produce a positive qualification verdict', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  expect(Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources)).verdict).toBe(
    QualificationVerdict.Qualified,
  )
  const sourceHash = testHash('one synthetic invoice for the entire window')
  verifiedSources.add(sourceHash)
  const changed = {
    ...input,
    policies: input.policies.map((policy, policyIndex) =>
      policyIndex !== 0
        ? policy
        : {
            ...policy,
            sessions: policy.sessions.map((session, index) => {
              const first = policy.sessions[0]
              const next = policy.sessions[(index + 1) % policy.sessions.length]
              if (first === undefined || next === undefined) throw new Error('Missing registered session')
              return {
                ...session,
                marks: session.marks.map((mark) => ({
                  ...mark,
                  cashFlowAdjustedTradingEquityMicros: (
                    BigInt(mark.cashFlowAdjustedTradingEquityMicros) +
                    BigInt(index) * 15000000n
                  ).toString(),
                })),
                operatingCosts: {
                  ...session.operatingCosts,
                  consumption: session.operatingCosts.consumption.map((line) => ({
                    ...line,
                    documentId: sourceHash,
                    sourceHash,
                    serviceStartDate: first.sessionDate,
                    serviceEndDateExclusive: '2026-12-01',
                    grossAmountMicros: '300000000',
                    allocations: [
                      {
                        accountBindingHash: session.operatingCosts.accountBindingHash,
                        sessionDate: next.sessionDate,
                        amountMicros: '300000000',
                        sourceHash,
                      },
                    ],
                  })),
                },
              }
            }),
          },
    ),
  }
  const result = evaluateSystemAssessment(changed, verifiedSources)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: 'OperatingCostError',
      message: expect.stringContaining('Operating-cost window'),
    })
})
