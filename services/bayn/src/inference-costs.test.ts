import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Result } from 'effect'

import { canonicalHashV1 } from './hash'
import { inferenceCostConfig, parseInferenceCostArgs } from './inference-cost-command'
import { InferenceCostCoverage, InferenceUsageStatus, makeInferenceCostReport } from './inference-costs'
import { JevFailure } from './jev/contract'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from './jev/evidence'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { evaluationRequestFixture, responseFixture } from './jev/test-support'

const rateCard = {
  schemaVersion: 'bayn.inference-rate-card.v1',
  rates: [
    {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      currency: 'USD',
      source: 'synthetic rate fixture',
      effectiveFrom: '1970-01-01T00:00:00.000Z',
      effectiveUntil: '1970-01-02T00:00:00.000Z',
      inputMicrosPerMillionTokens: '42000',
      outputMicrosPerMillionTokens: '0',
    },
  ],
} as const

const row = (options: { rejected?: boolean; inputTokens?: number; cycle?: string; missing?: boolean } = {}) => {
  const base = evaluationRequestFixture()
  const { requestId: _id, ...material } = base
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({ ...material, cycleId: (options.cycle ?? 'a').repeat(64) }),
  )
  const response = {
    ...responseFixture(),
    usage: { input_tokens: options.inputTokens ?? 250, output_tokens: 80 },
  }
  // A structurally invalid answer can carry hash-bound, valid provider usage.
  const rejected = { ...response, answers: { unrelated: { type: 'noul', noul: 0.4 } } }
  const receipt = options.missing
    ? null
    : Result.getOrThrow(
        makeJevEvaluationReceipt(request, {
          schemaVersion: 'bayn.jev-evaluation-receipt.v1',
          requestId: request.requestId,
          startedAt: request.observedAt,
          completedAt: request.observedAt,
          outcome: options.rejected
            ? {
                status: JevOutcome.Failed,
                failure: JevFailure.Response,
                httpStatus: null,
                responseHash: canonicalHashV1(rejected),
                rejectedResponse: rejected,
              }
            : {
                status: JevOutcome.Received,
                inference: {
                  requestHash: request.requestHash,
                  responseHash: canonicalHashV1(response),
                  startedAt: request.observedAt,
                  completedAt: request.observedAt,
                  response,
                },
              },
        }),
      )
  return {
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution: null,
  }
}

const evidence = (requests: readonly ReturnType<typeof row>[]) => ({
  schemaVersion: 'bayn.inference-cost-evidence.v1',
  accountBindingHash: 'd'.repeat(64),
  sessionDate: '1970-01-01',
  asOf: '1970-01-01T00:00:10.000Z',
  requests,
})

