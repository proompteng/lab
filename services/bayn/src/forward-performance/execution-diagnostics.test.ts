import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeForwardPerformanceReceipt } from './domain'
import { ExecutionDiagnosticEvaluation, makeForwardPerformanceExecutionMeasurements } from './execution-quality'
import { executionQualityFixture } from './execution-quality.test-support'
import type { ForwardPerformanceExecutionQualityReasonCode } from './model'
import { makeForwardPerformanceReport, recordForwardPerformancePersistence } from './report'

type Fixture = ReturnType<typeof executionQualityFixture>
type Execution = Fixture['executionEvidence'][number]
const omit = <A extends object, K extends keyof A>(value: A, key: K): Omit<A, K> => {
  const { [key]: _omitted, ...rest } = value
  return rest
}
const input = executionQualityFixture(2)
const ledgerTotals = input.ledgerTotals
assert(ledgerTotals !== undefined)
const executions = (change: (row: Execution) => Execution): Fixture => ({
  ...input,
  executionEvidence: input.executionEvidence.map(change),
})

// Captured from unmodified c9e4616a. Diagnostics must not alter even failed receipt hashes.
const cases: readonly {
  name: string
  input: Fixture
  receiptHash: string
  counts: Partial<Record<ForwardPerformanceExecutionQualityReasonCode, number>>
}[] = [
  { name: 'valid', input, receiptHash: '814423b66100b01bf08916f57e16b96e22e2db6d1062bf7b1b94974d683cd765', counts: {} },
  {
    name: 'unverified decision',
    input: { ...input, unverifiedDecisionHashes: ['a'.repeat(64)] },
    receiptHash: 'b4eb876d8514c648e18adebed02fddeb482f8f819e9d12dee38cc4e96971f0bb',
    counts: { PLANNED_DECISION_EVIDENCE_GAP: 1 },
  },
  {
    name: 'missing execution evidence',
    input: { ...input, executionEvidence: [] },
    receiptHash: 'c412e6ed2ea3707a34aaf4b2c213bb6bf0a45576060ed36bef1ef83aa48675f7',
    counts: { PLANNED_DECISION_EVIDENCE_GAP: 1 },
  },
  {
    name: 'empty',
    input: executionQualityFixture(0),
    receiptHash: '19ec9b6bc572126ec56d0bdbdd0b52bd6c54979fd39b6f15b36e1d57c856bfe0',
    counts: { ZERO_COMPLETED_EXECUTIONS: 1 },
  },
  {
    name: 'missing accounting event',
    input: { ...input, transactions: input.transactions.map((row) => omit(row, 'brokerEventId')) },
    receiptHash: 'd70e848eeda4199d78a8324c8791ab28c8eb22bbfb187b75637d4ae38580e618',
    counts: { ACCOUNTING_FILL_BINDING_GAP: 4, FILL_QUANTITY_MISMATCH: 2, TERMINAL_PRICE_EVIDENCE_GAP: 2 },
  },
  {
    name: 'missing intent',
    input: executions((row) => omit(row, 'intent')),
    receiptHash: 'f0005e719414a041f44c7b80e2e73f87461c09a78f314a42a96781df3200a659',
    counts: { FILL_IDENTITY_DRIFT: 4, TERMINAL_ORDER_EVIDENCE_GAP: 2 },
  },
  {
    name: 'missing order',
    input: executions((row) => omit(row, 'terminalOrder')),
    receiptHash: '76a8a6e27719ed5c2f2bb533fb16c2af658441e0b3829fd4b9c77e815cd60245',
    counts: {
      FILL_IDENTITY_DRIFT: 2,
      FILL_QUANTITY_MISMATCH: 2,
      FILL_TIMESTAMP_GAP: 2,
      TERMINAL_ORDER_EVIDENCE_GAP: 2,
    },
  },
  {
    name: 'missing fills',
    input: executions((row) => ({ ...row, fills: [] })),
    receiptHash: '3ef8e357ced681ed22f2df83d3cf8e9629c64637cb4bfabb052cddf2f9f61f3c',
    counts: {
      ACCOUNTING_FILL_BINDING_GAP: 1,
      FILL_EVIDENCE_GAP: 2,
      FILL_QUANTITY_MISMATCH: 2,
      TERMINAL_PRICE_EVIDENCE_GAP: 2,
    },
  },
  {
    name: 'fill timestamp',
    input: executions((row) => ({ ...row, fills: row.fills.map((fill) => ({ ...fill, sourceTimestamp: 'invalid' })) })),
    receiptHash: 'e223a6e1c080e402bdfee0bd96da6a77aa6e5ed6e0d4d39bf2bf720970f89e29',
    counts: { FILL_TIMESTAMP_GAP: 2 },
  },
  {
    name: 'fill quantity',
    input: executions((row) => ({
      ...row,
      fills: row.fills.map((fill) => ({ ...fill, quantityAtoms: '2000000000' })),
    })),
    receiptHash: '466b2156ecffdf40210ec01121ca4b25cee09413a843c7ecb2e8e03fb489c04d',
    counts: { ACCOUNTING_FILL_BINDING_GAP: 2, FILL_QUANTITY_MISMATCH: 2, TERMINAL_PRICE_EVIDENCE_GAP: 2 },
  },
  {
    name: 'duplicate execution',
    input: { ...input, executionEvidence: input.executionEvidence.slice(0, 1).flatMap((row) => [row, row]) },
    receiptHash: '043678934c21197e89b4c560badd22917f2f38d128b2082c1ec91a8098efc4f3',
    counts: { ACCOUNTING_FILL_BINDING_GAP: 1, DUPLICATE_EXECUTION_EVIDENCE: 2 },
  },
  {
    name: 'ledger gap',
    input: { ...input, ledgerExact: false },
    receiptHash: '8bed3325a6aed5a37303abf625f13fec9753b14c4ef106020c42aa4221bddc03',
    counts: { ACCOUNT_LEDGER_RECONCILIATION_GAP: 1 },
  },
  {
    name: 'cost gap',
    input: { ...input, ledgerTotals: { ...ledgerTotals, otherChargedCostsMicros: null } },
    receiptHash: 'ee0067a722d6fc82648f206c69fd2ed9b6ad54685283ca18c3465c12db6924a4',
    counts: { EXPLICIT_COST_EVIDENCE_GAP: 1 },
  },
  {
    name: 'reference gap',
    input: executions((row) => ({ ...row, referencePriceMicros: '0' })),
    receiptHash: '259b63934b106b06694b2e6081b70e0ee9bb0be0c6c84df560c7cb64b23c5df7',
    counts: { INVALID_EXECUTION_MICROS: 2, REFERENCE_PRICE_EVIDENCE_GAP: 2 },
  },
  {
    name: 'planned quantity',
    input: executions((row) => ({ ...row, plannedQuantityAtoms: '0' })),
    receiptHash: '4b8b93d7d0063b94541b5ad95aa839f555c537fbe2b698d74300655770428079',
    counts: { FILL_IDENTITY_DRIFT: 2, PLANNED_DECISION_EVIDENCE_GAP: 2, TERMINAL_ORDER_EVIDENCE_GAP: 2 },
  },
  {
    name: 'invalid fill number',
    input: executions((row) => ({ ...row, fills: row.fills.map((fill) => ({ ...fill, feeMicros: 'invalid' })) })),
    receiptHash: 'dff95438861ab0a0a789010bec4f81d998d76d844abbc09842b398e8918ea677',
    counts: { INVALID_EXECUTION_MICROS: 2, FILL_QUANTITY_MISMATCH: 2, TERMINAL_PRICE_EVIDENCE_GAP: 2 },
  },
]

