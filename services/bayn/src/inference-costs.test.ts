import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import { parseInferenceCostArgs } from './inference-cost-command'
import { researchReaderConfig } from './db/research-reader-config'
import { InferenceCostCoverage, InferenceUsageStatus } from './inference-costs'
import { decodeHistoricalJevCostEvidence } from './jev/historical-inference-cost-evidence'
import { costReportFromEvidence, expenseSourceFixture } from './inference-expense.test-support'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { responseFixture } from './jev/test-support'
import { decodeJevEvaluationRequest } from './jev/evidence'

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

const row = (
  options: {
    rejected?: boolean
    inputTokens?: number
    cycle?: string
    missing?: boolean
    notDispatched?: boolean
  } = {},
) => {
  const source = expenseSourceFixture({
    key: options.cycle,
    rejected: options.rejected,
    inputTokens: options.inputTokens ?? 250,
    missing: options.missing,
    notDispatched: options.notDispatched,
  })
  const { accountId: _account, sessionDate: _date, asOf: _asOf, ...value } = source
  return { ...value, resolution: null }
}

const evidence = (requests: readonly ReturnType<typeof row>[]) => ({
  schemaVersion: 'bayn.inference-cost-evidence.v2',
  accountBindingHash: 'd'.repeat(64),
  sessionDate: '1970-01-01',
  asOf: '1970-01-01T00:00:10.000Z',
  requests,
})

