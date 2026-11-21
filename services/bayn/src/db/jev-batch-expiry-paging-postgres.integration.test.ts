import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevPurpose } from '../jev/portfolio'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { sha256 } from '../hash'
import { Authority } from '../execution/contracts'
import { JevCandidatePlanStatus, JevBatchPlanVersion } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { prepareJevTradingSignalBatch } from '../jev/trading-signals'
import { makeOwnedJevObservation } from '../jev/observation'
import { nativeJevFixture } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevInferenceWorkStore } from './jev-inference-work-postgres'
import { JevInferenceWorkStore } from '../jev/inference-work'
import { streamingSnapshotReference } from '../market-data/streaming/reference'
import {
  describeJevBatchPostgres,
  atObservation,
  observed,
  plan,
  premiums,
  replayAccountId,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

describeJevBatchPostgres((postgres) => {
  test('expense ownership settles more than 64 expired jobs while current prepared work remains discoverable', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const expenses = makeInferenceExpenseStore(sql, replayAccountId)
        let expiredRequests = 0
        let blockedRequestId: string | undefined
        const admitAt = (at: number, generation = plan.authorityGenerationHash) =>
          Effect.gen(function* () {
            const source = nativeJevFixture(
              JevPurpose.Entry,
              utcInstantFromEpochMillis(at),
              replayAccountId,
              defaultJevProtocolDocument,
              'a'.repeat(64),
              premiums,
            )
            const r = {
              ...source.portfolio.brokerState.reconciliation,
              reconciliationId: sha256(`streaming-expiry-reconciliation:${at}`),
            }
            const observation = yield* Effect.fromResult(
              makeOwnedJevObservation({
                ...source.input,
                authorityGenerationHash: generation,
                portfolio: { ...source.portfolio, brokerState: { ...source.portfolio.brokerState, reconciliation: r } },
              }),
            )
            const batch = yield* Effect.fromResult(
              prepareJevTradingSignalBatch(
                observation,
                utcInstantFromEpochMillis(at + source.protocol.inferenceValidityMs),
                JevBatchPlanVersion.V8,
              ),
            )
            yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${utcInstantFromEpochMillis(at)}::timestamptz
            WHERE account_id = ${replayAccountId}`
            yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash,
            observed_hash, content_hash, status, discrepancies, reconciled_at)
            VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash},
              ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt}) ON CONFLICT DO NOTHING`
            yield* TestClock.setTime(at)
            yield* batches.begin(batch, {
              deferProviderDispatch: true,
              sourceReference: streamingSnapshotReference(source.snapshot),
            })
            return batch.plan
          })
        for (let index = 0; index < 65; index += 1) {
          const expiredPlan = yield* admitAt(observed + index)
          if (index === 0) {
            const candidate = expiredPlan.candidates.find(({ status }) => status === JevCandidatePlanStatus.Requested)
            if (candidate?.status !== JevCandidatePlanStatus.Requested)
              throw new Error('Recovery fixture needs an admitted request')
            blockedRequestId = candidate.request.requestId
          }
          expiredRequests += expiredPlan.candidates.filter(
            ({ status }) => status === JevCandidatePlanStatus.Requested,
          ).length
        }
        const currentGeneration = 'd'.repeat(64)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${currentGeneration}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 2, ${utcInstantFromEpochMillis(observed + 60_000)})`
        const current = yield* admitAt(observed + 60_000, currentGeneration)
        if (blockedRequestId === undefined) throw new Error('Recovery fixture needs a first expired request')
        yield* sql`CREATE TABLE blocked_expiry_request (request_id text PRIMARY KEY)`
        yield* sql`CREATE SEQUENCE blocked_expiry_attempts`
        yield* sql`INSERT INTO blocked_expiry_request VALUES (${blockedRequestId})`
        yield* sql`CREATE FUNCTION reject_blocked_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM blocked_expiry_request WHERE request_id = NEW.request_id) THEN
              PERFORM nextval('blocked_expiry_attempts');
              RAISE EXCEPTION 'injected historical expiry failure';
            END IF;
            RETURN NEW;
          END $$`
        yield* sql`CREATE TRIGGER reject_blocked_expiry BEFORE INSERT ON jev_evaluation_resolutions
          FOR EACH ROW EXECUTE FUNCTION reject_blocked_expiry()`
        expect(yield* work.pending(plan.authorityGenerationHash)).toEqual([])
        expect((yield* work.pending(currentGeneration)).map(({ jobId }) => jobId)).toEqual([current.batchId])
        expect(yield* work.settleExpired('unrelated-account')).toEqual({ sealed: 0, failed: 0, remaining: false })
        expect(yield* expenses.settleExpiredInferenceWork).toEqual({
          sealed: 63,
          failed: 1,
          remaining: true,
          nextAttemptAt: utcInstantFromEpochMillis(observed + 90_000),
        })
        expect((yield* work.pending(currentGeneration)).map(({ jobId }) => jobId)).toEqual([current.batchId])
        for (let event = 0; event < 100; event += 1)
          expect(yield* expenses.settleExpiredInferenceWork).toEqual({
            sealed: 0,
            failed: 0,
            remaining: true,
            nextAttemptAt: `${utcInstantFromEpochMillis(observed + 90_000).slice(0, -1)}000Z`,
          })
        expect(yield* sql`SELECT last_value::integer AS attempts FROM blocked_expiry_attempts`).toEqual([
          { attempts: 1 },
        ])
        // A replacement adapter resumes the durable cursor, without relying on a
        // process-local hint or re-entering an old financial cycle.
        const replacement = yield* makeJevInferenceWorkStore
        expect(yield* replacement.settleExpired(replayAccountId)).toEqual({
          sealed: 0,
          failed: 0,
          remaining: true,
          nextAttemptAt: `${utcInstantFromEpochMillis(observed + 90_000).slice(0, -1)}000Z`,
        })
        const fresh = yield* admitAt(observed + 90_000, currentGeneration)
        expect(yield* replacement.settleExpired(replayAccountId)).toEqual({
          sealed: 2,
          failed: 0,
          remaining: true,
        })
        yield* sql`DELETE FROM blocked_expiry_request`
        expect(yield* replacement.settleExpired(replayAccountId)).toEqual({
          sealed: 1,
          failed: 0,
          remaining: false,
        })
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 66 }])
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions
          WHERE payload->>'status' = 'ABANDONED'`,
        ).toEqual([
          {
            count:
              expiredRequests +
              current.candidates.filter(({ status }) => status === JevCandidatePlanStatus.Requested).length,
          },
        ])
        expect((yield* replacement.pending(currentGeneration)).map(({ jobId }) => jobId)).toEqual([fresh.batchId])
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, {
          evaluate: () => Effect.die('Expiry recovery must never dispatch providers'),
        }),
      ),
    )
  }, 120_000)
})
