import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { evaluateAdmittedFixture } from '../jev/evaluation.test-support'
import { jevBatchQuestionSetHash } from '../jev/batch'
import { exchangeSessions } from '../market-hours'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'
import { CycleStore } from '../cycle/store/model'
import { Authority } from '../execution/contracts'
import { JevCandidatePlanStatus, JevBatchPlanVersion, JevCandidateResultStatus, makeJevBatchPlan } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeJevObservation } from '../jev/observation'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore } from './jev-batch-postgres'
import { makeJevEvaluationStore } from './jev-evaluation-postgres'
import { readJevEvaluationEvidence } from './jev-evaluation-read'
import {
  describeJevBatchPostgres,
  atObservation,
  first,
  fixture,
  foreignFixture,
  immediateDispatches,
  observed,
  plan,
  requested,
  successful,
  withTestEvaluation,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

const foreignReconciliation = {
  ...foreignFixture.portfolio.brokerState.reconciliation,
  reconciliationId: 'f'.repeat(64),
}
const foreignSource = Result.getOrThrow(
  makeJevObservation({
    ...foreignFixture.input,
    portfolio: {
      ...foreignFixture.portfolio,
      brokerState: { ...foreignFixture.portfolio.brokerState, reconciliation: foreignReconciliation },
    },
  }),
)
const retainForeignReconciliation = (sql: PgClient.PgClient) => {
  const r = foreignReconciliation
  return Effect.gen(function* () {
    yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
      VALUES (${r.accountId},${'f'.repeat(64)},${foreignSource.payload.observedAt})`
    yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at) VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
  })
}
const seedObservationHistory = (sql: PgClient.PgClient) => sql`
  INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
  SELECT md5(n::text) || md5('history-' || n::text), ${plan.cycleId}, history.observed_at,
    jsonb_build_object(
      'schemaVersion', 'bayn.jev-observation.v1',
      'cycleId', ${plan.cycleId}::text,
      'authorityGenerationHash', ${plan.authorityGenerationHash}::text,
      'observedAt', to_char(history.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'manifest', jsonb_build_object(
        'observedAt', to_char(history.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'snapshotId', ${plan.snapshotId}::text,
        'candidateSymbols', jsonb_build_array(${first.symbol}::text),
        'candidateExclusions', '[]'::jsonb
      )
    )
  FROM generate_series(1, 4096) AS n
  CROSS JOIN LATERAL (SELECT ${plan.observedAt}::timestamptz - n * INTERVAL '1 minute' AS observed_at) AS history
`
const expectIndexedObservationLookup = (
  sql: PgClient.PgClient,
  statement: Statement<Record<string, unknown>>,
  expectedRows: number,
) =>
  Effect.gen(function* () {
    const [query, parameters] = statement.compile()
    const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
    const plans = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
        }),
      ),
    )(explanation)
    const root = plans[0]?.['QUERY PLAN'][0]?.Plan
    if (root === undefined) throw new Error('PostgreSQL did not return the observation query plan')
    expect(JSON.stringify(root)).toMatch(/"Index Cond":"[^"]*observed_at/)
    expect(root['Actual Rows']).toBe(expectedRows)
    expect(Number(root['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(2)
    const Scan = Schema.Struct({
      'Relation Name': Schema.optionalKey(Schema.String),
      'Actual Loops': Schema.Number,
      Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    })
    const checkSourceScans = (value: unknown): void => {
      const node = Schema.decodeUnknownSync(Scan)(value)
      if (node['Relation Name'] === 'intraday_candidate_observations')
        expect(node['Actual Loops']).toBeLessThanOrEqual(expectedRows)
      for (const child of node.Plans ?? []) checkSourceScans(child)
    }
    checkSourceScans(root)
  })

describeJevBatchPostgres((postgres) => {
  test('receipt locking uses the indexed cohort before expanding retained candidate history', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('WITH locked_plan AS MATERIALIZED')) lookup = statement
            return statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
        )
        if (lookup === undefined) throw new Error('Completion did not lock the admitted cohort')
        const [query, parameters] = lookup.compile()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Isolate query scaling from immutable source admission and its full market-data payloads.
            yield* sql`CREATE TEMP TABLE jev_batch_plans (
          batch_id text PRIMARY KEY,cycle_id text NOT NULL,authority_generation_hash text NOT NULL,
          observation_hash text NOT NULL,payload jsonb NOT NULL
        ) ON COMMIT DROP`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
          SELECT md5(n::text)||md5('batch-'||n::text),${plan.cycleId},${plan.authorityGenerationHash},
            md5('snapshot-'||n::text)||md5(n::text),
            jsonb_build_object('candidates',jsonb_build_array(jsonb_build_object('request',
              jsonb_build_object('requestId','historical-unrelated-request'))))
          FROM generate_series(1,10000) n`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
          SELECT batch_id,cycle_id,authority_generation_hash,observation_hash,payload
          FROM public.jev_batch_plans WHERE batch_id=${plan.batchId}`
            yield* sql`ANALYZE pg_temp.jev_batch_plans`
            const explained = yield* sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, parameters)
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
                }),
              ),
            )(explained)
            const root = rows[0]?.['QUERY PLAN'][0]?.Plan
            if (root === undefined) throw new Error('Missing receipt-lock query plan')
            expect(root['Actual Rows']).toBe(1)
            expect(JSON.stringify(root)).toMatch(/"Index Cond":"[^"]*batch_id/)
            const scan = Schema.Struct({
              'Node Type': Schema.String,
              Alias: Schema.optionalKey(Schema.String),
              'Actual Loops': Schema.Number,
              Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
            })
            const check = (value: unknown): void => {
              const node = Schema.decodeUnknownSync(scan)(value)
              if (node['Node Type'] === 'Function Scan' && node.Alias === 'candidate')
                expect(node['Actual Loops']).toBe(1)
              for (const child of node.Plans ?? []) check(child)
            }
            check(root)
          }),
        )
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('keeps queued I/O serviceable while reproducing a complete candidate cohort', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const admission = yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
        yield* Effect.forEach(immediateDispatches(admission), evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const sql = yield* PgClient.PgClient
        // Queue a real event-loop turn after SQL replies. TestClock cannot model a socket
        // response being starved by synchronous source reproduction.
        let heartbeat: ReturnType<typeof setImmediate> | undefined
        let serviced = false
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (!statement.compile()[0].includes('matched.matching_request_ids')) return statement
            return withTestEvaluation(statement, () =>
              statement.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    heartbeat = setImmediate(() => {
                      serviced = true
                    })
                  }),
                ),
              ),
            )
          },
        })
        const { evidence } = yield* readJevEvaluationEvidence(
          monitored,
          requested.map((candidate) => candidate.request.requestId),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (heartbeat !== undefined) clearImmediate(heartbeat)
            }),
          ),
        )
        expect(evidence.size).toBe(requested.length)
        expect(heartbeat).toBeDefined()
        expect(serviced).toBe(true)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('reads complete candidate evidence in three queries and transfers its shared observation once', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const stored = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        const sql = yield* PgClient.PgClient
        yield* seedObservationHistory(sql)
        yield* sql`ANALYZE intraday_candidate_observations`
        const queries: string[] = []
        const observations: unknown[] = []
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const [query] = statement.compile()
            if (query.includes('AS matching_request_ids')) lookup = statement
            // Preserve composable predicate fragments; only complete reads execute.
            if (!/^(SELECT|WITH)\b/.test(query.trimStart())) return statement
            return statement.pipe(
              Effect.tap((rows) =>
                Effect.sync(() => {
                  queries.push(query)
                  if (query.includes('intraday_candidate_observations')) observations.push(...rows)
                }),
              ),
            )
          },
        })
        const evaluations = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        const batches = yield* makeJevBatchStore.pipe(
          Effect.provideService(PgClient.PgClient, monitored),
          Effect.provideService(JevEvaluationStore, evaluations),
        )
        expect(requested.length).toBeGreaterThan(1)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        expect(queries).toHaveLength(3)
        expect(observations).toHaveLength(1)
        if (lookup === undefined) throw new Error('Complete read did not verify its source')
        yield* expectIndexedObservationLookup(sql, lookup, 1)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  for (const table of [
    'jev_evaluation_requests',
    'jev_evaluation_receipts',
    'jev_inference_handoffs',
    'jev_evaluation_resolutions',
    'intraday_candidate_observations',
  ]) {
    test(`complete reads reject tampered independently committed ${table}`, async () => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const stored = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          expect(yield* batches.read(plan.batchId)).toEqual(stored)
          const isObservation = table === 'intraday_candidate_observations'
          const key = isObservation ? 'content_hash' : 'request_id'
          const identity = isObservation ? fixture.observation.contentHash : first.request.requestId
          // The fixture owns a local _test database. Bypass its immutable trigger
          // only to verify the read boundary independently rejects corrupted bytes.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`ALTER TABLE ${sql(table)} DISABLE TRIGGER ${sql(table + '_immutable')}`
              yield* sql`UPDATE ${sql(table)} SET payload = payload || '{"unexpected":true}'::jsonb
                WHERE ${sql(key)} = ${identity}`
              yield* sql`ALTER TABLE ${sql(table)} ENABLE TRIGGER ${sql(table + '_immutable')}`
            }),
          )
          expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
        }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
      )
    })
  }

  test('complete reads require each request source from its exact cycle even when another account shares its snapshot', async () => {
    const session = exchangeSessions(fixture.snapshot.manifest.calendar)[0]
    if (session === undefined) throw new Error('Missing fixture session')
    const executionPolicy = fixture.draft.identity.executionPolicy
    if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
      throw new Error('Fixture requires its original intraday policy')
    const foreignDraft = foreignFixture.draft
    const foreignObservation = foreignSource
    const foreignPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: foreignObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const foreignFirst = foreignPlan.candidates.find(
      (candidate) => candidate.status === JevCandidatePlanStatus.Requested,
    )
    if (foreignFirst?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing foreign candidate')
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        yield* (yield* CycleStore).acquire(foreignDraft, fixture.snapshot.manifest.observedAt)
        yield* retainForeignReconciliation(sql)
        yield* (yield* CandidateObservationStore).record(foreignObservation)
        const stored = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        const foreign = yield* evaluateRecordedJevBatch(foreignPlan, foreignObservation.payload)
        yield* seedObservationHistory(sql)
        yield* sql`ANALYZE intraday_candidate_observations`
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS matching_request_ids')) lookup = statement
            return statement
          },
        })
        const { evidence, observationHashes } = yield* readJevEvaluationEvidence(monitored, [
          first.request.requestId,
          foreignFirst.request.requestId,
        ])
        expect(evidence.size).toBe(2)
        expect(evidence.get(first.request.requestId)?.request).toEqual(first.request)
        expect(evidence.get(foreignFirst.request.requestId)?.request).toEqual(foreignFirst.request)
        expect(observationHashes.toSorted()).toEqual(
          [fixture.observation.contentHash, foreignObservation.contentHash].toSorted(),
        )
        if (lookup === undefined) throw new Error('Combined read did not verify candidate observations')
        yield* expectIndexedObservationLookup(sql, lookup, 2)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        expect(yield* batches.read(foreignPlan.batchId)).toEqual(foreign)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
            yield* sql`UPDATE intraday_candidate_observations
              SET payload = jsonb_set(payload, '{authorityGenerationHash}', to_jsonb(${'c'.repeat(64)}::text))
              WHERE content_hash = ${fixture.observation.contentHash}`
            yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
          }),
        )
        expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
        expect(yield* batches.read(foreignPlan.batchId)).toEqual(foreign)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('complete reads reject a request claim for a sealed unattempted candidate', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
          VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})`
        yield* TestClock.adjust('10 seconds')
        const stored = yield* batches.finish(plan.batchId)
        expect(
          stored.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
        ).toHaveLength(requested.length)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${first.request.requestId}, ${first.request.cycleId},
            ${first.request.authorityGenerationHash}, ${sql.json(first.request)})`
        expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
      }).pipe(atObservation),
    )
  })

  test('generation-wide pending lookup remains exact-cycle scoped and cannot seal another account', async () => {
    const generation = 'c'.repeat(64)
    const nextObservation = Result.getOrThrow(
      makeJevObservation({ ...fixture.input, authorityGenerationHash: generation }),
    )
    const session = exchangeSessions(fixture.snapshot.manifest.calendar)[0]
    if (session === undefined) throw new Error('Missing fixture session')
    const executionPolicy = fixture.draft.identity.executionPolicy
    if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
      throw new Error('Fixture requires its original intraday policy')
    const foreignDraft = foreignFixture.draft
    const foreignObservation = foreignSource
    const nextPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: nextObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const foreignPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: foreignObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        const observations = yield* CandidateObservationStore
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
        VALUES (${generation}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 2, ${plan.observedAt})`
        yield* (yield* CycleStore).acquire(foreignDraft, fixture.snapshot.manifest.observedAt)
        yield* retainForeignReconciliation(sql)
        yield* observations.record(nextObservation)
        yield* observations.record(foreignObservation)
        for (const [candidate, observation] of [
          [plan, fixture.observation],
          [nextPlan, nextObservation],
          [foreignPlan, foreignObservation],
        ] as const)
          yield* beginRecordedJevBatch(batches, candidate, observation.payload)
        expect(yield* batches.pending(plan.cycleId, plan.authorityGenerationHash)).toEqual([plan.batchId])
        expect(yield* batches.pending(plan.cycleId)).toEqual([plan.batchId, nextPlan.batchId].sort())
        yield* TestClock.adjust('10 seconds')
        for (const id of yield* batches.pending(plan.cycleId)) {
          const sealed = yield* batches.finish(id)
          expect(
            sealed.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
          ).toHaveLength(0)
        }
        expect(yield* batches.pending(plan.cycleId)).toEqual([])
        expect(yield* batches.pending(foreignPlan.cycleId)).toEqual([foreignPlan.batchId])
        expect((yield* batches.read(foreignPlan.batchId))?.result).toBeNull()
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_requests`).toEqual([
          {
            count: [plan, nextPlan, foreignPlan].flatMap(({ candidates }) =>
              candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested),
            ).length,
          },
        ])
      }).pipe(atObservation),
    )
  })

  test('finalization and complete reads restrict observations to the indexed cycle and exact observation time', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let lookup: Statement<Record<string, unknown>> | undefined
        let readLookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS matching_symbols')) lookup = statement
            if (statement.compile()[0].includes('AS matching_request_ids')) readLookup = statement
            return statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        const admission = yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
        yield* seedObservationHistory(sql)
        // These timestamps have the same SQL instant, but are not the exact canonical source text.
        // Forged identities must remain irrelevant rather than broadening the evidence set.
        for (const [index, timestamp] of [
          plan.observedAt.replace('Z', '+00:00'),
          plan.observedAt.replace('Z', '000Z'),
        ].entries()) {
          const payload = {
            ...fixture.observation.payload,
            observedAt: timestamp,
            manifest: { ...fixture.observation.payload.manifest, observedAt: timestamp },
          }
          yield* sql`
            INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
            VALUES (${String(index + 1).repeat(64)}, ${plan.cycleId}, ${plan.observedAt}::timestamptz, ${sql.json(payload)})
          `
        }
        yield* sql`ANALYZE intraday_candidate_observations`
        expect((yield* batches.finish(plan.batchId)).result).toBeNull()
        if (lookup === undefined) throw new Error('Finalization did not read candidate observations')
        yield* Effect.forEach(immediateDispatches(admission), evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const stored = yield* batches.finish(plan.batchId)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        if (readLookup === undefined) throw new Error('Complete read did not verify candidate observations')
        for (const statement of [lookup, readLookup]) {
          yield* expectIndexedObservationLookup(sql, statement, 1)
        }
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('rejects a forged matching candidate observation before sealing the batch', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
        yield* sql`INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
          VALUES (${'f'.repeat(64)}, ${plan.cycleId}, ${plan.observedAt}::timestamptz, ${sql.json(fixture.observation.payload)})`
        expect(Result.isFailure(yield* batches.finish(plan.batchId).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('rejects omitted candidates, unrelated source identities and a second deadline for the same observation', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const { batchId: _, ...material } = plan
        for (const change of [
          { observationHash: 'f'.repeat(64) },
          { protocolHash: 'f'.repeat(64) },
          {
            candidates: plan.candidates.slice(1),
            questionSetHash: Result.getOrThrow(jevBatchQuestionSetHash(plan.candidates.slice(1))),
          },
        ]) {
          const altered = Result.getOrThrow(makeJevBatchPlan({ ...material, ...change }))
          expect(
            Result.isFailure(
              yield* beginRecordedJevBatch(store, altered, fixture.observation.payload).pipe(Effect.result),
            ),
          ).toBe(true)
        }
        const saved = yield* beginRecordedJevBatch(store, plan, fixture.observation.payload).pipe(
          Effect.map(({ plan, result }) => ({ plan, result })),
        )
        expect(yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(
          Result.isFailure(
            makeJevTradingSignalBatch({
              observation: fixture.observation.payload,
              expiresAt: utcInstantFromEpochMillis(observed + 6000),
              planVersion: JevBatchPlanVersion.V8,
            }),
          ),
        ).toBe(true)
        expect(yield* (yield* PgClient.PgClient)`SELECT batch_id FROM jev_batch_plans`).toEqual([
          { batch_id: plan.batchId },
        ])
      }).pipe(atObservation),
    )
  })

  test('batch mutation rejects ambient transactions and every evidence table rejects mutation', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevBatchStore
        expect(
          Result.isFailure(
            yield* sql
              .withTransaction(beginRecordedJevBatch(store, plan, fixture.observation.payload))
              .pipe(Effect.result),
          ),
        ).toBe(true)
        const stored = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        expect(Result.isFailure(yield* sql.withTransaction(store.finish(plan.batchId)).pipe(Effect.result))).toBe(true)
        for (const operation of [
          sql`UPDATE jev_batch_plans SET payload = payload`,
          sql`DELETE FROM jev_batch_plans`,
          sql`TRUNCATE jev_batch_plans CASCADE`,
          sql`UPDATE jev_batch_results SET payload = payload`,
          sql`DELETE FROM jev_batch_results`,
          sql`TRUNCATE jev_batch_results`,
        ])
          expect(Result.isFailure(yield* operation.pipe(Effect.result))).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(stored)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })
})