describe('inference operating-cost evidence', () => {
  test('prices metered usage without adding output charges or rounding each call', () => {
    const result = Result.getOrThrow(makeInferenceCostReport(evidence([row()]), rateCard))
    expect(result.coverage).toBe(InferenceCostCoverage.Estimated)
    expect(result.invoiceReconciled).toBe(false)
    expect(result.inputTokens).toBe('250')
    expect(result.outputTokens).toBe('80')
    expect(result.knownEstimatedCostPicoUsd).toBe('10500000')
    expect(result.estimatedTotalCostMicros).toBe('11')
    const fractional = Result.getOrThrow(
      makeInferenceCostReport(evidence([row({ inputTokens: 1 }), row({ inputTokens: 1, cycle: 'b' })]), rateCard),
    )
    expect(fractional.knownEstimatedCostPicoUsd).toBe('84000')
    expect(fractional.estimatedTotalCostMicros).toBe('1')
  })

  test('includes rejected response usage and keeps missing receipts explicitly unknown', () => {
    const result = Result.getOrThrow(
      makeInferenceCostReport(
        evidence([row(), row({ rejected: true, cycle: 'b' }), row({ missing: true, cycle: 'c' })]),
        rateCard,
      ),
    )
    expect(result.requestCount).toBe(3)
    expect(result.meteredRequestCount).toBe(2)
    expect(result.rejectedResponseUsageCount).toBe(1)
    expect(result.unknownUsageCount).toBe(1)
    expect(result.inputTokens).toBe('500')
    expect(result.knownEstimatedCostMicros).toBe('21')
    expect(result.estimatedTotalCostMicros).toBeNull()
    expect(result.coverage).toBe(InferenceCostCoverage.Incomplete)
    expect(result.requests.some((line) => line.usageStatus === InferenceUsageStatus.Rejected)).toBe(true)
  })

  test('prices retained responses even when their decision resolution was abandoned', () => {
    const source = row()
    const resolution = Result.getOrThrow(
      makeJevResolution(source.request, source.receipt, {
        schemaVersion: 'bayn.jev-evaluation-resolution.v1',
        requestId: source.requestId,
        status: JevResolutionStatus.Abandoned,
        abandonedAt: source.request.expiresAt,
      }),
    )
    const result = Result.getOrThrow(
      makeInferenceCostReport({ ...evidence([]), requests: [{ ...source, resolution }] }, rateCard),
    )
    expect(result.meteredRequestCount).toBe(1)
    expect(result.estimatedTotalCostMicros).toBe('11')
  })

  test('deduplicates identical evidence and rejects conflicting duplicate receipts', () => {
    const source = row()
    const result = Result.getOrThrow(makeInferenceCostReport(evidence([source, source]), rateCard))
    expect(result.requestCount).toBe(1)
    expect(result.inputTokens).toBe('250')
    expect(Result.isFailure(makeInferenceCostReport(evidence([source, row({ inputTokens: 251 })]), rateCard))).toBe(
      true,
    )
  })

  test('missing model prices and uncovered effective dates never become zero cost', () => {
    for (const rates of [
      [],
      [{ ...rateCard.rates[0], model: 'other' }],
      [{ ...rateCard.rates[0], effectiveFrom: '1970-01-01T00:00:01.000Z' }],
    ]) {
      const result = Result.getOrThrow(makeInferenceCostReport(evidence([row()]), { ...rateCard, rates }))
      expect(result.unpricedUsageCount).toBe(1)
      expect(result.estimatedTotalCostMicros).toBeNull()
      expect(result.requests[0]?.estimatedCostPicoUsd).toBeNull()
    }
  })

  test('rejects overlapping or empty tariff intervals, malformed money, and corrupt evidence', () => {
    for (const rates of [
      [rateCard.rates[0], rateCard.rates[0]],
      [{ ...rateCard.rates[0], effectiveUntil: rateCard.rates[0].effectiveFrom }],
      [{ ...rateCard.rates[0], inputMicrosPerMillionTokens: '-1' }],
    ])
      expect(Result.isFailure(makeInferenceCostReport(evidence([row()]), { ...rateCard, rates }))).toBe(true)
    const source = row()
    for (const bad of [
      { ...source, cycleId: 'f'.repeat(64) },
      { ...source, request: { ...source.request, symbol: 'INVALID' } },
      { ...source, receipt: { ...source.receipt, receiptHash: 'f'.repeat(64) } },
    ])
      expect(Result.isFailure(makeInferenceCostReport({ ...evidence([]), requests: [bad] }, rateCard))).toBe(true)
  })

  test('rejects evidence beyond its as-of cut', () => {
    const before = { ...evidence([row()]), asOf: '1969-12-31T23:59:59.000Z' }
    expect(Result.isFailure(makeInferenceCostReport(before, rateCard))).toBe(true)
  })

  test('report identity is stable under reordering and includes the supplied rate card identity', () => {
    const rows = [row(), row({ cycle: 'b' })]
    const one = Result.getOrThrow(makeInferenceCostReport(evidence(rows), rateCard))
    const two = Result.getOrThrow(makeInferenceCostReport(evidence([...rows].reverse()), rateCard))
    expect(one.reportHash).toBe(two.reportHash)
    const changed = Result.getOrThrow(
      makeInferenceCostReport(evidence(rows), {
        ...rateCard,
        rates: [{ ...rateCard.rates[0], source: 'another fixture' }],
      }),
    )
    expect(changed.reportHash).not.toBe(one.reportHash)
  })

  test('explicit zero prices are valid estimates but never imply invoice reconciliation', () => {
    const result = Result.getOrThrow(
      makeInferenceCostReport(evidence([row()]), {
        ...rateCard,
        rates: [{ ...rateCard.rates[0], inputMicrosPerMillionTokens: '0' }],
      }),
    )
    expect(result.estimatedTotalCostMicros).toBe('0')
    expect(result.invoiceReconciled).toBe(false)
  })
})

describe('inference-cost operator command', () => {
  test('uses the standard verified PostgreSQL CA without requiring broker or model credentials', () => {
    const config = Effect.runSync(
      inferenceCostConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            BAYN_ALPACA_ACCOUNT_ID: 'fixture-account',
            BAYN_POSTGRES_URL: 'postgresql://fixture@localhost/fixture_test',
          }),
        ),
      ),
    )
    expect(config.tls).toBe(true)
    expect(config.caPath).toBe('/var/run/secrets/bayn/postgres/ca.crt')
  })

  test('accepts an explicit session or offline evidence and requires a rate card', () => {
    expect(Result.getOrThrow(parseInferenceCostArgs(['--help']))._tag).toBe('Help')
    expect(
      Result.getOrThrow(parseInferenceCostArgs(['--session', '2026-01-02', '--rate-card', 'rates.json']))._tag,
    ).toBe('Session')
    expect(
      Result.getOrThrow(parseInferenceCostArgs(['--evidence', 'evidence.json', '--rate-card', 'rates.json']))._tag,
    ).toBe('Evidence')
    for (const args of [
      [],
      ['--session', '2026-02-30', '--rate-card', 'rates.json'],
      ['--session', '2026-01-02'],
      ['--evidence', '--session', '--rate-card', 'rates.json'],
    ])
      expect(Result.isFailure(parseInferenceCostArgs(args))).toBe(true)
  })
})
