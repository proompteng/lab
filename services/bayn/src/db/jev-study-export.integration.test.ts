import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, Path, Redacted } from 'effect'

import { sha256 } from '../hash'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { exportJevStudySession } from '../jev/study-export'
import { PostgresClientLive } from './postgres-client'

const testUrl = process.env['BAYN_TEST_POSTGRES_URL']
const postgresTest = testUrl === undefined ? test.skip : test

postgresTest(
  'exports a complete read-only cut with pending batches and rejects overwrite or corrupt source',
  async () => {
    if (testUrl === undefined) throw new Error('PostgreSQL test URL is unavailable')
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Study export tests require a local _test database')
    const schema = `study_export_${randomUUID().replaceAll('-', '')}`
    url.searchParams.set('options', `-c search_path=${schema}`)
    const evidence = nativeJevDecisionEvidence()
    const management = nativeJevDecisionEvidence(nativeJevFixture(JevPurpose.Manage), 'hold')
    const plan = evidence.batchPlan
    const accountId = evidence.observation.portfolio.brokerState.account.accountId
    const sessionDate = evidence.observation.manifest.sessionDate
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const fs = yield* FileSystem.FileSystem
          const paths = yield* Path.Path
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-study-export-' })
          yield* sql.unsafe(`CREATE SCHEMA ${schema}`)
          yield* Effect.addFinalizer(() => sql.unsafe(`DROP SCHEMA ${schema} CASCADE`).pipe(Effect.orDie))
          yield* sql`CREATE TABLE autonomous_cycles (
          cycle_id text PRIMARY KEY, account_id text, execution_session_date date, strategy_name text,
          strategy_protocol_hash text, state text, decision_hash text
        )`
          yield* sql`CREATE TABLE jev_batch_plans (
          batch_id text PRIMARY KEY, cycle_id text, observation_hash text, payload jsonb
        )`
          yield* sql`CREATE TABLE jev_batch_results (batch_id text PRIMARY KEY, payload jsonb)`
          yield* sql`CREATE TABLE intraday_candidate_observations (content_hash text PRIMARY KEY, payload jsonb)`
          yield* sql`INSERT INTO autonomous_cycles VALUES (${plan.cycleId}, ${accountId}, ${sessionDate}::date,
          'jev', ${'a'.repeat(64)}, 'COMPLETED', NULL)`
          // A no-batch cycle must remain in the session denominator; a foreign account must not enter it.
          yield* sql`INSERT INTO autonomous_cycles VALUES (${'b'.repeat(64)}, ${accountId}, ${sessionDate}::date,
          'jev', ${'a'.repeat(64)}, 'BLOCKED', NULL), (${'c'.repeat(64)}, 'foreign', ${sessionDate}::date,
          'jev', ${'a'.repeat(64)}, 'COMPLETED', NULL)`
          for (const batch of [evidence, management]) {
            const batchPlan = batch.batchPlan
            yield* sql`INSERT INTO jev_batch_plans VALUES (${batchPlan.batchId}, ${batchPlan.cycleId}, ${batchPlan.observationHash}, ${sql.json(batchPlan)})`
            yield* sql`INSERT INTO intraday_candidate_observations VALUES (${batchPlan.observationHash}, ${sql.json(batch.observation)})`
          }
          const pendingPath = paths.join(directory, 'pending')
          const pending = yield* exportJevStudySession(sql, accountId, sessionDate, pendingPath)
          expect(pending).toMatchObject({
            cycleCount: 2,
            batchCount: 2,
            entryBatchCount: 1,
            managementBatchCount: 1,
            pendingResultCount: 2,
            qualification: 'UNQUALIFIED',
            controllerCoverage: 'UNKNOWN',
          })
          const data = yield* fs.readFileString(paths.join(pendingPath, 'batches.ndjson'))
          expect(sha256(data)).toBe(pending.dataSha256)
          expect(new TextEncoder().encode(data).byteLength).toBe(pending.bytes)
          const lines = data
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line))
          expect(lines).toHaveLength(3)
          expect(lines[0].cycles).toHaveLength(2)
          expect(lines.slice(1).map((line) => line.batchId)).toEqual(
            [plan.batchId, management.batchPlan.batchId].sort(),
          )
          expect(lines.slice(1).every((line) => line.result === null)).toBe(true)
          expect((yield* fs.stat(paths.join(pendingPath, 'batches.ndjson'))).mode & 0o777).toBe(0o600)
          expect((yield* fs.stat(pendingPath)).mode & 0o777).toBe(0o700)
          expect((yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, pendingPath)))._tag).toBe(
            'Failure',
          )
          expect(yield* fs.readFileString(paths.join(pendingPath, 'batches.ndjson'))).toBe(data)
          for (const batch of [evidence, management])
            yield* sql`INSERT INTO jev_batch_results VALUES (${batch.batchPlan.batchId}, ${sql.json(batch.batchResult)})`
          const completed = yield* exportJevStudySession(
            sql,
            accountId,
            sessionDate,
            paths.join(directory, 'completed'),
          )
          expect(completed.pendingResultCount).toBe(0)
          expect(completed.dataSha256).not.toBe(pending.dataSha256)
          yield* sql`UPDATE intraday_candidate_observations SET payload = ${sql.json({ ...evidence.observation, observedAt: '2026-09-18T15:31:02.000Z' })}`
          const corruptPath = paths.join(directory, 'corrupt')
          expect((yield* Effect.result(exportJevStudySession(sql, accountId, sessionDate, corruptPath)))._tag).toBe(
            'Failure',
          )
          expect(yield* fs.exists(paths.join(corruptPath, 'receipt.json'))).toBe(false)
          // The export cannot leave its pooled connection in a read-only transaction after failure.
          yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED' WHERE cycle_id = ${plan.cycleId}`
        }),
      ).pipe(
        Effect.provide(
          PostgresClientLive({
            operationTimeoutMs: 30_000,
            postgres: { url: Redacted.make(url.toString()), tls: false, caPath: '/unused' },
          }).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    )
  },
)
