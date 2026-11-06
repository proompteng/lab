import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'
import { isSqlError } from 'effect/sql/SqlError'

import { sha256 } from '../hash'
import { ExpiredIntentRiskDecision, expiredRiskClockRejection } from '../execution/risk-clock'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { postgresMigrations } from './postgres-migrations'
import { formalModelExecutable, runFormalModel } from '../system-assessment/formal-model.test-support'
import { makePersistenceDocumentFixture } from '../system-assessment/decision-persistence.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { Authority, KillState } from '../execution/contracts'
import { IntentStore } from '../execution/intents/domain'
import { IntentStoreLive } from '../execution/intents/postgres'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { makeCycleStore, withWriterFenceCycleStore } from '../cycle/store/postgres'
import { CycleStoreError } from '../cycle/store/model'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_risk_test'
const at = (fraction: string) => `2026-11-04T19:22:20.${fraction}Z`

const cases: ReadonlyArray<{
  readonly name: string
  readonly decided: string
  readonly expires: string
  readonly updated: string
  readonly checked: string
  readonly rejection: 'EXPIRED' | 'NOT_YET_VALID' | null
}> = [
  { name: 'current', decided: '000000', expires: '010000', updated: '001000', checked: '009999', rejection: null },
  {
    name: 'expired at database check',
    decided: '000000',
    expires: '010000',
    updated: '001000',
    checked: '010000',
    rejection: 'EXPIRED',
  },
  {
    name: 'expired at update',
    decided: '000000',
    expires: '010000',
    updated: '010000',
    checked: '009999',
    rejection: 'EXPIRED',
  },
  {
    name: 'decision after update',
    decided: '002000',
    expires: '010000',
    updated: '001000',
    checked: '003000',
    rejection: 'NOT_YET_VALID',
  },
  {
    name: 'decision after database clock',
    decided: '002000',
    expires: '010000',
    updated: '003000',
    checked: '001999',
    rejection: 'NOT_YET_VALID',
  },
]