describe('inference operating-cost evidence', () => {
  test.each([
    { options: {}, startedAt: '1970-01-01T00:00:00.000Z', cost: '10500000' },
    { options: { rejected: true }, startedAt: null, cost: '10500000' },
    { options: { notDispatched: true }, startedAt: null, cost: '0' },
    { options: { missing: true }, startedAt: null, cost: null },
  ])('historical timing uses provider evidence without changing costs: %j', ({ options, startedAt, cost }) => {
    const source = row(options)
    const result = Result.getOrThrow(costReportFromEvidence(evidence([source]), rateCard))
    expect(result.requestTimings).toEqual([{ requestKey: source.requestId, startedAt, estimatedCostPicoUsd: cost }])
  })

  test('reads retained v1 financial evidence without accepting a retired request for execution', () => {
    const { handoff: _, ...retained } = row()
    const historical = { ...evidence([]), schemaVersion: 'bayn.inference-cost-evidence.v1', requests: [retained] }
    expect(Result.getOrThrow(costReportFromEvidence(historical, rateCard)).knownEstimatedCostPicoUsd).toBe('10500000')
    expect(Result.isFailure(decodeJevEvaluationRequest(retained.request))).toBe(true)
  })
  test('uses positive undispatched receipts for zero cost without inventing provider usage or a tariff', () => {
    const result = Result.getOrThrow(
      costReportFromEvidence(evidence([row({ notDispatched: true })]), { ...rateCard, rates: [] }),
    )
    expect(result.notDispatchedRequestCount).toBe(1)
    expect(result.meteredRequestCount).toBe(0)
    expect(result.unknownUsageCount).toBe(0)
    expect(result.unpricedUsageCount).toBe(0)
    expect(result.inputTokens).toBe('0')
    expect(result.outputTokens).toBe('0')
    expect(result.estimatedTotalCostMicros).toBe('0')
    expect(result.requests[0]?.rateHash).toBeNull()
    expect(result.requests[0]?.usageStatus).toBe(InferenceUsageStatus.NotDispatched)
    expect(result.invoiceReconciled).toBe(false)
  })

  test('rejects undispatched receipts that contain HTTP evidence or do not prove the persistence deadline', () => {
    const source = row({ notDispatched: true })
    const receipt = source.receipt!
    for (const changed of [
      { ...receipt, completedAt: source.request.observedAt },
      { ...receipt, startedAt: source.request.expiresAt },
      { ...receipt, outcome: { ...receipt.outcome, httpStatus: 200 } },
      {
        ...receipt,
        outcome: {
          ...receipt.outcome,
          rejectedResponse: responseFixture(),
          responseHash: Result.getOrThrow(canonicalHashV1Result(responseFixture())),
        },
      },
    ]) {
      const { receiptHash: _hash, ...material } = changed
      expect(
        Result.isFailure(
          decodeHistoricalJevCostEvidence(
            source.request,
            { ...material, receiptHash: Result.getOrThrow(canonicalHashV1Result(material)) },
            null,
          ),
        ),
      ).toBe(true)
    }
  })

  test('keeps command diagnostics on stderr and reserves stdout for report data', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/inference-cost-command.ts`, '--invalid'],
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stdout)).toBe('')
    expect(new TextDecoder().decode(result.stderr)).toContain('InferenceCostError')
  })

  test('prices metered usage without adding output charges or rounding each call', () => {
    const result = Result.getOrThrow(costReportFromEvidence(evidence([row()]), rateCard))
    expect(result.coverage).toBe(InferenceCostCoverage.Estimated)
    expect(result.invoiceReconciled).toBe(false)
    expect(result.inputTokens).toBe('250')
    expect(result.outputTokens).toBe('80')
    expect(result.knownEstimatedCostPicoUsd).toBe('10500000')
    expect(result.estimatedTotalCostMicros).toBe('11')
    const fractional = Result.getOrThrow(
      costReportFromEvidence(evidence([row({ inputTokens: 1 }), row({ inputTokens: 1, cycle: 'b' })]), rateCard),
    )
    expect(fractional.knownEstimatedCostPicoUsd).toBe('84000')
    expect(fractional.estimatedTotalCostMicros).toBe('1')
  })

  test('includes rejected response usage and keeps missing receipts explicitly unknown', () => {
    const result = Result.getOrThrow(
      costReportFromEvidence(
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
      costReportFromEvidence({ ...evidence([]), requests: [{ ...source, resolution }] }, rateCard),
    )
    expect(result.meteredRequestCount).toBe(1)
    expect(result.estimatedTotalCostMicros).toBe('11')
  })

  test('deduplicates identical evidence and rejects conflicting duplicate receipts', () => {
    const source = row()
    const result = Result.getOrThrow(costReportFromEvidence(evidence([source, source]), rateCard))
    expect(result.requestCount).toBe(1)
    expect(result.inputTokens).toBe('250')
    expect(Result.isFailure(costReportFromEvidence(evidence([source, row({ inputTokens: 251 })]), rateCard))).toBe(true)
  })

  test('missing model prices and uncovered effective dates never become zero cost', () => {
    for (const rates of [
      [],
      [{ ...rateCard.rates[0], model: 'other' }],
      [{ ...rateCard.rates[0], effectiveFrom: '1970-01-01T00:00:01.000Z' }],
    ]) {
      const result = Result.getOrThrow(costReportFromEvidence(evidence([row()]), { ...rateCard, rates }))
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
      expect(Result.isFailure(costReportFromEvidence(evidence([row()]), { ...rateCard, rates }))).toBe(true)
    const source = row()
    for (const bad of [
      { ...source, cycleId: 'f'.repeat(64) },
      { ...source, request: { ...source.request, symbol: 'INVALID' } },
      { ...source, receipt: { ...source.receipt, receiptHash: 'f'.repeat(64) } },
    ])
      expect(Result.isFailure(costReportFromEvidence({ ...evidence([]), requests: [bad] }, rateCard))).toBe(true)
  })

  test('rejects evidence beyond its as-of cut', () => {
    const before = { ...evidence([row()]), asOf: '1969-12-31T23:59:59.000Z' }
    expect(Result.isFailure(costReportFromEvidence(before, rateCard))).toBe(true)
  })

  test('report identity is stable under reordering and includes the supplied rate card identity', () => {
    const rows = [row(), row({ cycle: 'b' })]
    const one = Result.getOrThrow(costReportFromEvidence(evidence(rows), rateCard))
    const two = Result.getOrThrow(costReportFromEvidence(evidence([...rows].reverse()), rateCard))
    expect(one.reportHash).toBe(two.reportHash)
    const changed = Result.getOrThrow(
      costReportFromEvidence(evidence(rows), {
        ...rateCard,
        rates: [{ ...rateCard.rates[0], source: 'another fixture' }],
      }),
    )
    expect(changed.reportHash).not.toBe(one.reportHash)
  })

  test('explicit zero prices are valid estimates but never imply invoice reconciliation', () => {
    const result = Result.getOrThrow(
      costReportFromEvidence(evidence([row()]), {
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
      researchReaderConfig.pipe(
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
    expect(Result.getOrThrow(parseInferenceCostArgs(['--ledger-session', '2026-10-06']))).toEqual({
      _tag: 'LedgerSession',
      sessionDate: '2026-10-06',
    })
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
      ['--ledger-session', '2026-02-30'],
      ['--ledger-session', '2026-10-06', '--rate-card', 'replacement.json'],
    ])
      expect(Result.isFailure(parseInferenceCostArgs(args))).toBe(true)
  })
})