for (const scenario of cases) {
  test(`counts original predicate failures and preserves the receipt: ${scenario.name}`, () => {
    const before = structuredClone(scenario.input)
    const measured = Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(scenario.input))
    const positive = Object.fromEntries(
      Object.entries(measured.diagnostics.reasonOccurrences).filter(([, count]) => count > 0),
    )
    assert.deepEqual(positive, scenario.counts)
    assert.deepEqual(Object.keys(positive).sort(), measured.executionQuality.reasonCodes)
    assert.equal(Result.getOrThrow(makeForwardPerformanceReceipt(scenario.input)).receiptHash, scenario.receiptHash)
    assert.deepEqual(scenario.input, before)
    assert.deepEqual(
      Result.getOrThrow(
        makeForwardPerformanceExecutionMeasurements({
          ...scenario.input,
          executionEvidence: scenario.input.executionEvidence.toReversed(),
          transactions: scenario.input.transactions.toReversed(),
        }),
      ),
      measured,
    )
  })
}

test('distinguishes unevaluated, absent and measured evidence without reading past the original early gate', () => {
  const unverified = Result.getOrThrow(
    makeForwardPerformanceExecutionMeasurements({
      ...input,
      unverifiedDecisionHashes: ['a'.repeat(64)],
      get transactions(): Fixture['transactions'] {
        throw new Error('must not read unevaluated transactions')
      },
    }),
  ).diagnostics
  assert.equal(unverified.evaluation, ExecutionDiagnosticEvaluation.NotEvaluated)
  assert.equal(unverified.inputTransactionCount, null)
  assert.equal(unverified.evaluatedFillCount, null)
  const empty = Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(executionQualityFixture(0))).diagnostics
  assert.equal(empty.evaluation, ExecutionDiagnosticEvaluation.NoExecutionEvidence)
  assert.equal(empty.inputTransactionCount, 0)
  assert.equal(empty.evaluatedFillCount, 0)
  const measured = Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input)).diagnostics
  assert.equal(measured.evaluation, ExecutionDiagnosticEvaluation.Evaluated)
  assert.equal(measured.inputExecutionCount, 2)
  assert.equal(measured.inputTransactionCount, 2)
  assert.equal(measured.evaluatedFillCount, 2)
})

