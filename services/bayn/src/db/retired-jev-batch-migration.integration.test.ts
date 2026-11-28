import { expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Result } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'

import settleRetiredBatches, { settleRetiredJevBatch } from '../../migrations/0190_settle_retired_jev_batches'
import batchTables from '../../migrations/0078_jev_batches'
import batchV3 from '../../migrations/0084_jev_entry_batch_plan_v3'
import resolutionTable from '../../migrations/0077_jev_evaluation_resolution'
import { canonicalHashV1Result } from '../hash'
import { decodeJevBatchPlan, JevCandidateResultStatus } from '../jev/batch'
import { decodeJevResolution } from '../jev/resolution'
import { baynTestPostgresUrl } from '../test-environment.test-support'

const hash = (input: unknown) => Result.getOrThrow(canonicalHashV1Result(input))
const observedAt = '2026-09-28T14:24:38.364Z'
const expiresAt = '2026-09-28T14:24:48.364Z'
const completedAt = '2026-11-09T06:00:00.000Z'
const binding = {
  cycleId: '1'.repeat(64),
  authorityGenerationHash: '2'.repeat(64),
  snapshotId: '3'.repeat(64),
  observedAt,
  expiresAt,
}
const requestMaterial = {
  schemaVersion: 'bayn.jev-evaluation-request.v1',
  ...binding,
  symbol: 'IWM',
  requestHash: hash({ retained: true }),
  request: { retained: true },
}
const request = { ...requestMaterial, requestId: hash(requestMaterial) }
const planMaterial = {
  schemaVersion: 'bayn.jev-batch-plan.v3',
  ...binding,
  observationHash: '4'.repeat(64),
  protocolHash: '5'.repeat(64),
  questionSetHash: '6'.repeat(64),
  candidates: [
    { status: 'EXCLUDED', symbol: 'AAPL', reason: 'not-ready', message: 'Retained exclusion' },
    { status: 'REQUESTED', symbol: 'IWM', request },
  ],
}
const retiredBatchFixture = { ...planMaterial, batchId: hash(planMaterial) }
const retiredClaimFixture = { request_id: request.requestId, payload: request, receipt: null, resolution: null }

test('the retired plan reproduces the current settlement decoder failure', () => {
  expect(Result.isFailure(decodeJevBatchPlan(retiredBatchFixture))).toBe(true)
})

test('retired settlement distinguishes no claim from an abandoned claim without fabricating a receipt or cost', () => {
  const unclaimed = Result.getOrThrow(settleRetiredJevBatch(retiredBatchFixture, [], completedAt))
  expect(unclaimed.result.candidates).toEqual([
    { status: JevCandidateResultStatus.Excluded, symbol: 'AAPL' },
    { status: JevCandidateResultStatus.Unattempted, symbol: 'IWM', requestId: request.requestId },
  ])
  expect(unclaimed.resolutions).toEqual([])
  const claimed = Result.getOrThrow(settleRetiredJevBatch(retiredBatchFixture, [retiredClaimFixture], completedAt))
  expect(claimed.result.candidates[1]).toMatchObject({
    status: 'RESOLVED',
    receipt: null,
    resolution: { status: 'ABANDONED' },
  })
  const resolution = claimed.resolutions[0]
  expect(Result.isSuccess(decodeJevResolution(request, null, resolution))).toBe(true)
  expect(
    Result.getOrThrow(
      settleRetiredJevBatch(retiredBatchFixture, [{ ...retiredClaimFixture, resolution }], completedAt),
    ),
  ).toEqual(claimed)
})

