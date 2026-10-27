import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalJsonV1Result, sha256 } from '../hash'
import { IsoDateSchema, UtcInstantSchema } from '../schemas'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  assessmentFixture,
  registrationFixture,
  replayRateCardFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
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
} from './capture'
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
        schemaVersion: 'bayn.system-source-cut.v2',
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
              schemaVersion: 'bayn.system-source-cut.v2',
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

  test('an active evaluation witnesses only committed account evidence and retains the first durable observation', async () => {
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
})