test('keeps diagnostic output fixed-size and private as failure occurrences grow', () => {
  const source = executionQualityFixture(1_000)
  const diagnostics = Result.getOrThrow(
    makeForwardPerformanceExecutionMeasurements({
      ...source,
      executionEvidence: source.executionEvidence.map((row) => omit(row, 'intent')),
    }),
  ).diagnostics
  assert.equal(diagnostics.reasonOccurrences.FILL_IDENTITY_DRIFT, 2_000)
  assert.equal(Object.keys(diagnostics.reasonOccurrences).length, 14)
  assert(Object.values(diagnostics.reasonOccurrences).every((value) => Number.isSafeInteger(value) && value >= 0))
  const encoded = JSON.stringify(diagnostics)
  assert(encoded.length < 1_024)
  for (const privateValue of [source.account.accountId, 'NVDA', ...source.transactions.map((row) => row.transactionId)])
    assert(!encoded.includes(privateValue))
  assert.equal(
    Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input)).diagnostics.reasonOccurrences
      .FILL_IDENTITY_DRIFT,
    0,
  )
})

test('hashes the report sidecar from one measurement pass without changing receipt persistence', () => {
  let reads = 0
  const report = Result.getOrThrow(
    makeForwardPerformanceReport(
      {
        ...input,
        get executionEvidence() {
          reads += 1
          return input.executionEvidence
        },
      },
      [],
    ),
  )
  assert.equal(reads, 1)
  assert.equal(report.schemaVersion, 'bayn.forward-performance-report.v8')
  assert.equal(report.receipt.receiptHash, cases[0]?.receiptHash)
  const { reportHash, ...material } = report
  assert.equal(Result.getOrThrow(canonicalHashV1Result(material)), reportHash)
  const persisted = Result.getOrThrow(recordForwardPerformancePersistence(report))
  assert.deepEqual(persisted.receipt, report.receipt)
  assert.deepEqual(persisted.executionDiagnostics, report.executionDiagnostics)
})