test('retired settlement rejects live windows, changed bytes, mismatched claims and unhandled provider evidence', () => {
  expect(Result.isFailure(settleRetiredJevBatch(retiredBatchFixture, [], observedAt))).toBe(true)
  expect(
    Result.isFailure(
      settleRetiredJevBatch({ ...retiredBatchFixture, questionSetHash: '7'.repeat(64) }, [], completedAt),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      settleRetiredJevBatch(
        retiredBatchFixture,
        [{ ...retiredClaimFixture, payload: { ...request, requestHash: '7'.repeat(64) } }],
        completedAt,
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      settleRetiredJevBatch(retiredBatchFixture, [{ ...retiredClaimFixture, receipt: {} }], completedAt),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      settleRetiredJevBatch(retiredBatchFixture, [{ ...retiredClaimFixture, request_id: '7'.repeat(64) }], completedAt),
    ),
  ).toBe(true)
})

const integration = baynTestPostgresUrl === undefined ? test.skip : test
const url = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55497/bayn_test'
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('Retired batch migration tests require an isolated local _test database')
const client = PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }).pipe(
  Layer.provideMerge(NodeServices.layer),
)

integration.each([false, true])(
  'retired migration preserves immutable bytes and closes only verified history (receipt=%s)',
  async (hasReceipt) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$`
        yield* sql`CREATE TABLE autonomous_cycles (cycle_id text PRIMARY KEY, state text, terminal_at timestamptz)`
        yield* sql`CREATE TABLE authority_generations (generation_hash text PRIMARY KEY)`
        yield* sql`CREATE TABLE intraday_candidate_observations (content_hash text PRIMARY KEY)`
        yield* sql`CREATE TABLE jev_evaluation_requests (request_id text PRIMARY KEY, payload jsonb)`
        yield* sql`CREATE TABLE jev_evaluation_receipts (request_id text PRIMARY KEY REFERENCES jev_evaluation_requests, receipt_hash text NOT NULL, payload jsonb)`
        yield* resolutionTable
        yield* batchTables
        yield* batchV3
        yield* sql`INSERT INTO autonomous_cycles VALUES (${binding.cycleId},'COMPLETED',${expiresAt})`
        yield* sql`INSERT INTO authority_generations VALUES (${binding.authorityGenerationHash})`
        yield* sql`INSERT INTO intraday_candidate_observations VALUES (${planMaterial.observationHash})`
        yield* sql`INSERT INTO jev_evaluation_requests VALUES (${request.requestId},${sql.json(request)})`
        yield* sql`INSERT INTO jev_batch_plans (batch_id,cycle_id,authority_generation_hash,observation_hash,payload)
      VALUES (${retiredBatchFixture.batchId},${binding.cycleId},${binding.authorityGenerationHash},${planMaterial.observationHash},${sql.json(retiredBatchFixture)})`
        if (hasReceipt)
          yield* sql`INSERT INTO jev_evaluation_receipts VALUES (${request.requestId},${'9'.repeat(64)},'{}')`
        const before = yield* sql`SELECT payload FROM jev_batch_plans`
        const requestBefore = yield* sql`SELECT payload FROM jev_evaluation_requests`
        if (!hasReceipt) {
          const interrupted = yield* sql
            .withTransaction(
              settleRetiredBatches.pipe(Effect.andThen(Effect.fail('interrupted migration acknowledgement'))),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(interrupted)).toBe(true)
          expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
          expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([])
        }
        const outcome = yield* sql.withTransaction(settleRetiredBatches).pipe(Effect.result)
        expect(Result.isFailure(outcome)).toBe(hasReceipt)
        expect(yield* sql`SELECT payload FROM jev_batch_plans`).toEqual(before)
        expect(yield* sql`SELECT payload FROM jev_evaluation_requests`).toEqual(requestBefore)
        if (hasReceipt) {
          expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
          expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([])
        } else {
          expect(
            yield* sql`SELECT payload->'candidates'->1->'resolution'->>'status' AS status FROM jev_batch_results`,
          ).toEqual([{ status: 'ABANDONED' }])
          expect(yield* sql`SELECT payload->>'status' AS status FROM jev_evaluation_resolutions`).toEqual([
            { status: 'ABANDONED' },
          ])
          yield* sql.withTransaction(settleRetiredBatches)
          expect(yield* sql`SELECT count(*)::int AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
          expect(Result.isFailure(yield* sql`UPDATE jev_batch_plans SET payload=payload`.pipe(Effect.result))).toBe(
            true,
          )
        }
      }).pipe(Effect.provide(client)),
    )
  },
)
