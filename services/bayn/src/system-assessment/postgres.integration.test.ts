import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { migrationLoader } from '../db/migrations'
import { canonicalJsonV1Result, sha256 } from '../hash'
import { IsoDateSchema, UtcInstantSchema } from '../schemas'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { assessmentFixture, registrationFixture, testHash, withRegistrationCommitments } from './fixtures.test-support'
import {
  assessAndPersistSystem,
  initializeQualificationHistory,
  readPersistedSystemAssessment,
  readSystemRegistration,
  registerSystemQualification,
} from './postgres'
import { persistSystemSourceCut, readSystemSourceCut, SystemSourceCutSchema } from './source-cut'
import { QualificationVerdict } from './assessment'
import {
  readRegisteredFinancialIdentity,
  readSystemCashObservations,
  readSystemControllerPasses,
  readSystemDurableObservations,
  readSystemDecisionAdmissions,
  readSystemExecutionOrders,
} from './capture'
import { makePersistenceDocumentFixture } from './decision-persistence.test-support'
import { OrderStatus } from '../execution/contracts'
import { bracketEvidenceFixture } from './bracket-evidence.test-support'
import { bindExecutionEvidence, captureExecutionOrders } from './execution-evidence'
import { makePostgresMutationStore } from '../execution/mutations/program'
import { WriterFenceLive } from '../execution/writer-fence'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeJevObservation } from '../jev/observation'
import { makeCycleStore } from '../cycle/store/postgres'
import { makeCandidateObservationStore } from '../db/candidate-observation-postgres'
import {
  readReplayExecutionReceipt,
  replayExecutionAssumptions,
  ReplayExecutionReceiptSchema,
} from './replay-execution'

import { validateSystemRegistration } from './policy'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const role = 'bayn_assessment_test_app'
const history = {
  schemaVersion: 'bayn.system-qualification-history.v1',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  historySourceHash: sha256('independent complete history audit'),
  auditedAt: '2026-10-01T00:00:00.000Z',
  attempts: [],
}
const databaseNow = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ now: UtcInstantSchema })))(
    yield* sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error('Database clock is missing')
  return row.now
})
const registerFixture = (value: ReturnType<typeof registrationFixture>) =>
  registerSystemQualification(value, new Set(value.costAllocationPlans.map((plan) => plan.basisSourceHash)))

const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10000,
      postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )

postgres('PostgreSQL prospective system qualification', () => {
  let runtime: ReturnType<typeof makeRuntime>
  let databaseObservedAt: string | undefined
  const registration = () => {
    if (databaseObservedAt === undefined) throw new Error('Database clock must precede fixture construction')
    return {
      ...registrationFixture(new Date(Date.parse(databaseObservedAt) - 1000).toISOString()),
      priorAttemptHash: testHash(history),
    }
  }
  beforeAll(() => {
    const url = baynTestPostgresUrl ?? ''
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('System qualification tests require an isolated local _test database')
    runtime = makeRuntime(url)
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bayn_assessment_test_app') THEN
        CREATE ROLE bayn_assessment_test_app NOLOGIN; END IF; END $$`
        yield* sql`GRANT USAGE ON SCHEMA public TO bayn_assessment_test_app`
        yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO bayn_assessment_test_app`
        yield* sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bayn_assessment_test_app`
        yield* initializeQualificationHistory(history, new Set([history.historySourceHash]))
        databaseObservedAt = yield* databaseNow
      }),
    )
  }, 30000)
  afterAll(async () => {
    if (runtime !== undefined) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP OWNED BY bayn_assessment_test_app`
          yield* sql`DROP ROLE bayn_assessment_test_app`
        }),
      )
      await runtime.dispose()
    }
  })
  const asApplication = <A, E>(program: Effect.Effect<A, E, PgClient.PgClient>) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(`SET LOCAL ROLE ${role}`)
          return yield* program
        }),
      )
    })

  test('registers and replays exact content, while preserving failed attempts and rejecting resets', async () => {
    const first = registration()
    const result = await runtime.runPromise(asApplication(registerFixture(first)))
    expect(await runtime.runPromise(asApplication(registerFixture(first)))).toEqual(result)
    expect(await runtime.runPromise(readSystemRegistration(result.registrationHash))).toEqual(first)
    expect(
      Exit.isFailure(await runtime.runPromiseExit(asApplication(registerFixture({ ...first, attemptIndex: 3 })))),
    ).toBe(true)
    const second = await runtime.runPromise(
      asApplication(
        registerFixture(
          withRegistrationCommitments({ ...first, attemptIndex: 2, priorAttemptHash: result.registrationHash }),
        ),
      ),
    )
    expect(second.registration.attemptIndex).toBe(2)
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          asApplication(registerFixture({ ...first, latencyStressProtocolHash: sha256('retuned') })),
        ),
      ),
    ).toBe(true)
  })

  test('history initialization rejects future audits and database columns that contradict the evidence', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
    const future = { ...history, auditedAt: '2999-01-01T00:00:00.000Z' }
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(initializeQualificationHistory(future, new Set([future.historySourceHash]))),
      ),
    ).toBe(true)
    for (const [count, hash] of [
      [1, testHash(history)],
      [0, sha256('wrong predecessor')],
    ] as const) {
      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const text = Result.getOrThrow(canonicalJsonV1Result(history))
          yield* sql`INSERT INTO system_qualification_origin(program, prior_attempt_count, prior_attempt_hash, history_evidence_text, history_evidence_hash)
          VALUES (${history.program}, ${count}, ${hash}, ${text}, ${testHash(history)})`
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(
      (await runtime.runPromise(initializeQualificationHistory(history, new Set([history.historySourceHash]))))
        .priorAttemptCount,
    ).toBe(0)
  })

  test('concurrent different candidates cannot acquire the same attempt index', async () => {
    const first = registration()
    const candidates = [
      first,
      {
        ...first,
        policies: first.policies.map((policy) => ({
          ...policy,
          promptsHash: policy.policy === 'JEV' ? sha256('different candidate prompt') : policy.promptsHash,
        })),
      },
    ]
    for (const candidate of candidates) expect(Result.isSuccess(validateSystemRegistration(candidate))).toBe(true)
    const exits = await Promise.all(
      candidates.map((input) => runtime.runPromiseExit(asApplication(registerFixture(input)))),
    )
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    expect(exits.filter(Exit.isFailure)).toHaveLength(1)
  })

  test('cost allocation artifacts are required before admission and stored weights cannot be replaced', async () => {
    const first = registration()
    const sources = new Set(first.costAllocationPlans.map((plan) => plan.basisSourceHash))
    const plan = first.costAllocationPlans[0]
    if (plan === undefined) throw new Error('Missing cost plan')
    sources.delete(plan.basisSourceHash)
    expect(
      Exit.isFailure(await runtime.runPromiseExit(asApplication(registerSystemQualification(first, sources)))),
    ).toBe(true)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT registration_hash FROM system_qualification_registrations`).toHaveLength(0)
      }),
    )
    sources.add(plan.basisSourceHash)
    const accepted = await runtime.runPromise(asApplication(registerSystemQualification(first, sources)))
    const changed = {
      ...first,
      costAllocationPlans: first.costAllocationPlans.map((value) => ({
        ...value,
        weights: value.weights.map((weight) => ({ ...weight, weight: '2' })),
      })),
    }
    expect(
      Exit.isFailure(await runtime.runPromiseExit(asApplication(registerSystemQualification(changed, sources)))),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          asApplication(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              const payload = yield* Effect.fromResult(canonicalJsonV1Result(changed))
              yield* sql`UPDATE system_qualification_registrations SET payload_text = ${payload} WHERE registration_hash = ${accepted.registrationHash}`
            }),
          ),
        ),
      ),
    ).toBe(true)
    expect((await runtime.runPromise(readSystemRegistration(accepted.registrationHash))).costAllocationPlans).toEqual(
      first.costAllocationPlans,
    )
  })

  test('application and direct database admission reject substituted or ambiguous deployed controls', async () => {
    const input = registration()
    for (const field of ['strategyHash', 'parametersHash', 'protocolHash'] as const) {
      const changed = {
        ...input,
        policies: input.policies.map((policy) =>
          policy.policy === 'DEPLOYED_BAYN' ? { ...policy, [field]: testHash(`substituted ${field}`) } : policy,
        ),
      }
      expect(Exit.isFailure(await runtime.runPromiseExit(asApplication(registerFixture(changed))))).toBe(true)
    }
    const invalidPolicies = [
      ...(['strategyHash', 'parametersHash', 'protocolHash'] as const).map((field) =>
        input.policies.map((policy) =>
          policy.policy === 'DEPLOYED_BAYN' ? { ...policy, [field]: testHash(`direct substituted ${field}`) } : policy,
        ),
      ),
      input.policies.map((policy) =>
        policy.policy === 'DEPLOYED_BAYN' ? { ...policy, policy: 'REPEATED_MOMENTUM' } : policy,
      ),
      input.policies.map((policy) =>
        policy.policy === 'REPEATED_MOMENTUM' ? { ...policy, policy: 'DEPLOYED_BAYN' } : policy,
      ),
    ]
    for (const policies of invalidPolicies) {
      const payload = Result.getOrThrow(canonicalJsonV1Result({ ...input, policies }))
      const exit = await runtime.runPromiseExit(
        asApplication(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`INSERT INTO system_qualification_registrations
          (registration_hash, program, attempt_index, prior_attempt_hash, registered_at, first_open_at, last_close_at, payload_text)
          VALUES (${sha256(payload)}, ${input.program}, 1, ${input.priorAttemptHash}, ${input.registeredAt},
            ${input.calendar.sessions[0]?.openAt}, ${input.calendar.sessions.at(-1)?.closeAt}, ${payload})`
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql`SELECT registration_hash FROM system_qualification_registrations`
        }),
      ),
    ).toEqual([])
    expect((await runtime.runPromise(asApplication(registerFixture(input)))).registration.attemptIndex).toBe(1)
  })

  test('risk expansion and missing material are rejected before a prospective attempt is admitted', async () => {
    const input = registration()
    const candidate = input.policies.find((policy) => policy.policy === 'JEV')
    if (candidate === undefined) throw new Error('Missing candidate')
    const risk = candidate.riskPolicy
    const invalid = [
      ...(
        [
          'maxOrderNotionalMicros',
          'maxSymbolExposureMicros',
          'maxGrossExposureMicros',
          'maxNetExposureMicros',
          'maxDailyTradedNotionalMicros',
        ] as const
      ).map((key) => ({ ...risk, [key]: (BigInt(risk[key]) + 1n).toString() })),
      { ...risk, maxGrossExposureMicros: null },
      null,
    ]
    for (const riskPolicy of invalid) {
      const changed = {
        ...input,
        policies: input.policies.map((policy) =>
          policy.policy === 'JEV' ? { ...policy, riskPolicy, riskPolicyHash: testHash(riskPolicy) } : policy,
        ),
      }
      expect(
        Exit.isFailure(await runtime.runPromiseExit(asApplication(registerSystemQualification(changed, new Set())))),
      ).toBe(true)
      const payload = Result.getOrThrow(canonicalJsonV1Result(changed))
      expect(
        Exit.isFailure(
          await runtime.runPromiseExit(
            asApplication(
              Effect.gen(function* () {
                const sql = yield* PgClient.PgClient
                yield* sql`INSERT INTO system_qualification_registrations
                (registration_hash, program, attempt_index, prior_attempt_hash, registered_at, first_open_at, last_close_at, payload_text)
                VALUES (${sha256(payload)}, ${input.program}, 1, ${input.priorAttemptHash}, ${input.registeredAt},
                  ${input.calendar.sessions[0]?.openAt}, ${input.calendar.sessions.at(-1)?.closeAt}, ${payload})`
              }),
            ),
          ),
        ),
      ).toBe(true)
    }
    const accepted = await runtime.runPromise(asApplication(registerFixture(input)))
    expect(accepted.registration.attemptIndex).toBe(1)
    const retained = await runtime.runPromise(readSystemRegistration(accepted.registrationHash))
    expect(retained.policies.map((policy) => policy.riskPolicy)).toEqual(
      input.policies.map((policy) => policy.riskPolicy),
    )
  })

  test('an underpriced registered tariff is rejected before any prospective row is written', async () => {
    const input = registration()
    const tariff = replayRateCardFixture({
      jev: { inputMicrosPerMillionTokens: '41999', outputMicrosPerMillionTokens: '0' },
      chart: {
        inputMicrosPerMillionTokens: '1',
        outputMicrosPerMillionTokens: '0',
        cachedInputMicrosPerMillionTokens: '0',
        cacheWriteInputMicrosPerMillionTokens: '0',
      },
    })
    const lastClose = input.calendar.sessions.at(-1)?.closeAt
    if (lastClose === undefined) throw new Error('Missing last session')
    const inferenceRateCard = {
      ...tariff,
      rates: tariff.rates.map((rate) => ({
        ...rate,
        effectiveFrom: input.registeredAt,
        effectiveUntil: new Date(Date.parse(lastClose) + 1).toISOString(),
      })),
    }
    expect(
      Result.isSuccess(
        validateSystemRegistration({
          ...input,
          policies: input.policies.map((policy) => ({
            ...policy,
            inferenceRateCard: {
              ...inferenceRateCard,
              rates: inferenceRateCard.rates.map((rate) =>
                rate.provider === 'typesafe' ? { ...rate, inputMicrosPerMillionTokens: '42000' } : rate,
              ),
            },
          })),
        }),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          asApplication(
            registerFixture({
              ...input,
              policies: input.policies.map((policy) => ({ ...policy, inferenceRateCard })),
            }),
          ),
        ),
      ),
    ).toBe(true)
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql`SELECT registration_hash FROM system_qualification_registrations`
      }),
    )
    expect(rows).toEqual([])
    expect((await runtime.runPromise(asApplication(registerFixture(input)))).registration).toEqual(input)
  })

  test('application role cannot update, remove, truncate, or reinitialize the history', async () => {
    await runtime.runPromise(asApplication(registerFixture(registration())))
    for (const table of ['system_qualification_origin', 'system_qualification_registrations']) {
      for (const query of [
        `DELETE FROM ${table}`,
        `TRUNCATE ${table} CASCADE`,
        table === 'system_qualification_origin'
          ? `UPDATE ${table} SET prior_attempt_count = 0`
          : `UPDATE ${table} SET attempt_index = 1`,
      ]) {
        const exit = await runtime.runPromiseExit(
          asApplication(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* sql.unsafe(query)
            }),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          asApplication(initializeQualificationHistory(history, new Set([history.historySourceHash]))),
        ),
      ),
    ).toBe(true)
  })

  test('the deferred deadline rejects a transaction that crosses the first market open', async () => {
    const first = registration()
    const now = Date.parse(await runtime.runPromise(databaseNow))
    const openAt = new Date(now + 2000).toISOString()
    const closeAt = new Date(now + 3000).toISOString()
    const input = {
      ...first,
      calendar: {
        ...first.calendar,
        sessions: first.calendar.sessions.map((s, i) =>
          i === 0 ? { sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(openAt.slice(0, 10)), openAt, closeAt } : s,
        ),
      },
    }
    const exit = await runtime.runPromiseExit(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* registerFixture(withRegistrationCommitments(input))
          expect(yield* sql`SELECT count(*)::integer AS count FROM system_qualification_registrations`).toEqual([
            { count: 1 },
          ])
          yield* sql`SELECT pg_sleep(2.1)`
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const count = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql`SELECT count(*)::integer AS count FROM system_qualification_registrations`
      }),
    )
    expect(count).toEqual([{ count: 0 }])
  })

  test('database identity checks reject a missing field even when the supplied hash matches', async () => {
    const input = registration()
    const { environment: _environment, ...invalid } = input
    const payload = Result.getOrThrow(canonicalJsonV1Result(invalid))
    const exit = await runtime.runPromiseExit(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO system_qualification_registrations
        (registration_hash, program, attempt_index, prior_attempt_hash, registered_at, first_open_at, last_close_at, payload_text)
        VALUES (${sha256(payload)}, ${input.program}, 1, ${input.priorAttemptHash}, ${input.registeredAt},
          ${input.calendar.sessions[0]?.openAt}, ${input.calendar.sessions.at(-1)?.closeAt}, ${payload})`
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('financial capture resolves each exact registered account and rejects scope substitution', async () => {
    const definitions = registration().policies
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        for (const [index, definition] of definitions.entries()) {
          const identity = yield* Effect.fromResult(
            makeBrokerIdentity({
              schemaVersion: 'bayn.broker-identity.v2',
              provider: BrokerProvider.Alpaca,
              environment: BrokerEnvironment.Sandbox,
              accountId: `captured-financial-${definition.policy}`,
            }),
          )
          const registered = {
            ...definition,
            accountBindingHash: testHash({
              schemaVersion: 'bayn.inference-cost-account.v1',
              accountId: identity.accountId,
            }),
          }
          expect(yield* readRegisteredFinancialIdentity(registered)).toBeNull()
          const previous = testHash({ previous: definition.policy })
          yield* sql`INSERT INTO authority_generations(generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${previous}, 'bayn.authority-generation-history.v1', 'OBSERVE', ${index * 2 + 1}, clock_timestamp())`
          const reconciliation = {
            ...nativeJevFixture(JevPurpose.Entry, undefined, identity.accountId).portfolio.brokerState.reconciliation,
            reconciliationId: testHash({ financialReconciliation: identity.accountId }),
          }
          yield* sql`INSERT INTO reconciliations
          (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${identity.accountId},
            ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash}, 'EXACT',
            '[]'::jsonb, ${reconciliation.reconciledAt})`
          yield* sql`INSERT INTO authority_generations
          (generation_hash, schema_version, maximum, authority_version, previous_generation_hash, activation_schema_version,
           account_id, broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
           risk_policy_hash, activated_at, activation_source_revision, activation_image_repository, activation_image_digest,
           strategy_name, strategy_behavior_hash, strategy_parameter_hash, strategy_parameter_schema_version,
           strategy_protocol_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash, research_plan_hash)
          VALUES (${definition.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'PAPER', ${index * 2 + 2},
            ${previous}, 'bayn.paper-authority-generation.v3',
            ${identity.accountId}, ${identity.schemaVersion}, ${identity.identityHash}, ${identity.provider},
            ${identity.environment}, ${definition.riskPolicyHash}, clock_timestamp(),
            ${definition.sourceRevision}, 'registry.example.test/lab/bayn', ${`sha256:${definition.imageDigest}`},
            'jev', ${definition.strategyHash}, ${definition.parametersHash}, ${defaultJevProtocolDocument.schemaVersion},
            ${definition.protocolHash}, ${testHash('proof')}, ${reconciliation.reconciliationId},
            ${reconciliation.contentHash}, ${testHash('research')})`
          expect(yield* readRegisteredFinancialIdentity(registered)).toEqual(identity)
          for (const changed of [
            { ...registered, accountBindingHash: testHash('other account') },
            { ...registered, riskPolicyHash: testHash('other risk policy') },
            { ...registered, sourceRevision: 'b'.repeat(40) },
            { ...registered, imageDigest: testHash('other image') },
            { ...registered, strategyHash: testHash('other strategy') },
            { ...registered, parametersHash: testHash('other parameters') },
            { ...registered, protocolHash: testHash('other protocol') },
          ])
            expect(Exit.isFailure(yield* Effect.exit(readRegisteredFinancialIdentity(changed)))).toBe(true)
        }
      }),
    )
  })

  test('cash capture reads the registered account and actual observation cut, preserving signed cash and intraminute observations', async () => {
    const at = (second: number) => new Date(Date.UTC(2026, 10, 2, 14, 30, second)).toISOString()
    const accountId = 'cash-projection-fixture'
    const scope = { accountBindingHash: testHash(accountId), openAt: at(0), closeAt: at(120), asOf: at(130) }
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const [i, row] of [
              { accountId, occurred: -1, observed: -1, cash: '99' },
              { accountId, occurred: 0, observed: 1, cash: '1000' },
              { accountId, occurred: 30, observed: 31, cash: '-50' },
              { accountId, occurred: 30, observed: 31, cash: '-55' },
              { accountId, occurred: 60, observed: 131, cash: '1000000000' },
              { accountId: 'foreign-cash-account', occurred: 90, observed: 90, cash: '9999999999' },
              { accountId, occurred: 120, observed: 130, cash: '1005' },
              { accountId, occurred: 121, observed: 121, cash: '999' },
            ].entries()) {
              const id = testHash({ cashEvent: i })
              yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
          source_event_id,source_sequence,occurred_at,observed_at)
          VALUES(${id},'bayn.paper-broker-event.v1',${id},'ACCOUNT','ALPACA',${row.accountId},${String(i)},${i},${at(row.occurred)},${at(row.observed)})`
              yield* sql`INSERT INTO account_snapshots(event_id,account_id,schema_version,status,currency,cash_micros,equity_micros,buying_power_micros)
          VALUES(${id},${row.accountId},'bayn.paper-account-snapshot.v2','ACTIVE','USD',${row.cash},999999999999,999999999999)`
            }
            return yield* readSystemCashObservations(accountId, scope)
          }),
        )
      }),
    )
    expect(rows.map((row) => [row.at, row.availableAt, row.cashMicros])).toEqual([
      [at(0), at(1), '1000'],
      [at(30), at(31), '-50'],
      [at(30), at(31), '-55'],
      [at(120), at(130), '1005'],
    ])
    expect(rows.every((row) => row.accountBindingHash === scope.accountBindingHash)).toBe(true)
    expect(rows.map((row) => row.sourceHash)).toEqual([1, 2, 3, 6].map((cashEvent) => testHash({ cashEvent })))
    const later = await runtime.runPromise(readSystemCashObservations(accountId, { ...scope, asOf: at(131) }))
    expect(later).toHaveLength(5)
    expect(later[3]?.cashMicros).toBe('1000000000')
  })

  test('native order capture retains parent and resized protective legs at the exact account, generation and evidence cut', async () => {
    const account = `replay-${testHash('native-order-capture')}`
    const document = await Effect.runPromise(makePersistenceDocumentFixture(account))
    const f = bracketEvidenceFixture(document)
    const native = nativeJevFixture(JevPurpose.Entry, undefined, account)
    const intentId = document.orderedIntentIds[0]
    const sessionDate = document.executionSession?.executionSession.date
    const risk = document.deltaRisk[0]
    if (intentId === undefined || sessionDate === undefined || risk === undefined)
      throw new Error('Missing native order source')
    const scope = {
      accountId: account,
      generationHash: document.bindings.authorityGenerationHash,
      firstSession: sessionDate,
      lastSession: sessionDate,
      asOf: f.cut.asOf,
    }
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const observedAt = native.portfolio.brokerState.reconciliation.reconciledAt
        yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
        VALUES (${account}, ${testHash('native-order-capture-clock')}, ${observedAt})`
        yield* sql`INSERT INTO authority_generations(generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${scope.generationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${observedAt})`
        const cycles = yield* makeCycleStore({ now: sql`${observedAt}::timestamptz` })
        yield* cycles.acquire(native.draft, observedAt)
        yield* cycles.activate(native.draft.identity.cycleId, observedAt)
        yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${document.createdAt} WHERE account_id = ${account}`
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions(cycle_id, schema_version, document, created_at)
            VALUES (${document.bindings.cycleId}, ${document.schemaVersion}, ${sql.json(document)}, ${document.createdAt})`
            yield* sql`UPDATE autonomous_cycles SET snapshot_id = ${document.bindings.snapshotId},
            decision_hash = ${document.contentHash}, state_version = state_version + 1, updated_at = ${document.createdAt}
            WHERE cycle_id = ${document.bindings.cycleId}`
          }),
        )
        yield* sql`INSERT INTO intents(intent_id, schema_version, account_id, client_order_id, symbol, side,
        order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state, created_at,
        updated_at, cycle_id, strategy_name, decision_hash, policy_hash, authority_generation_hash, protection)
        VALUES (${intentId}, 'bayn.execution-intent.v5', ${account}, ${f.parent.clientOrderId}, ${f.parent.symbol}, 'BUY',
          'LIMIT', 'DAY', ${f.parent.quantityAtoms}, ${risk.notionalLimitMicros}, ${risk.limitPriceMicros}, 'PLANNED',
          ${document.createdAt}, ${document.createdAt}, ${document.bindings.cycleId}, 'jev',
          ${document.bindings.strategyDecisionHash}, ${document.bindings.policyHash}, ${scope.generationHash}, ${sql.json(f.terms)})`
        const stop = f.cut.orders[2]
        const parent = f.cut.orders[0]
        if (stop === undefined || parent === undefined) throw new Error('Missing native parent/stop observation')
        const observations = [
          {
            ...stop,
            eventId: testHash('older stop observation'),
            occurredAt: f.at(500),
            order: {
              ...stop.order,
              quantityAtoms: f.parent.quantityAtoms,
              filledQuantityAtoms: '0',
              status: OrderStatus.Pending,
              observedAt: f.at(600),
            },
          },
          ...f.cut.orders,
          {
            ...parent,
            eventId: testHash('future parent observation'),
            occurredAt: f.at(11000),
            order: { ...parent.order, observedAt: f.at(12000) },
          },
        ]
        for (const [sequence, row] of observations.entries()) {
          const order = row.order
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
          source_event_id,source_sequence,occurred_at,observed_at)
          VALUES(${row.eventId},'bayn.paper-broker-event.v1',${row.eventId},'ORDER','ALPACA',${account},
            ${row.eventId},${sequence},${row.occurredAt},${order.observedAt})`
              yield* sql`INSERT INTO orders(event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,
          symbol,side,order_type,time_in_force,quantity_atoms,filled_quantity_atoms,limit_price_micros,stop_price_micros,
          parent_broker_order_id,status)
          VALUES(${row.eventId},${account},${order.schemaVersion},${order.brokerOrderId},${order.clientOrderId},${intentId},
            ${order.symbol},${order.side},${order.orderType},${order.timeInForce},${order.quantityAtoms},${order.filledQuantityAtoms},
            ${order.limitPriceMicros},${order.stopPriceMicros ?? null},${order.parentBrokerOrderId ?? null},${order.status})`
            }),
          )
        }
        return yield* readSystemExecutionOrders(scope)
      }),
    )
    expect(rows.map((row) => row.order.brokerOrderId)).toEqual(['native-parent', 'native-profit', 'native-stop'])
    const captured = Result.getOrThrow(captureExecutionOrders(f.cut.decisions, rows, account, scope.generationHash))
    expect(captured).toEqual(f.cut.orders)
    expect(
      Result.getOrThrow(bindExecutionEvidence(f.supplied, { ...f.cut, orders: captured }, scope.generationHash))
        .missing,
    ).toEqual([])
    for (const changed of [
      { ...scope, accountId: 'foreign-account' },
      { ...scope, generationHash: testHash('foreign-generation') },
      { ...scope, firstSession: '2026-09-08', lastSession: '2026-09-08' },
      { ...scope, asOf: document.createdAt },
    ])
      expect(await runtime.runPromise(readSystemExecutionOrders(changed))).toEqual([])
    const later = await runtime.runPromise(readSystemExecutionOrders({ ...scope, asOf: f.at(12000) }))
    expect(later.find((row) => row.order.brokerOrderId === 'native-parent')?.eventId).toBe(
      testHash('future parent observation'),
    )
  }, 30000)

  test('later evidence appends a new assessment receipt and neither source cuts nor receipts can be rewritten', async () => {
    const registered = await runtime.runPromise(asApplication(registerFixture(registration())))
    const { input, verifiedSources } = assessmentFixture(registered.registration)
    const definition = registered.registration.policies.find((p) => p.policy === 'JEV')
    const policy = input.policies.find((p) => p.policy === 'JEV')
    if (definition === undefined || policy === undefined) throw new Error('Missing candidate')
    const hashes: string[] = []
    const cuts: string[] = []
    for (const version of [1, 2]) {
      await runtime.runPromise(Effect.sleep('10 millis'))
      const asOf = new Date().toISOString()
      const cut = Schema.decodeUnknownSync(SystemSourceCutSchema)({
        schemaVersion: 'bayn.system-source-cut.v4',
        decisionAdmissions: [],
        orders: [],
        registrationHash: registered.registrationHash,
        asOf,
        runtimeConfigurationHash: registered.registration.obligations.runtimeConfigurationHash,
        financial: [
          {
            policy: 'JEV',
            sourceHash: testHash({ financial: version }),
            accountBindingHash: definition.accountBindingHash,
            definitionHash: testHash(definition),
            cashHistory: null,
            sessions: policy.sessions.map((s) => ({
              sessionDate: s.sessionDate,
              evidenceHash: testHash(s),
              facts: null,
            })),
          },
        ],
        inference: policy.sessions.map((s) => ({
          ...Schema.decodeUnknownSync(SystemSourceCutSchema.fields.inference.value)(s.inferenceEvidence),
          asOf,
        })),
        inferenceLedgerEvidenceHash: testHash({ inference: version }),
        decisions: [],
        batches: [],
        mutations: [],
        fills: [],
        accountMarks: [],
        controllerPasses: [],
        durableObservations: [],
        sourceMaterial: { version },
        sourceMaterialHash: testHash({ version }),
      })
      const saved = await runtime.runPromise(asApplication(persistSystemSourceCut(cut)))
      cuts.push(saved.sourceCutHash)
      expect(await runtime.runPromise(readSystemSourceCut(saved.sourceCutHash))).toEqual(cut)
      const assessmentInput = {
        ...input,
        registration: registered.registration,
        asOf,
        registrationReceiptHash: registered.registrationHash,
        sourceCutHash: saved.sourceCutHash,
        policies: input.policies.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) => ({ ...s, financial: null, marks: [] })),
        })),
        realism: { expectedDecisionIds: [], expectedFillIds: [], decisions: [], fills: [], unsupportedAssumptions: [] },
        reliability: { ...input.reliability, asOf, completions: [] },
        safety: { ...input.safety, coverage: 'INCOMPLETE', registrationHash: registered.registrationHash, asOf },
      }
      const assessment = await runtime.runPromise(
        asApplication(assessAndPersistSystem(assessmentInput, verifiedSources)),
      )
      hashes.push(assessment.assessmentHash)
      expect(assessment.verdict).toBe(QualificationVerdict.Inconclusive)
      expect(await runtime.runPromise(readPersistedSystemAssessment(assessment.assessmentHash))).toEqual(assessment)
      const retainedStress = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM system_assessment_receipts AS receipt,
          jsonb_array_elements(receipt.input_text::jsonb->'policies') AS policy,
          jsonb_array_elements(policy->'sessions') AS session
          WHERE receipt.assessment_hash = ${assessment.assessmentHash}
            AND session->'p95LatencyStress' <> 'null'::jsonb
        `
        }),
      )
      expect(retainedStress).toEqual([{ count: 0 }])
    }
    expect(new Set(hashes).size).toBe(2)
    for (const statement of [
      'UPDATE system_evidence_cuts SET as_of = clock_timestamp()',
      'DELETE FROM system_evidence_cuts',
      'TRUNCATE system_evidence_cuts CASCADE',
      "UPDATE system_assessment_receipts SET verdict = 'QUALIFIED_PAPER'",
      'DELETE FROM system_assessment_receipts',
      'TRUNCATE system_assessment_receipts',
    ])
      expect(
        Exit.isFailure(
          await runtime.runPromiseExit(
            asApplication(
              Effect.gen(function* () {
                const sql = yield* PgClient.PgClient
                yield* sql.unsafe(statement)
              }),
            ),
          ),
        ),
      ).toBe(true)
    expect((await runtime.runPromise(readSystemSourceCut(cuts[0] ?? ''))).sourceMaterial).toEqual({ version: 1 })
  })

  test.each(Object.values(JevResearchPolicy))(
    'replay observer receipts for %s bind their registered image, cuts and times and remain append-only',
    async (selectedPolicy) => {
      await runtime.runPromise(
        asApplication(
          Effect.gen(function* () {
            const base = registration()
            const registered = yield* registerFixture(
              withRegistrationCommitments({
                ...base,
                policies: base.policies.map((p) => ({
                  ...p,
                  imageDigest: testHash({ image: p.policy }),
                  sourceRevision: testHash({ source: p.policy }).slice(0, 40),
                })),
              }),
            )
            const definition = registered.registration.policies.find((p) => p.policy === selectedPolicy)
            if (definition === undefined) throw new Error('Missing selected policy')
            yield* Effect.sleep('2 millis')
            const asOf = new Date().toISOString()
            const cut = yield* persistSystemSourceCut({
              schemaVersion: 'bayn.system-source-cut.v4',
              decisionAdmissions: [],
              orders: [],
              registrationHash: registered.registrationHash,
              asOf,
              runtimeConfigurationHash: registered.registration.obligations.runtimeConfigurationHash,
              financial: [
                {
                  policy: selectedPolicy,
                  sourceHash: testHash('financial'),
                  accountBindingHash: definition.accountBindingHash,
                  definitionHash: testHash(definition),
                  cashHistory: null,
                  sessions: [],
                },
              ],
              inference: [],
              inferenceLedgerEvidenceHash: testHash('inference'),
              decisions: [],
              batches: [],
              mutations: [],
              fills: [],
              accountMarks: [],
              controllerPasses: [],
              durableObservations: [],
              sourceMaterial: {},
              sourceMaterialHash: testHash({}),
            })
            yield* Effect.sleep('2 millis')
            const at = new Date().toISOString()
            const receipt = yield* Schema.decodeUnknownEffect(ReplayExecutionReceiptSchema)({
              schemaVersion: 'bayn.replay-execution-receipt.v1',
              registrationHash: registered.registrationHash,
              sourceCutHash: cut.sourceCutHash,
              policyDefinitionHash: testHash(definition),
              containerId: testHash('container'),
              daemonIdentityHash: testHash('daemon'),
              inspectionHash: testHash('inspection'),
              capturedAt: at,
              startedAt: at,
              finishedAt: at,
              runId: testHash('run'),
              inputFileHash: testHash('input'),
              captureFileHash: testHash('capture'),
              arrivalsFileHash: testHash('arrivals'),
              reportFileHash: testHash('report bytes'),
              reportHash: testHash('report'),
              passLogFileHash: testHash('passes'),
              image: {
                schemaVersion: 'bayn.replay-image-membership.v1',
                repository: 'registry.example.com/bayn',
                imageDigest: `sha256:${definition.imageDigest}`,
                platform: 'linux/amd64',
                manifestDigest: `sha256:${testHash('manifest')}`,
                configDigest: `sha256:${testHash('config')}`,
                sourceRevision: definition.sourceRevision,
                executableSha256: testHash('executable'),
                dependencyReceiptSha256: testHash('dependencies'),
                policyDefinitionHash: testHash(definition),
                assurance: 'REGISTERED_IMAGE_MEMBERSHIP',
                runnerAuthentication: 'NOT_ESTABLISHED_BY_IMAGE_MEMBERSHIP',
              },
              assurance: 'TRUSTED_CONTAINER_DAEMON_OBSERVATION',
              assumptions: replayExecutionAssumptions,
            })
            const sql = yield* PgClient.PgClient
            const insert = (value: typeof receipt) =>
              Effect.gen(function* () {
                const payload = Result.getOrThrow(canonicalJsonV1Result(value))
                yield* sql`INSERT INTO system_replay_execution_receipts(receipt_hash, registration_hash, source_cut_hash, container_id, report_file_hash, payload_text)
          VALUES (${testHash(value)}, ${value.registrationHash}, ${value.sourceCutHash}, ${value.containerId}, ${value.reportFileHash}, ${payload})`
              })
            yield* insert(receipt)
            expect(yield* readReplayExecutionReceipt(testHash(receipt))).toEqual(receipt)
            for (const invalid of [
              { ...receipt, sourceCutHash: testHash('unknown cut') },
              { ...receipt, registrationHash: testHash('unknown registration') },
              { ...receipt, startedAt: registered.registration.registeredAt },
              { ...receipt, finishedAt: registered.registration.registeredAt },
              { ...receipt, capturedAt: registered.registration.calendar.sessions[0]?.openAt ?? '' },
              { ...receipt, policyDefinitionHash: testHash('another policy') },
              {
                ...receipt,
                policyDefinitionHash: testHash('unknown definition'),
                image: { ...receipt.image, policyDefinitionHash: testHash('unknown definition') },
              },
              { ...receipt, image: { ...receipt.image, imageDigest: `sha256:${testHash('another image')}` } },
              { ...receipt, image: { ...receipt.image, sourceRevision: 'b'.repeat(40) } },
            ])
              expect(Exit.isFailure(yield* Effect.exit(sql.withTransaction(insert(invalid))))).toBe(true)
            for (const query of [
              "UPDATE system_replay_execution_receipts SET report_file_hash = repeat('a', 64)",
              'DELETE FROM system_replay_execution_receipts',
              'TRUNCATE system_replay_execution_receipts',
            ])
              expect(Exit.isFailure(yield* Effect.exit(sql.withTransaction(sql.unsafe(query))))).toBe(true)
            expect(yield* readReplayExecutionReceipt(testHash(receipt))).toEqual(receipt)
          }),
        ),
      )
    },
  )

  test('controller observations survive projection updates and are immutable', async () => {
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const controllerKey = sha256('controller identity')
          const planHash = sha256('controller plan')
          yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
        VALUES (${controllerKey}, ${planHash}, true, 1, 0)`
          yield* sql`UPDATE execution_controller_status SET epoch = 2 WHERE controller_key = ${controllerKey}`
          expect(yield* sql`SELECT count(*)::integer AS count FROM execution_controller_observations`).toEqual([
            { count: 0 },
          ])
          const at = new Date().toISOString()
          yield* sql`UPDATE execution_controller_status SET next_sequence = 1, last_sequence = 0, last_outcome = 'Waiting',
            last_receipt_hash = ${sha256('receipt')}, completed_at = ${at},
            last_pass = jsonb_build_object('result', 'SUCCESS', 'outcome', 'WINDOW_CLOSED', 'observedAt', ${at}::text)
            WHERE controller_key = ${controllerKey}`
          for (let epoch = 3; epoch < 23; epoch++)
            yield* sql`UPDATE execution_controller_status SET epoch = ${epoch} WHERE controller_key = ${controllerKey}`
          expect(yield* sql`SELECT count(*)::integer AS count FROM execution_controller_observations`).toEqual([
            { count: 1 },
          ])
          yield* sql`UPDATE execution_controller_status SET epoch = 23,
            last_pass = jsonb_set(last_pass, '{outcome}', '"ALREADY_ACQUIRED"'::jsonb)
            WHERE controller_key = ${controllerKey}`
          const retained = yield* readSystemControllerPasses(controllerKey, planHash, at, at, at)
          expect(retained).toHaveLength(2)
          expect(new Set(retained.map((pass) => pass.receiptHash)).size).toBe(1)
          expect(
            new Set(
              retained.map((pass) => (pass.observation.result === 'SUCCESS' ? pass.observation.outcome : 'FAILURE')),
            ).size,
          ).toBe(2)
        }),
      ),
    )
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          asApplication(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* sql`DELETE FROM execution_controller_observations`
            }),
          ),
        ),
      ),
    ).toBe(true)
  })

  const activeEvaluation = async () => {
    const base = registration()
    const opens = Date.now() + 1500
    const sessions = base.calendar.sessions.map((_session, index) => {
      const openAt = new Date(opens + index * 86_400_000).toISOString()
      return {
        sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(openAt.slice(0, 10)),
        openAt,
        closeAt: new Date(Date.parse(openAt) + 120_000).toISOString(),
      }
    })
    const registered = await runtime.runPromise(
      registerFixture(
        withRegistrationCommitments({
          ...base,
          calendar: { ...base.calendar, sessions },
        }),
      ),
    )
    const definition = registered.registration.policies.find((p) => p.policy === 'JEV')
    if (definition === undefined) throw new Error('Missing candidate')
    const account = `replay-${sha256('system-observation-account')}`
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO authority_generations
        (generation_hash, schema_version, maximum, authority_version, account_id, broker_identity_schema_version,
         broker_identity_hash, broker_provider, broker_environment, activated_at)
        VALUES (${definition.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1,
          ${account}, 'bayn.broker-identity.v2', ${sha256('identity')}, 'alpaca', 'sandbox', clock_timestamp())`
      }),
    )
    await runtime.runPromise(Effect.sleep(Math.max(0, opens - Date.now() + 10)))
    return { registered, definition, account, opens }
  }

  test('an active evaluation witnesses only committed account evidence and retains the first durable observation', async () => {
    const { registered, definition, account, opens } = await activeEvaluation()
    const source = sha256('committed reconciliation')
    const controllerReceipt = sha256('committed controller pass')
    const batch = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const native = nativeJevFixture(JevPurpose.Entry, undefined, account)
        const observation = yield* Effect.fromResult(
          makeJevObservation({ ...native.input, authorityGenerationHash: definition.authorityGenerationHash }),
        )
        yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
          VALUES (${account}, ${sha256('witness-storage-fixture')}, ${observation.payload.observedAt})`
        yield* (yield* makeCycleStore({ now: sql`${observation.payload.observedAt}::timestamptz` })).acquire(
          native.draft,
          observation.payload.observedAt,
        )
        const reconciliation = native.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations
          (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${account},
            ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash}, 'EXACT',
            '[]'::jsonb, ${reconciliation.reconciledAt})`
        yield* (yield* makeCandidateObservationStore).record(observation)
        const evidence = nativeJevDecisionEvidence({ protocol: native.protocol, observation })
        // Exercise storage visibility independently of market hours. Semantic calibration rejects this changed plan.
        const plan = { ...evidence.batchPlan, observedAt: new Date().toISOString() }
        yield* sql`INSERT INTO jev_batch_plans(batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
        VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})`
        return evidence.batchResult
      }),
    )
    await runtime.runPromise(Effect.sleep(Math.max(0, Date.parse(batch.completedAt) - Date.now() + 1)))
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`SAVEPOINT source_writes`
          yield* sql`INSERT INTO jev_batch_results(batch_id, result_hash, payload)
            VALUES (${batch.batchId}, ${batch.resultHash}, ${sql.json(batch)})`
          for (const [accountId, hash] of [
            [account, source],
            ['foreign-account', sha256('foreign reconciliation')],
          ]) {
            yield* sql`INSERT INTO reconciliations
          (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${hash}, 'bayn.paper-reconciliation.v1', ${accountId}, ${hash}, ${hash}, ${hash}, 'EXACT', '[]'::jsonb, clock_timestamp())`
          }
          yield* sql`INSERT INTO execution_controller_status
            (controller_key, plan_hash, active, epoch, next_sequence, last_sequence, last_outcome, last_receipt_hash, completed_at, last_pass)
            VALUES (${sha256('identity')}, ${sha256('controller plan')}, true, 1, 1, 0, 'Completed',
              ${controllerReceipt}, clock_timestamp(), jsonb_build_object('result', 'SUCCESS', 'outcome', 'ACQUIRED',
                'observedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`
          expect(yield* sql`SELECT count(*)::integer AS count FROM system_durable_observations`).toEqual([{ count: 0 }])
          yield* sql`RELEASE SAVEPOINT source_writes`
          yield* sql`UPDATE execution_controller_status SET epoch = 2 WHERE controller_key = ${sha256('identity')}`
          expect(yield* sql`SELECT count(*)::integer AS count FROM system_durable_observations`).toEqual([{ count: 0 }])
        }),
      ),
    )
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
        VALUES (${sha256('foreign identity')}, ${sha256('controller plan')}, true, 1, 0)`
          expect(yield* sql`SELECT count(*)::integer AS count FROM system_durable_observations`).toEqual([{ count: 0 }])
        }),
      ),
    )
    const observed = await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`UPDATE execution_controller_status SET epoch = 3 WHERE controller_key = ${sha256('identity')}`
          return yield* sql`SELECT registration_hash, kind, source_hash, correct,
        witnessed_at::text, witnessed_at >= source_at AS after_source FROM system_durable_observations ORDER BY kind`
        }),
      ),
    )
    expect(observed).toHaveLength(3)
    expect(observed.find((item) => item['kind'] === 'BATCH')).toMatchObject({
      registration_hash: registered.registrationHash,
      kind: 'BATCH',
      source_hash: batch.resultHash,
      correct: true,
      after_source: true,
    })
    expect(observed.find((item) => item['kind'] === 'CONTROLLER')).toMatchObject({
      registration_hash: registered.registrationHash,
      kind: 'CONTROLLER',
      source_hash: controllerReceipt,
      correct: true,
      after_source: true,
    })
    expect(observed.find((item) => item['kind'] === 'RECONCILIATION')).toMatchObject({
      registration_hash: registered.registrationHash,
      kind: 'RECONCILIATION',
      source_hash: source,
      correct: true,
      after_source: true,
    })
    const repeated = await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`UPDATE execution_controller_status SET epoch = 4 WHERE controller_key = ${sha256('identity')}`
          return yield* sql`SELECT registration_hash, kind, source_hash, correct,
        witnessed_at::text, witnessed_at >= source_at AS after_source FROM system_durable_observations ORDER BY kind`
        }),
      ),
    )
    expect(repeated).toEqual(observed)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO execution_controller_observations(controller_key, status)
          SELECT controller_key, to_jsonb(status) FROM execution_controller_status status, generate_series(1, 1000)
          WHERE controller_key = ${sha256('identity')}`
        const definitions = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ definition: Schema.String })),
        )(yield* sql`SELECT pg_get_functiondef('system_evidence_source_committed(xid)'::regprocedure) AS definition`)
        const definition = definitions[0]?.definition
        if (definition === undefined) throw new Error('Missing commit visibility function')
        yield* sql.unsafe(
          definition.replace('public.system_evidence_source_committed(', 'public.original_evidence_source_committed('),
        )
        yield* sql`CREATE TABLE witness_commit_checks (source_xid xid NOT NULL)`
        yield* sql`CREATE OR REPLACE FUNCTION system_evidence_source_committed(source_xid xid)
          RETURNS boolean LANGUAGE plpgsql AS $function$ BEGIN
          INSERT INTO witness_commit_checks VALUES (source_xid);
          RETURN original_evidence_source_committed(source_xid);
          END $function$`
        yield* sql`UPDATE execution_controller_status SET epoch = 5 WHERE controller_key = ${sha256('identity')}`
        expect(yield* sql`SELECT count(*)::integer AS count FROM witness_commit_checks`).toEqual([{ count: 0 }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM system_durable_observations`).toEqual([{ count: 3 }])
      }),
    )
    const exactAt = new Date(opens + 50).toISOString()
    const precisionHash = sha256('fractional witness')
    const precision = await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO system_durable_observations
        (registration_hash, kind, source_hash, source_at, witnessed_at, correct)
        VALUES (${registered.registrationHash}, 'RECONCILIATION', ${precisionHash}, ${exactAt},
          ${exactAt}::timestamptz + interval '0.5 milliseconds', true)`
          return yield* readSystemDurableObservations(registered.registrationHash)
        }),
      ),
    )
    expect(precision.find((w) => w.sourceHash === precisionHash)).toMatchObject({
      sourceAt: exactAt,
      witnessedAt: new Date(Date.parse(exactAt) + 1).toISOString(),
    })
  }, 15_000)

  test('submission evidence certifies only previously committed owned decisions and rolls back with admission', async () => {
    const { account, definition, opens } = await activeEvaluation()
    const native = nativeJevFixture(JevPurpose.Entry, undefined, account)
    const cycleId = native.draft.identity.cycleId
    const observedAt = native.portfolio.brokerState.reconciliation.reconciledAt
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
        VALUES (${account}, ${sha256('admission-proof-clock')}, ${observedAt})`
        yield* (yield* makeCycleStore({ now: sql`${observedAt}::timestamptz` })).acquire(native.draft, observedAt)
      }),
    )
    const targets = new Map<string, { readonly strategyDecisionHash: string; readonly symbol: string }>()
    const source = (label: string, owners: readonly string[], foreign = false) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const at = yield* databaseNow
        const expiry = new Date(Date.parse(at) + 60_000).toISOString()
        const strategyDecisionHash = sha256(`${label}-strategy`)
        for (const [index, owner] of owners.entries())
          targets.set(owner, { strategyDecisionHash, symbol: index === 0 ? 'SPY' : 'AAPL' })
        // Storage visibility is independent of semantic decoding; native document coverage runs in the Jev suite.
        const document = {
          contentHash: sha256(label),
          cycleId,
          createdAt: at,
          expiresAt: expiry,
          schemaVersion: 'bayn.paper-cycle-closure.v1',
          document: {
            schemaVersion: 'bayn.paper-cycle-decision.v2',
            contentHash: sha256(`${label}-decision`),
            mode: 'PAPER',
            createdAt: at,
            expiresAt: expiry,
            submissionCutoffAt: expiry,
            orderedIntentIds: owners.map(sha256),
            bindings: {
              cycleId,
              accountId: foreign ? 'foreign-account' : account,
              authorityGenerationHash: definition.authorityGenerationHash,
              strategyDecisionHash,
              policyHash: sha256('admission-policy'),
            },
          },
        }
        yield* sql`INSERT INTO autonomous_cycle_paper_close_replans(content_hash, cycle_id, document, created_at, expires_at)
        VALUES (${document.contentHash}, ${cycleId}, ${sql.json(document)}, ${at}, ${expiry})`
        return document.document.contentHash
      })
    const admit = (label: string) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const id = sha256(label)
        const target = targets.get(label)
        if (target === undefined) throw new Error('Missing admission strategy fixture')
        yield* sql`INSERT INTO intents(intent_id, schema_version, account_id, client_order_id, symbol, side,
        order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state, created_at,
        updated_at, cycle_id, strategy_name, decision_hash, policy_hash, authority_generation_hash)
        VALUES (${id}, 'bayn.execution-intent.v5', ${account}, ${label}, ${target.symbol}, 'SELL', 'LIMIT', 'DAY',
          1000000000, 1000000, 1000000, 'PLANNED', statement_timestamp(), statement_timestamp(), ${cycleId}, 'jev',
          ${target.strategyDecisionHash}, ${sha256('admission-policy')}, ${definition.authorityGenerationHash})`
        yield* sql`INSERT INTO mutation_events(event_id, schema_version, mutation_id, intent_id, sequence,
        operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${id}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${sha256('admission-request')}, 1000, clock_timestamp())`
      })
    const decisionId = await runtime.runPromise(
      asApplication(source('owned close', ['committed-admission', 'rolled-back-admission'])),
    )
    await runtime.runPromise(asApplication(admit('committed-admission')))
    const captured = await runtime.runPromise(
      readSystemDecisionAdmissions({
        accountId: account,
        generationHash: definition.authorityGenerationHash,
        openAt: new Date(opens).toISOString(),
        asOf: new Date(Date.now() + 1000).toISOString(),
      }),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ eventId: sha256('committed-admission'), decisionId })
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`SAVEPOINT decision_write`
          yield* source('uncommitted close', ['before-savepoint-release', 'after-savepoint-release'])
          yield* admit('before-savepoint-release')
          yield* sql`RELEASE SAVEPOINT decision_write`
          yield* admit('after-savepoint-release')
          expect(yield* sql`SELECT count(*)::integer AS count FROM execution_decision_admissions`).toEqual([
            { count: 1 },
          ])
        }),
      ),
    )
    await runtime.runPromise(asApplication(source('foreign close', ['foreign-admission'], true)))
    await runtime.runPromise(asApplication(admit('foreign-admission')))
    const rollback = await runtime.runPromiseExit(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* admit('rolled-back-admission')
          expect(yield* sql`SELECT count(*)::integer AS count FROM execution_decision_admissions`).toEqual([
            { count: 2 },
          ])
          return yield* Effect.fail('rollback the admitted mutation and its receipt')
        }),
      ),
    )
    expect(Exit.isFailure(rollback)).toBe(true)
    for (const action of [
      'UPDATE execution_decision_admissions SET observed_at = clock_timestamp()',
      'DELETE FROM execution_decision_admissions',
      'TRUNCATE execution_decision_admissions',
      `INSERT INTO execution_decision_admissions(event_id, decision_id) VALUES ('${sha256('foreign-admission')}', '${sha256('invented decision')}')`,
    ])
      expect(
        Exit.isFailure(
          await runtime.runPromiseExit(
            asApplication(
              Effect.gen(function* () {
                yield* (yield* PgClient.PgClient).unsafe(action)
              }),
            ),
          ),
        ),
      ).toBe(true)
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* PgClient.PgClient)`SELECT count(*)::integer AS count FROM execution_decision_admissions`
        }),
      ),
    ).toEqual([{ count: 1 }])
  }, 15_000)

  test('mutation admission rejects ambient transactions before any broker-capable state transition', async () => {
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const store = yield* makePostgresMutationStore
          for (const attempt of [
            store.beginSubmit(sha256('ambient submit'), sha256('request'), 1000, new Date().toISOString(), undefined),
            store.beginCancel(
              sha256('ambient cancel'),
              sha256('request'),
              'broker-order',
              1000,
              new Date().toISOString(),
            ),
          ]) {
            const result = yield* attempt.pipe(Effect.result)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) expect(result.failure.message).toContain('must commit independently')
          }
          expect(yield* (yield* PgClient.PgClient)`SELECT count(*)::integer AS count FROM mutation_events`).toEqual([
            { count: 0 },
          ])
        }).pipe(Effect.provide(WriterFenceLive)),
      ),
    )
  })

  test('a later admitted mutation does not invalidate an exact preflight reconciliation', async () => {
    const { account, definition, registered } = await activeEvaluation()
    const reconciliationHash = sha256('exact preflight before routing')
    const native = nativeJevFixture(JevPurpose.Entry, undefined, account)
    const observedAt = native.portfolio.brokerState.reconciliation.reconciledAt
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO simulated_execution_clocks(account_id, source_manifest_hash, observed_at)
            VALUES (${account}, ${sha256('preflight-witness-clock')}, ${observedAt})`
          yield* (yield* makeCycleStore({ now: sql`${observedAt}::timestamptz` })).acquire(native.draft, observedAt)
          yield* sql`INSERT INTO reconciliations
        (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
        VALUES (${reconciliationHash}, 'bayn.paper-reconciliation.v1', ${account}, ${reconciliationHash},
          ${reconciliationHash}, ${reconciliationHash}, 'EXACT', '[]'::jsonb, clock_timestamp())`
        }),
      ),
    )
    const mutationId = sha256('mutation after exact preflight')
    await runtime.runPromise(
      asApplication(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const intentId = sha256('intent after exact preflight')
          yield* sql`INSERT INTO intents(intent_id, schema_version, account_id, client_order_id, symbol, side,
        order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state, created_at,
        updated_at, cycle_id, strategy_name, decision_hash, policy_hash, authority_generation_hash)
        VALUES (${intentId}, 'bayn.execution-intent.v5', ${account}, 'preflight-witness-test', 'SPY', 'BUY',
          'LIMIT', 'DAY', 1000000000, 1000000, 1000000, 'PLANNED', statement_timestamp(), statement_timestamp(),
          ${native.draft.identity.cycleId}, 'jev', ${sha256('preflight-decision')}, ${sha256('preflight-policy')},
          ${definition.authorityGenerationHash})`
          yield* sql`INSERT INTO mutation_events(event_id, schema_version, mutation_id, intent_id, sequence,
        operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${mutationId}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${sha256('preflight-request')}, 1000, clock_timestamp())`
          yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
        VALUES (${sha256('identity')}, ${sha256('controller plan')}, true, 1, 0)`
        }),
      ),
    )
    const witnesses = await runtime.runPromise(readSystemDurableObservations(registered.registrationHash))
    expect(witnesses.find((w) => w.sourceHash === reconciliationHash)).toMatchObject({
      kind: 'RECONCILIATION',
      correct: true,
    })
    expect(witnesses.some((w) => w.sourceHash === mutationId)).toBe(false)
  }, 15_000)

  test('migration queues existing active evaluation sources without inventing historical witness times', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id <= 156))),
          table: 'schema_migrations',
        })
        yield* initializeQualificationHistory(history, new Set([history.historySourceHash]))
        databaseObservedAt = yield* databaseNow
      }),
    )
    const { account, opens, registered } = await activeEvaluation()
    const source = sha256('evidence retained before migration 157')
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        for (const [accountId, hash, at] of [
          [account, source, new Date().toISOString()],
          [account, sha256('pre-window source'), new Date(opens - 1).toISOString()],
          ['foreign-account', sha256('foreign source before migration'), new Date().toISOString()],
        ] as const) {
          yield* sql`INSERT INTO reconciliations
          (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${hash}, 'bayn.paper-reconciliation.v1', ${accountId}, ${hash}, ${hash}, ${hash}, 'EXACT', '[]'::jsonb, ${at})`
        }
        const beforeMigration = yield* databaseNow
        yield* postgresMigrations
        expect(yield* sql`SELECT source_hash FROM system_pending_evidence`).toEqual([{ source_hash: source }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM system_durable_observations`).toEqual([{ count: 0 }])
        yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
        VALUES (${sha256('identity')}, ${sha256('controller plan')}, true, 1, 0)`
        const witnesses = yield* readSystemDurableObservations(registered.registrationHash)
        expect(witnesses).toHaveLength(1)
        expect(witnesses[0]?.sourceHash).toBe(source)
        expect(Date.parse(witnesses[0]?.witnessedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(beforeMigration))
        expect(yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence`).toEqual([{ count: 0 }])
      }),
    )
  }, 15_000)

  test('pending witnesses retain out-of-order commits and discard rolled-back or deferred-rejected sources', async () => {
    const { account } = await activeEvaluation()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO execution_controller_status(controller_key, plan_hash, active, epoch, next_sequence)
          VALUES (${sha256('identity')}, ${sha256('controller plan')}, true, 1, 0)`
        const insertReconciliation = (source: string) => sql`INSERT INTO reconciliations
          (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${source}, 'bayn.paper-reconciliation.v1', ${account}, ${source}, ${source}, ${source}, 'EXACT', '[]'::jsonb, clock_timestamp())`
        const observe = asApplication(
          Effect.gen(function* () {
            yield* sql`UPDATE execution_controller_status SET epoch = epoch + 1 WHERE controller_key = ${sha256('identity')}`
            return yield* sql`SELECT source_hash FROM system_durable_observations ORDER BY source_hash`
          }),
        )
        const earlier = sha256('transaction that commits second')
        const later = sha256('transaction that commits first')
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const slowTransaction = yield* asApplication(
          Effect.gen(function* () {
            yield* insertReconciliation(earlier)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(entered).pipe(Effect.timeout('5 seconds'))
        yield* asApplication(insertReconciliation(later))
        for (const query of [
          sql`DELETE FROM system_pending_evidence`,
          sql`UPDATE system_pending_evidence SET correct = false`,
        ]) {
          expect(Exit.isFailure(yield* asApplication(query).pipe(Effect.exit))).toBe(true)
        }
        expect(yield* observe).toEqual([{ source_hash: later }])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(slowTransaction)
        const both = [earlier, later].sort().map((source_hash) => ({ source_hash }))
        expect(yield* observe).toEqual(both)
        expect(yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence`).toEqual([{ count: 0 }])

        const rolledBack = sha256('rolled-back witness')
        const rollback = yield* asApplication(
          Effect.gen(function* () {
            yield* insertReconciliation(rolledBack)
            expect(yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence`).toEqual([{ count: 1 }])
            return yield* Effect.fail('rollback source and queue together')
          }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(rollback)).toBe(true)
        expect(yield* observe).toEqual(both)

        yield* sql`CREATE FUNCTION reject_test_source_at_commit() RETURNS trigger LANGUAGE plpgsql AS $function$
          BEGIN RAISE EXCEPTION 'deferred source rejection' USING ERRCODE = '23514'; END $function$`
        yield* sql`CREATE CONSTRAINT TRIGGER reject_test_source_at_commit AFTER INSERT ON reconciliations
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_test_source_at_commit()`
        const rejected = yield* asApplication(
          Effect.gen(function* () {
            yield* insertReconciliation(sha256('deferred-rejected source'))
            yield* sql`UPDATE execution_controller_status SET epoch = epoch + 1 WHERE controller_key = ${sha256('identity')}`
            expect(yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence`).toEqual([{ count: 1 }])
            expect(yield* sql`SELECT source_hash FROM system_durable_observations ORDER BY source_hash`).toEqual(both)
          }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        expect(yield* observe).toEqual(both)
        expect(yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence`).toEqual([{ count: 0 }])

        for (const query of [
          sql`INSERT INTO system_pending_evidence SELECT registration_hash, kind, source_hash, source_at, correct
            FROM system_durable_observations LIMIT 1`,
          sql`TRUNCATE system_pending_evidence`,
        ]) {
          expect(Exit.isFailure(yield* asApplication(query).pipe(Effect.exit))).toBe(true)
        }
      }).pipe(Effect.scoped),
    )
  }, 15_000)
})
