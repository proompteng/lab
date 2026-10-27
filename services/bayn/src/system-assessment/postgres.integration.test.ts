import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalJsonV1Result, sha256 } from '../hash'
import { IsoDateSchema } from '../schemas'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  registrationFixture,
  replayRateCardFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { initializeQualificationHistory, readSystemRegistration, registerSystemQualification } from './postgres'
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
const registration = () => ({
  ...registrationFixture(),
  registeredAt: new Date(Date.now() - 1000).toISOString(),
  priorAttemptHash: testHash(history),
})
const registerFixture = (value: ReturnType<typeof registration>) =>
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
    const inferenceRateCard = replayRateCardFixture({
      jev: { inputMicrosPerMillionTokens: '41999', outputMicrosPerMillionTokens: '0' },
      chart: {
        inputMicrosPerMillionTokens: '1',
        outputMicrosPerMillionTokens: '0',
        cachedInputMicrosPerMillionTokens: '0',
        cacheWriteInputMicrosPerMillionTokens: '0',
      },
    })
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
    const openAt = new Date(Date.now() + 2000).toISOString()
    const closeAt = new Date(Date.now() + 3000).toISOString()
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
})
