import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Result } from 'effect'

import * as accounting from '../src/accounting/domain'
import type { PositionCost } from '../src/accounting/model'
import { OrderSide, type Fill } from '../src/execution/contracts'
import { sha256 } from '../src/hash'
import { verifyAccountingHistory } from '../src/reconciliation/algebra'

// From the baseline checkout root, before changing the implementation:
// bayn_baseline_directory="$(mktemp -d -t bayn-accounting-baseline.XXXXXX)"
// bun build services/bayn/src/accounting/domain.ts --target=node --outfile="$bayn_baseline_directory/domain.mjs"
// bun build services/bayn/src/reconciliation/algebra.ts --target=node --outfile="$bayn_baseline_directory/algebra.mjs"
// From the candidate checkout root in the same shell:
// bun build services/bayn/tools/benchmark-accounting-verification.ts --target=node --outfile="$bayn_baseline_directory/benchmark.mjs"
// node "$bayn_baseline_directory/benchmark.mjs" "$bayn_baseline_directory"
// Use the production Node version (v24.11.1 for the original measurement). Both implementations
// receive the same synthetic history; fixture construction and parity checks are not timed.
const baselinePath = process.argv[2]
assert(baselinePath !== undefined, 'Usage: benchmark-accounting-verification <baseline-directory>')
const baseline: typeof accounting = await import(pathToFileURL(resolve(baselinePath, 'domain.mjs')).href)
const baselineAlgebra: { readonly verifyAccountingHistory: typeof verifyAccountingHistory } = await import(
  pathToFileURL(resolve(baselinePath, 'algebra.mjs')).href
)
const ledger = 7001
const history = Array.from({ length: 1104 }, (_, index) => {
  const side = index % 4 === 0 ? OrderSide.Buy : OrderSide.Sell
  const tiny = index % 4 === 3
  const fill: Fill = {
    schemaVersion: 'bayn.fill.v2',
    accountId: `benchmark-account-${index % 3}`,
    fillId: `fill-${index}`,
    brokerOrderId: `order-${index}`,
    clientOrderId: `client-${index}`,
    symbol: `SYMBOL${index % 20}`,
    side,
    quantityAtoms: tiny ? '1000' : '1000000000',
    priceAtoms: tiny ? '1000000000' : index % 4 === 1 ? '120000000000' : '90000000000',
    feeMicros: tiny ? '0' : '100',
    occurredAt: '2026-11-06T15:30:00.000Z',
  }
  const prior: PositionCost =
    side === OrderSide.Buy
      ? { quantityAtoms: '0', costMicros: '0' }
      : tiny
        ? { quantityAtoms: '3000', costMicros: '1' }
        : { quantityAtoms: '3000000000', costMicros: '300000000' }
  const brokerEventId = sha256(`event-${index}`)
  const before = Result.getOrThrow(baseline.prepareAccounting(brokerEventId, fill, prior, ledger))
  const after = Result.getOrThrow(accounting.prepareAccounting(brokerEventId, fill, prior, ledger))
  assert.deepEqual(after, before)
  assert.deepEqual(Result.getOrThrow(accounting.rebuildAccountingLedger(before.transaction, ledger)), before.ledger)
  return { transaction: before.transaction, fill, prior }
})
for (const amount of ['0', '2300', '-2300']) {
  assert.deepEqual(
    accounting.brokerFeeLedgerPlan('benchmark-account', 'fee', amount, ledger),
    baseline.brokerFeeLedgerPlan('benchmark-account', 'fee', amount, ledger),
  )
  assert.deepEqual(
    accounting.cashSettlementLedgerPlan('benchmark-account', 'settlement', amount, ledger),
    baseline.cashSettlementLedgerPlan('benchmark-account', 'settlement', amount, ledger),
  )
}
for (const amount of ['0', '2300']) {
  assert.deepEqual(
    accounting.coinFeeLedgerPlan('benchmark-account', 'coin-fee', 'BTC/USD', amount, ledger),
    baseline.coinFeeLedgerPlan('benchmark-account', 'coin-fee', 'BTC/USD', amount, ledger),
  )
}
const verified = Result.getOrThrow(verifyAccountingHistory(history, ledger))
assert.deepEqual(verified, Result.getOrThrow(baselineAlgebra.verifyAccountingHistory(history, ledger)))
const outputDigest = sha256(
  JSON.stringify(verified, (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
)
const timings = { baseline: [] as number[], candidate: [] as number[] }
for (let sample = 0; sample < 40; sample++) {
  for (const name of sample % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)) {
    const start = performance.now()
    const result = Result.getOrThrow(
      name === 'baseline'
        ? baselineAlgebra.verifyAccountingHistory(history, ledger)
        : verifyAccountingHistory(history, ledger),
    )
    const elapsed = performance.now() - start
    assert.equal(result.length, history.length)
    if (sample >= 10) timings[name].push(elapsed)
  }
}
const percentile = (values: readonly number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0
const before = percentile(timings.baseline, 0.5)
const after = percentile(timings.candidate, 0.5)
console.log(
  JSON.stringify({
    node: process.version,
    historyCount: history.length,
    warmupSamples: 10,
    measuredSamples: timings.baseline.length,
    outputDigest,
    baselineMedianMs: before,
    candidateMedianMs: after,
    baselineP95Ms: percentile(timings.baseline, 0.95),
    candidateP95Ms: percentile(timings.candidate, 0.95),
    reductionPercent: (1 - after / before) * 100,
    limitation: 'Synthetic mixed accounting history; PostgreSQL, TigerBeetle and live pass latency are not measured',
  }),
)
