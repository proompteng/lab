import assert from 'node:assert/strict'
import { Effect, Layer, Logger, ManagedRuntime, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from '../hash.ts'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity.ts'
import { makeReadDiagnostics, projectReadDiagnostic } from '../broker/alpaca/read-diagnostics.ts'

const mode = process.argv[2]
assert.ok(mode === 'default' || mode === 'json')
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: 'synthetic-paper-account',
  }),
)
const evidence = {
  requestId: 'synthetic-request',
  status: 200,
  contentHash: canonicalHashV1({ synthetic: 'response' }),
  observedAt: '2025-06-11T08:00:00.000Z',
}
const account = projectReadDiagnostic('account', {
  accrued_fees: '0.123456789012345678',
  pending_reg_taf_fees: '0.01',
  cash: '987654321.12',
  description: 'SYNTHETIC_PRIVATE_TEXT',
})
const fees = projectReadDiagnostic(
  'fee-activities',
  Array.from({ length: 129 }, (_, index) => ({
    id: `synthetic-fee-${index}`,
    date: '2025-06-10',
    status: 'executed',
    activity_subtype: 'TAF',
    entry_sub_type: 'TAF',
    settle_date: '2025-06-11',
    system_date: '2025-06-10',
    executed_at: '2025-06-11T07:00:00.000Z',
    transaction_time: '2025-06-11T07:00:00.000Z',
    description: 'TAF fee SYNTHETIC_PRIVATE_TEXT',
  })),
)
const runtime = ManagedRuntime.make(
  mode === 'default' ? TestClock.layer() : Layer.merge(TestClock.layer(), Logger.layer([Logger.consoleJson])),
)
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const observe = yield* makeReadDiagnostics(identity)
      yield* observe(account, evidence)
      yield* observe(fees, evidence)
      for (let pass = 0; pass < 20; pass += 1) {
        yield* TestClock.adjust(60_000)
        yield* observe(account, evidence)
      }
    }),
  )
} finally {
  await runtime.dispose()
}
