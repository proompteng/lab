import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Result } from 'effect'

import { canonicalHashV1, sha256 } from './hash'
import { parseInferenceCostArgs } from './inference-cost-command'
import { makeInferenceCostReport } from './inference-costs'
import { JevOutcome, makeJevEvaluationReceipt } from './jev/evidence'
import { evaluationRequestFixture, responseFixture } from './jev/test-support'
import { readOperatingCostPacket } from './operating-cost-files'
import {
  makeOperatingCostReport,
  OperatingCostCategory,
  OperatingCostCoverage,
  type OperatingCostEvidence,
} from './operating-costs'

const source = 'f'.repeat(64)
const creditSource = '8'.repeat(64)
const paymentSource = '7'.repeat(64)
const account = 'd'.repeat(64)
const verified = new Set([source, creditSource, paymentSource])
const inference = (missing = false) => {
  const request = evaluationRequestFixture()
  const response = { ...responseFixture(), usage: { input_tokens: 100_000, output_tokens: 10 } }
  const receipt = missing
    ? null
    : Result.getOrThrow(
        makeJevEvaluationReceipt(request, {
          schemaVersion: 'bayn.jev-evaluation-receipt.v1',
          requestId: request.requestId,
          startedAt: request.observedAt,
          completedAt: request.observedAt,
          outcome: {
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
  return Result.getOrThrow(
    makeInferenceCostReport(
      {
        schemaVersion: 'bayn.inference-cost-evidence.v1',
        accountBindingHash: account,
        sessionDate: '1970-01-01',
        asOf: '1970-01-01T00:00:10.000Z',
        requests: [
          {
            requestId: request.requestId,
            cycleId: request.cycleId,
            authorityGenerationHash: request.authorityGenerationHash,
            request,
            receipt,
            resolution: null,
          },
        ],
      },
      {
        schemaVersion: 'bayn.inference-rate-card.v1',
        rates: [
          {
            provider: 'typesafe',
            model: request.request.model,
            currency: 'USD',
            source: 'synthetic tariff',
            effectiveFrom: '1970-01-01T00:00:00.000Z',
            effectiveUntil: '1970-01-02T00:00:00.000Z',
            inputMicrosPerMillionTokens: '42000',
            outputMicrosPerMillionTokens: '0',
          },
        ],
      },
    ),
  )
}

const evidence = (complete = false): OperatingCostEvidence => ({
  schemaVersion: 'bayn.operating-cost-evidence.v1',
  accountBindingHash: account,
  sessionDate: '1970-01-01',
  asOf: '1970-01-01T00:00:20.000Z',
  currency: 'USD',
  trading: { netPnlAfterExecutionFeesMicros: '1000000', sourceHash: source },
  coverage: Object.values(OperatingCostCategory).map((category) => ({
    category,
    status: complete ? OperatingCostCoverage.Complete : OperatingCostCoverage.Unknown,
    sourceHash: complete ? source : null,
  })),
  consumption: [],
  prepaidFunding: [],
})

const charge = (): OperatingCostEvidence['consumption'][number] => ({
  provider: 'synthetic-provider',
  documentId: 'a'.repeat(64),
  lineId: 'usage-line',
  sourceHash: source,
  category: OperatingCostCategory.Inference,
  serviceStartDate: '1970-01-01',
  serviceEndDateExclusive: '1970-01-02',
  grossAmountMicros: '5000',
  credits: [{ documentId: 'b'.repeat(64), sourceHash: creditSource, amountMicros: '1000' }],
  allocations: [
    { accountBindingHash: account, sessionDate: '1970-01-01', amountMicros: '2000', sourceHash: source },
    { accountBindingHash: 'e'.repeat(64), sessionDate: '1970-01-01', amountMicros: '2000', sourceHash: source },
  ],
  unallocatedMicros: '0',
})

const topup = (): OperatingCostEvidence['prepaidFunding'][number] => ({
  provider: 'synthetic-provider',
  documentId: 'c'.repeat(64),
  invoiceSourceHash: source,
  issuedOn: '1970-01-01',
  creditAmountMicros: '5000000',
  payment: { paidOn: '1970-01-01', paidMicros: '5000000', receiptSourceHash: paymentSource },
})

describe('document-bound external operating costs', () => {
  test('rejects reused payment or credit artifacts under different normalized document identities', () => {
    const additionalSource = '6'.repeat(64)
    const sources = new Set([...verified, additionalSource])
    const funding = {
      ...topup(),
      documentId: '5'.repeat(64),
      invoiceSourceHash: additionalSource,
    }
    expect(
      Result.isFailure(
        makeOperatingCostReport(inference(), { ...evidence(), prepaidFunding: [topup(), funding] }, sources),
      ),
    ).toBe(true)
    const first = charge()
    const second = {
      ...first,
      documentId: '4'.repeat(64),
      sourceHash: additionalSource,
      credits: [{ ...first.credits[0], documentId: '3'.repeat(64), sourceHash: creditSource, amountMicros: '1000' }],
    }
    expect(
      Result.isFailure(makeOperatingCostReport(inference(), { ...evidence(), consumption: [first, second] }, sources)),
    ).toBe(true)
  })

  test('does not expense prepaid credits or double-count the matching invoice and receipt', () => {
    const input = { ...evidence(), prepaidFunding: [topup(), topup()] }
    const report = Result.getOrThrow(makeOperatingCostReport(inference(), input, verified))
    expect(report.prepaidFunding.uniqueInvoices).toBe(1)
    expect(report.prepaidFunding.providerReceiptedPaymentsMicros).toBe('5000000')
    expect(report.knownInvoicedOperatingCostMicros).toBe('0')
    expect(report.knownInferenceTariffCostMicros).toBe('4200')
    expect(report.netPnlAfterKnownInferenceTariffMicros).toBe('995800')
    expect(report.prepaidFunding.balanceMicros).toBeNull()
    expect(report.invoiceReconciled).toBe(false)
    expect(report.totalOperatingCostMicros).toBeNull()
    expect(report.netEconomicPnlMicros).toBeNull()
  })

  test('reconciles credits and all allocation shares, replacing rather than adding the tariff estimate', () => {
    const line = charge()
    const report = Result.getOrThrow(
      makeOperatingCostReport(inference(), { ...evidence(true), consumption: [line, line] }, verified),
    )
    expect(report.knownInvoicedOperatingCostMicros).toBe('2000')
    expect(report.totalOperatingCostMicros).toBe('2000')
    expect(report.netEconomicPnlMicros).toBe('998000')
    expect(report.invoiceReconciled).toBe(true)
    expect(report.qualificationInferenceCostMicros).toBe('4200')
    expect(report.importedUnallocatedCostMicros).toBe('0')
    const { reportHash, ...material } = report
    expect(reportHash).toBe(canonicalHashV1(material))
  })

  test('applies the qualification maximum once and keeps unresolved tariff coverage explicit', () => {
    const base = charge()
    const line = {
      ...base,
      grossAmountMicros: '9000',
      credits: [],
      allocations: [
        {
          ...base.allocations[0],
          accountBindingHash: account,
          sessionDate: '1970-01-01',
          amountMicros: '9000',
          sourceHash: source,
        },
      ],
    }
    const input = { ...evidence(true), consumption: [line] }
    const report = Result.getOrThrow(makeOperatingCostReport(inference(), input, verified))
    expect(report.qualificationInferenceCostMicros).toBe('9000')
    expect(report.netEconomicPnlMicros).toBe('991000')
    const missing = Result.getOrThrow(makeOperatingCostReport(inference(true), input, verified))
    expect(missing.invoiceReconciled).toBe(true)
    expect(missing.unknownInferenceUsageCount).toBe(1)
    expect(missing.qualificationInferenceCostMicros).toBeNull()
  })

  test('requires explicit evidence for every zero/complete category and all referenced artifacts', () => {
    for (const input of [
      { ...evidence(true), coverage: evidence(true).coverage.slice(1) },
      { ...evidence(true), coverage: evidence(true).coverage.map((c) => ({ ...c, sourceHash: null })) },
      { ...evidence(), accountBindingHash: 'a'.repeat(64) },
      { ...evidence(), asOf: '1970-01-01T00:00:01.000Z' },
    ])
      expect(Result.isFailure(makeOperatingCostReport(inference(), input, verified))).toBe(true)
    expect(Result.isFailure(makeOperatingCostReport(inference(), evidence(), new Set()))).toBe(true)
  })

  test('rejects conflicting duplicates, over-allocation, repeated credits, and unsupported full coverage', () => {
    const line = charge()
    const cases = [
      { ...evidence(), consumption: [line, { ...line, grossAmountMicros: '7000' }] },
      { ...evidence(), consumption: [{ ...line, unallocatedMicros: '1' }] },
      { ...evidence(), consumption: [{ ...line, credits: [...line.credits, ...line.credits] }] },
      { ...evidence(true), consumption: [{ ...line, allocations: [line.allocations[0]], unallocatedMicros: '2000' }] },
      { ...evidence(), consumption: [{ ...line, allocations: [...line.allocations, line.allocations[0]] }] },
      { ...evidence(), prepaidFunding: [topup(), { ...topup(), creditAmountMicros: '6000000' }] },
      { ...evidence(), prepaidFunding: [topup()], consumption: [{ ...line, documentId: topup().documentId }] },
      { ...evidence(), prepaidFunding: [topup(), { ...topup(), documentId: '9'.repeat(64) }] },
    ]
    for (const input of cases)
      expect(Result.isFailure(makeOperatingCostReport(inference(), input, verified))).toBe(true)
  })

  test('supports explicit expense packets without silently accepting malformed extra flags', () => {
    const args = ['--evidence', 'evidence.json', '--rate-card', 'rates.json', '--expenses', 'expenses.json']
    expect(Result.getOrThrow(parseInferenceCostArgs(args))).toMatchObject({
      _tag: 'Evidence',
      expensesPath: 'expenses.json',
    })
    for (const invalid of [
      args.slice(0, -1),
      [...args, '--help'],
      [...args.slice(0, -1), '--help'],
      [...args.slice(0, 4), '--other', 'x'],
    ])
      expect(Result.isFailure(parseInferenceCostArgs(invalid))).toBe(true)
  })

  test('verifies original artifact bytes and detects changed files before any economic report', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-expense-test-' })
        const text = 'synthetic reviewed financial evidence'
        const digest = sha256(text)
        const input = {
          ...evidence(true),
          trading: { netPnlAfterExecutionFeesMicros: '1000000', sourceHash: digest },
          coverage: evidence(true).coverage.map((c) => ({ ...c, sourceHash: digest })),
        }
        yield* fs.writeFileString(`${root}/source.txt`, text)
        yield* fs.writeFileString(
          `${root}/packet.json`,
          JSON.stringify({ evidence: input, artifacts: [{ sha256: digest, path: 'source.txt' }] }),
        )
        const packet = yield* readOperatingCostPacket(`${root}/packet.json`)
        expect(packet.verifiedSourceHashes.has(digest)).toBe(true)
        yield* fs.writeFileString(`${root}/source.txt`, 'changed')
        const changed = yield* Effect.result(readOperatingCostPacket(`${root}/packet.json`))
        expect(Result.isFailure(changed)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  })
})