integration('PostgreSQL risk-clock rejection evidence', () => {
  let runtime: ReturnType<typeof makeRuntime>
  const makeRuntime = () =>
    ManagedRuntime.make(
      IntentStoreLive.pipe(
        Layer.provideMerge(WriterFenceLive),
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
        Layer.provideMerge(NodeServices.layer),
      ),
    )

  beforeAll(async () => {
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Risk-clock tests require an isolated local _test database')
    runtime = makeRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  }, 30_000)
  afterAll(async () => runtime?.dispose())

  test.each([...cases])(
    '$name preserves the exact guard and retains actionable rejection evidence',
    async (scenario) => {
      if (formalModelExecutable !== undefined)
        expect(
          runFormalModel([
            {
              operation: 'intentRiskClockRejection',
              decided: String(Number(scenario.decided)),
              expires: String(Number(scenario.expires)),
              updated: String(Number(scenario.updated)),
              checked: String(Number(scenario.checked)),
            },
          ]),
        ).toEqual([scenario.rejection ?? 'CURRENT'])
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const intentId = sha256(scenario.name)
              const decisionId = sha256(`${scenario.name}:risk`)
              const accountId = `replay-${intentId}`
              yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
          VALUES (${accountId}, ${intentId}, ${at(scenario.checked)})`
              yield* sql`CREATE TEMP TABLE risk_decisions (
          decision_id text, intent_id text, outcome text, decided_at timestamptz, expires_at timestamptz
        ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE risk_clock_probe (
          intent_id text, account_id text, state text, risk_decision_id text, terminal_outcome text,
          state_version integer, created_at timestamptz, updated_at timestamptz
        ) ON COMMIT DROP`
              yield* sql`CREATE TRIGGER risk_clock_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON risk_clock_probe
          FOR EACH ROW EXECUTE FUNCTION public.enforce_intent_transition()`
              yield* sql`INSERT INTO risk_clock_probe VALUES (${intentId}, ${accountId}, 'PLANNED', NULL, NULL, 1,
          ${at('000000')}, ${at('000000')})`
              yield* sql`INSERT INTO risk_decisions VALUES (${decisionId}, ${intentId}, 'APPROVED',
          ${at(scenario.decided)}, ${at(scenario.expires)})`
              const result = yield* sql
                .withTransaction(sql`UPDATE risk_clock_probe SET state='APPROVED',
          risk_decision_id=${decisionId}, state_version=2, updated_at=${at(scenario.updated)}`)
                .pipe(Effect.result)
              if (scenario.rejection === null) expect(Result.isSuccess(result)).toBe(true)
              else {
                if (
                  Result.isSuccess(result) ||
                  !isSqlError(result.failure) ||
                  result.failure.reason._tag !== 'ConstraintError'
                )
                  throw new Error('Expected the production current-risk guard to reject this transition')
                const failure = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ code: Schema.String, constraint: Schema.String, detail: Schema.String }),
                )(result.failure.reason.cause)
                expect(failure.code).toBe('23514')
                expect(failure.constraint).toBe('intents_current_risk_decision')
                expect(JSON.parse(failure.detail)).toMatchObject({
                  schemaVersion: 'bayn.intent-risk-clock-rejection.v1',
                  violation: scenario.rejection,
                  intentId,
                  decisionId,
                })
                const expected = {
                  intentId,
                  decisionId,
                  decidedAt: new Date(at(scenario.decided)).toISOString(),
                  expiresAt: new Date(at(scenario.expires)).toISOString(),
                }
                const expired = expiredRiskClockRejection(result.failure, expected)
                if (scenario.rejection === 'EXPIRED') {
                  expect(expired).toBeInstanceOf(ExpiredIntentRiskDecision)
                  expect(expired?.evidence.checkedAt).toBe(at(scenario.checked))
                } else expect(expired).toBeUndefined()
                expect(
                  expiredRiskClockRejection(result.failure, { ...expected, decisionId: sha256('foreign decision') }),
                ).toBeUndefined()
                expect(expiredRiskClockRejection(result.failure, { ...expected, expiresAt: at('011') })).toBeUndefined()
              }
              expect(yield* sql`SELECT state FROM risk_clock_probe`).toEqual([
                { state: scenario.rejection === null ? 'APPROVED' : 'PLANNED' },
              ])
            }),
          )
        }),
      )
    },
  )

  test.each([false, true])(
    'the real entry transaction is atomic when risk expires during binding=%s',
    async (expire) => {
      const account = `replay-${sha256(`risk-binding:${expire}`)}`
      const native = nativeJevFixture(JevPurpose.Entry, undefined, account)
      const document = await Effect.runPromise(makePersistenceDocumentFixture(account, 2))
      const context = document.bindings.riskContext
      const target = document.strategyDecision
      if (context === undefined || target?.schemaVersion !== 'bayn.jev-entry-target.v7')
        throw new Error('Missing complete native entry risk context')
      expect(document.dispatchable).toBe(true)
      expect(document.orderedIntentIds.length).toBeGreaterThan(0)
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
          const r = native.portfolio.brokerState.reconciliation
          const generation = document.bindings.authorityGenerationHash
          const initialGeneration = sha256('risk-binding:initial-generation')
          const initialAt = new Date(Date.parse(native.observation.payload.observedAt) - 1000).toISOString()
          yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
        VALUES (${account}, ${sha256(account)}, ${document.createdAt})`
          yield* sql`INSERT INTO reconciliations(reconciliation_id, schema_version, account_id, expected_hash,
        observed_hash, content_hash, status, discrepancies, reconciled_at)
        VALUES (${r.reconciliationId},${r.schemaVersion},${account},${r.expectedHash},${r.observedHash},
          ${r.contentHash},${r.status},'[]'::jsonb,${r.reconciledAt})`
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
        VALUES (${initialGeneration},'bayn.authority-generation-history.v1',${Authority.Observe},1,${initialAt})`
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,activation_schema_version,
        previous_generation_hash,maximum,authority_version,activation_source_revision,activation_image_repository,
        activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,
        strategy_parameter_schema_version,strategy_protocol_hash,account_id,broker_identity_schema_version,
        broker_identity_hash,broker_provider,broker_environment,risk_policy_hash,proof_plan_hash,
        reconciliation_id,reconciliation_content_hash,research_plan_hash,activated_at)
        VALUES (${generation},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
          ${initialGeneration},${Authority.Execution},2,${'3'.repeat(40)},'registry.example.test/lab/bayn',
          ${`sha256:${sha256('image')}`},'jev',${sha256('behavior')},${sha256('parameters')},'bayn.jev.protocol.v37',
          ${native.draft.identity.strategyProtocolHash},${account},'bayn.broker-identity.v2',${sha256('broker')},
          'alpaca','sandbox',${document.bindings.policyHash},${sha256('proof')},${r.reconciliationId},${r.contentHash},
          ${sha256('plan')},${context.authority.updatedAt})`
          yield* sql`INSERT INTO authority_state(schema_version,generation_hash,maximum,effective,kill_state,version,updated_at)
        VALUES ('bayn.paper-authority.v1',${initialGeneration},${Authority.Observe},${Authority.Observe},${KillState.Clear},1,${initialAt})`
          yield* sql`UPDATE authority_state SET generation_hash=${generation},maximum=${Authority.Execution},
        effective=${Authority.Execution},version=2,updated_at=${context.authority.updatedAt} WHERE singleton`
          yield* sql`INSERT INTO valuations(valuation_id,schema_version,account_id,source_hash,cash_micros,
        long_market_value_micros,short_market_value_micros,equity_micros,as_of)
        VALUES (${sha256('valuation')},'bayn.paper-valuation.v1',${account},${sha256('valuation source')},
          ${context.dayStartEquityMicros},0,0,${context.dayStartEquityMicros},${r.reconciledAt})`
          for (const market of [document.bindings.decisionMarketData, document.bindings.executionMarketData]) {
            if (market?.schemaVersion !== 'bayn.execution-market-data-binding.v3')
              throw new Error('Missing streaming binding')
            yield* sql`INSERT INTO streaming_snapshot_references(snapshot_id,schema_version,content_hash,observed_at,manifest)
          VALUES (${market.snapshotId},'bayn.streaming-snapshot-reference.v1',${market.contentHash},${market.observedAt},
          ${sql.json({
            schemaVersion: 'bayn.streaming-market-snapshot.v1',
            streaming: { schemaVersion: 'bayn.streaming-input-cut.v1' },
            snapshotId: market.snapshotId,
            contentHash: market.contentHash,
            observedAt: market.observedAt,
          })}) ON CONFLICT DO NOTHING`
          }
          const raw = yield* makeCycleStore()
          yield* raw.acquire(native.draft, native.observation.payload.observedAt)
          yield* raw.activate(native.draft.identity.cycleId, native.observation.payload.observedAt)
          const { observation, batchPlan, batchResult } = target.evidence
          yield* sql`INSERT INTO intraday_candidate_observations(content_hash,cycle_id,observed_at,payload)
        VALUES (${batchPlan.observationHash},${batchPlan.cycleId},${observation.observedAt},${sql.json(observation)})`
          yield* sql`INSERT INTO jev_batch_plans(batch_id,cycle_id,authority_generation_hash,observation_hash,payload)
        VALUES (${batchPlan.batchId},${batchPlan.cycleId},${generation},${batchPlan.observationHash},${sql.json(batchPlan)})`
          yield* sql`INSERT INTO jev_batch_results(batch_id,result_hash,payload)
        VALUES (${batchPlan.batchId},${batchResult.resultHash},${sql.json(batchResult)})`
          if (expire) {
            yield* sql`CREATE FUNCTION expire_test_risk_at_persistence() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN UPDATE simulated_execution_clocks SET observed_at=NEW.expires_at
            WHERE account_id=(SELECT account_id FROM intents WHERE intent_id=NEW.intent_id); RETURN NEW; END $f$`
            yield* sql`CREATE TRIGGER expire_test_risk AFTER INSERT ON risk_decisions
          FOR EACH ROW EXECUTE FUNCTION expire_test_risk_at_persistence()`
          }
          const before = yield* raw.read(native.draft.identity.cycleId)
          const authorityBefore = yield* sql`SELECT row_to_json(a) AS value FROM authority_state a`
          const historyBefore =
            yield* sql`SELECT row_to_json(g) AS value FROM authority_generations g ORDER BY authority_version`
          const fenced = withWriterFenceCycleStore(raw, yield* WriterFence, yield* IntentStore)
          const result = yield* fenced
            .bindDecision(native.draft.identity.cycleId, document, document.createdAt)
            .pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(expire)
          if (expire) {
            if (Result.isSuccess(result)) throw new Error('Expired risk was admitted')
            expect(result.failure).toBeInstanceOf(CycleStoreError)
            expect(result.failure.failure).toBe('risk-expired')
            expect(result.failure.cause).toBeInstanceOf(ExpiredIntentRiskDecision)
            expect(yield* raw.read(native.draft.identity.cycleId)).toEqual(before)
            expect(Option.isNone(yield* raw.readDecisionDocument(native.draft.identity.cycleId))).toBe(true)
          } else {
            if (Result.isFailure(result)) throw result.failure
            expect(result.success.cycle.bindings.decisionHash).toBe(document.contentHash)
          }
          for (const table of ['autonomous_cycle_shadow_decisions', 'intents', 'risk_decisions']) {
            const rows = yield* sql`SELECT count(*)::integer AS count FROM ${sql(table)}`
            expect(rows).toEqual([
              {
                count: expire
                  ? 0
                  : table === 'autonomous_cycle_shadow_decisions'
                    ? 1
                    : document.orderedIntentIds.length,
              },
            ])
          }
          expect(yield* sql`SELECT row_to_json(a) AS value FROM authority_state a`).toEqual(authorityBefore)
          expect(
            yield* sql`SELECT row_to_json(g) AS value FROM authority_generations g ORDER BY authority_version`,
          ).toEqual(historyBefore)
          expect(
            yield* sql`SELECT observed_at = ${document.createdAt}::timestamptz AS unchanged FROM simulated_execution_clocks
        WHERE account_id=${account}`,
          ).toEqual([{ unchanged: true }])
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
        }),
      )
    },
    30_000,
  )
})
