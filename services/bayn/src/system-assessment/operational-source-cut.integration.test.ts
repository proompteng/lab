import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { postgresMigrations } from '../db/postgres-migrations'
import { marketCalendarQueryFromSession } from '../cycle/runner/calendar-decisions'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { ControllerPassEvidenceSchema } from './decision-work'
import { testHash } from './fixtures.test-support'
import { bindOperationalObligations, bindOperationalWork } from './operational-obligations'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { OperationalSourceCutSchema, replayOperationalSourceRecords } from './operational-source-cut'
import { emptySourceCutFixture } from './source-cut.test-support'
import { makeSystemSourceRecord, persistSystemSourceRecord, SystemSourceRecordKind } from './source-records'
import { makeOperationalSourceSpool } from './operational-capture'
import { persistenceDocumentFixture } from './decision-persistence.test-support'
import { replacementProtectionFixture } from './protection-evidence.test-support'
import { decisionAdmissionWitnesses, indexDecisionAdmissionMutations } from './decision-admissions'
import { MutationEventSchema, MutationEventType } from '../execution/mutations/model'
import {
  evaluateOperationalAssessment,
  makeOperationalSafetyAudit,
  verifyStoredOperationalAssessment,
} from './operational-assessment'
import { qualificationDeadlines } from './configuration'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
const fixture = (status = 200) => {
  const registration = operationalRegistrationFixture()
  const candidate = registration.policies[0]
  const at = (offset: number) =>
    new Date(Date.parse(registration.calendar.sessions[0]!.openAt) + 2000 + offset).toISOString()
  const { normalizedResponseHash: _hash, ...originalCalendar } = registration.calendar.marketCalendar
  const material = {
    ...originalCalendar,
    requestedRange: Result.getOrThrow(marketCalendarQueryFromSession(at(0).slice(0, 10))),
  }
  const calendar = { ...material, normalizedResponseHash: testHash(material) }
  const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
    controllerKey: candidate.capitalAuthorization!.request.broker.identityHash,
    planHash: registration.obligations.configuration.controllerPlanHash,
    epoch: 1,
    sequence: 1,
    receiptHash: testHash('retained closed pass'),
    completedAt: at(3),
    observation: {
      result: 'SUCCESS',
      outcome: 'WINDOW_CLOSED',
      executionIssuedAt: at(-1),
      observedAt: at(2),
      executionBuild: {
        sourceRevision: candidate.sourceRevision,
        imageRepository: 'registry.example.test/lab/bayn',
        imageDigest: `sha256:${candidate.imageDigest}`,
      },
      closedEntryWindow: {
        schemaVersion: 'bayn.closed-entry-window.v1',
        accountId: candidate.riskPolicy.accountId,
        authorityGenerationHash: candidate.authorityGenerationHash,
        strategyProtocolHash: candidate.protocolHash,
        evaluatedAt: at(0),
        decidedAt: at(1),
        calendar,
        executionPolicy: Result.getOrThrow(
          makeCycleExecutionPolicyFromModel(registration.obligations.configuration.protocol.executionModel),
        ),
        calendarRead: {
          requestId: 'synthetic-calendar-read',
          status,
          contentHash: testHash(calendar),
          observedAt: at(1),
        },
      },
    },
  })
  const { cut: base } = emptySourceCutFixture()
  const legacy = {
    ...base,
    registrationHash: testHash(registration),
    asOf: at(180000),
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    financial: [],
    controllerPasses: [pass],
    durableObservations: [
      {
        kind: 'CONTROLLER' as const,
        sourceHash: pass.receiptHash,
        sourceAt: pass.completedAt,
        witnessedAt: at(4),
        correct: true,
      },
    ],
  }
  const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, pass))
  const cut = Schema.decodeUnknownSync(OperationalSourceCutSchema)({
    ...legacy,
    schemaVersion: 'bayn.operational-source-cut.v1',
    records: [{ kind: record.kind, sourceId: pass.receiptHash, recordHash: record.recordHash }],
  })
  return { registration, legacy, cut, record, pass }
}

const assessmentFixture = (
  cut: typeof OperationalSourceCutSchema.Type,
  registration: ReturnType<typeof operationalRegistrationFixture>,
) => {
  const safety = Result.getOrThrow(
    makeOperationalSafetyAudit({
      schemaVersion: 'bayn.operational-safety-audit.v1',
      coverage: 'COMPLETE',
      auditEvidenceHash: testHash('compact source safety evidence'),
      registrationHash: cut.registrationHash,
      asOf: cut.asOf,
      violations: [],
    }),
  )
  return {
    input: {
      schemaVersion: 'bayn.operational-assessment-input.v2',
      registration,
      sourceCutHash: testHash(cut),
      safety,
    },
    sources: new Set([
      registration.calendar.sourceHash,
      ...registration.retainedIncidentSources,
      safety.sourceHash,
      safety.auditEvidenceHash,
    ]),
  }
}

postgres('replayed operational source records', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const url = baynTestPostgresUrl ?? ''
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw Error('Operational source tests require an isolated local _test database')
    runtime = makeRuntime(url)
  })
  beforeEach(
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
        }),
      ),
    30000,
  )
  afterAll(async () => {
    if (runtime !== undefined) await runtime.dispose()
  })

  test.each([200, 429])(
    'preserves positive work and retained operational failure for calendar status %i',
    async (status) => {
      const f = fixture(status)
      const replayed = await runtime.runPromise(
        Effect.gen(function* () {
          yield* persistSystemSourceRecord(f.record)
          return yield* replayOperationalSourceRecords(f.cut, f.registration)
        }),
      )
      const work = replayed.work.controllerWork.get(f.pass.receiptHash)
      expect(work).toBeDefined()
      expect(work?.correct).toBe(status === 200)
      const hash = testHash('same logical evidence for equivalence')
      const full = Result.getOrThrow(bindOperationalObligations(f.legacy, f.registration, hash))
      const compact = Result.getOrThrow(bindOperationalWork(f.cut, f.registration, hash, replayed.work))
      expect(compact).toEqual(full)
      expect(compact.reliability.completions).toHaveLength(1)
    },
  )

  test('rejects missing, substituted and invented correctness evidence before creating verified work', async () => {
    const f = fixture()
    await runtime.runPromise(
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* replayOperationalSourceRecords(f.cut, f.registration).pipe(Effect.exit))).toBe(
          true,
        )
        yield* persistSystemSourceRecord(f.record)
        const substituted = { ...f.cut, records: [{ ...f.cut.records[0]!, sourceId: testHash('another native pass') }] }
        expect(
          Exit.isFailure(yield* replayOperationalSourceRecords(substituted, f.registration).pipe(Effect.exit)),
        ).toBe(true)
        const fake = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, { correct: true }))
        yield* persistSystemSourceRecord(fake)
        const invented = { ...f.cut, records: [{ ...f.cut.records[0]!, recordHash: fake.recordHash }] }
        expect(Exit.isFailure(yield* replayOperationalSourceRecords(invented, f.registration).pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* replayOperationalSourceRecords(
              { ...f.cut, records: [...f.cut.records, ...f.cut.records] },
              f.registration,
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test('compact current assessments check unwitnessed builds and retain the exact deadline-tail boundary', async () => {
    const f = fixture()
    const bound = Result.getOrThrow(bindOperationalObligations(f.legacy, f.registration, testHash(f.legacy)))
    const through = Math.max(
      Date.parse(f.registration.calendar.sessions.at(-1)!.closeAt),
      ...bound.reliability.schedule.map((row) => Date.parse(row.deadlineAt)),
    )
    const at = (offset: number) => new Date(through + offset).toISOString()
    const badBuild = {
      ...f.pass.observation.executionBuild!,
      sourceRevision: testHash('unregistered worker').slice(0, 40),
    }
    const cases = [
      {
        name: 'in-period',
        issued: f.pass.observation.executionIssuedAt,
        observed: f.pass.observation.observedAt,
        completed: f.pass.completedAt,
        missing: true,
      },
      { name: 'deadline-overlap', issued: at(-1), observed: at(1), completed: at(2), missing: true },
      { name: 'known-later', issued: at(1), observed: at(2), completed: at(3), missing: false },
      { name: 'unknown-issued', issued: undefined, observed: at(2), completed: at(3), missing: true },
      { name: 'issued-after-observed', issued: at(3), observed: at(2), completed: at(4), missing: true },
      { name: 'observed-after-completed', issued: at(1), observed: at(3), completed: at(2), missing: true },
      { name: 'completed-after-cut', issued: at(1), observed: at(2), completed: at(11), missing: true },
    ]
    for (const row of cases) {
      const { executionIssuedAt: _issued, ...observation } = f.pass.observation
      const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
        ...f.pass,
        receiptHash: testHash(row.name),
        completedAt: row.completed,
        observation: {
          ...observation,
          ...(row.issued === undefined ? {} : { executionIssuedAt: row.issued }),
          observedAt: row.observed,
          executionBuild: badBuild,
        },
      })
      const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, pass))
      const cut = {
        ...f.cut,
        asOf: at(10),
        durableObservations: [],
        records: [{ kind: record.kind, sourceId: pass.receiptHash, recordHash: record.recordHash }],
      }
      const replayed = await runtime.runPromise(
        Effect.gen(function* () {
          yield* persistSystemSourceRecord(record)
          return yield* replayOperationalSourceRecords(cut, f.registration)
        }),
      )
      expect(replayed.work.controllerWork.size).toBe(0)
      expect(replayed.unboundControllerBuilds).toHaveLength(1)
      const { input, sources } = assessmentFixture(cut, f.registration)
      const result = Result.getOrThrow(evaluateOperationalAssessment(input, replayed, sources))
      expect(result.missing.includes(`UNBOUND_CONTROLLER_BUILD:${pass.receiptHash}`)).toBe(row.missing)
    }
  })

  test('compact replay preserves historical work and rejects mismatched evaluation policies', async () => {
    const f = fixture()
    const pass = {
      ...f.pass,
      observation: {
        ...f.pass.observation,
        executionBuild: { ...f.pass.observation.executionBuild!, imageRepository: 'example.test/foreign/worker' },
      },
    }
    expect(pass.observation.executionBuild.imageRepository).not.toBe(
      f.registration.policies[0].capitalAuthorization!.buildLineage.activation.imageRepository,
    )
    const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Controller, pass))
    const cut = {
      ...f.cut,
      records: [{ kind: record.kind, sourceId: pass.receiptHash, recordHash: record.recordHash }],
    }
    const [current, retained] = await runtime.runPromise(
      Effect.gen(function* () {
        yield* persistSystemSourceRecord(record)
        return [
          yield* replayOperationalSourceRecords(cut, f.registration),
          yield* replayOperationalSourceRecords(cut, f.registration, 'RETAINED_OPERATIONAL_V1'),
        ] as const
      }),
    )
    expect(retained.work.controllerWork.get(f.pass.receiptHash)?.correct).toBe(true)
    const { input, sources } = assessmentFixture(cut, f.registration)
    const legacyInput = { ...input, schemaVersion: 'bayn.operational-assessment-input.v1' }
    expect(Result.isFailure(evaluateOperationalAssessment(input, retained, sources))).toBe(true)
    expect(Result.isFailure(verifyStoredOperationalAssessment(legacyInput, current, sources))).toBe(true)
    expect(Result.isFailure(evaluateOperationalAssessment(legacyInput, retained, sources))).toBe(true)
    const legacy = Result.getOrThrow(verifyStoredOperationalAssessment(legacyInput, retained, sources))
    expect(legacy).not.toHaveProperty('evaluationPolicy')
    expect(legacy.missing.some((row) => row.startsWith('UNBOUND_CONTROLLER_BUILD:'))).toBe(false)
    expect(Result.getOrThrow(evaluateOperationalAssessment(input, current, sources)).evaluationPolicy).toBe(
      'bayn.operational-build-binding.v1',
    )
  })

  test('a compact cut with no controller passes still withholds a null-plan current claim', async () => {
    const f = fixture()
    const configuration = { ...f.registration.obligations.configuration, controllerPlanHash: null }
    const registration = {
      ...f.registration,
      obligations: {
        ...f.registration.obligations,
        configuration,
        ...Result.getOrThrow(qualificationDeadlines(configuration)),
      },
    }
    const cut = {
      ...f.cut,
      registrationHash: testHash(registration),
      runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
      records: [],
      durableObservations: [],
    }
    const replayed = await runtime.runPromise(replayOperationalSourceRecords(cut, registration))
    const { input, sources } = assessmentFixture(cut, registration)
    expect(Result.getOrThrow(evaluateOperationalAssessment(input, replayed, sources)).missing).toContain(
      'UNBOUND_CONTROLLER_PLAN',
    )
  })

  test.each(['Oco', 'StopLimit'] as const)(
    'replays the full owned %s decision and its durable admission',
    async (kind) => {
      const document = await Effect.runPromise(persistenceDocumentFixture)
      const f = replacementProtectionFixture(document, kind)
      const base = operationalRegistrationFixture()
      const session = document.executionSession?.executionSession
      if (session === undefined) throw new Error('Expected a native equity session')
      const registration = {
        ...base,
        calendar: {
          ...base.calendar,
          sessions: [{ sessionDate: session.date, openAt: session.openAt, closeAt: session.closeAt }],
        },
        policies: [{ ...base.policies[0], authorityGenerationHash: document.bindings.authorityGenerationHash }],
      } satisfies typeof base
      const entryOutcome = f.cut.mutations[0]!
      const { routing: _routing, brokerOrderId: _order, ...entryEvent } = entryOutcome.event
      const entryStart = {
        ...entryOutcome,
        event: Schema.decodeUnknownSync(MutationEventSchema)({
          ...entryEvent,
          eventId: testHash('streamed native entry admission'),
          sequence: 1,
          eventType: MutationEventType.SubmitStarted,
          occurredAt: f.at(1),
        }),
      }
      const receipt = { eventId: entryStart.event.eventId, decisionId: document.contentHash, observedAt: f.at(1) }
      const legacy = {
        ...f.cut,
        mutations: [entryStart, ...f.cut.mutations],
        decisionAdmissions: [{ ...receipt, sourceHash: testHash(receipt) }, ...f.cut.decisionAdmissions],
      }
      const record = Result.getOrThrow(makeSystemSourceRecord(SystemSourceRecordKind.Decision, f.cut.decisions[0]))
      const cut = Schema.decodeUnknownSync(OperationalSourceCutSchema)({
        ...legacy,
        schemaVersion: 'bayn.operational-source-cut.v1',
        records: [{ kind: record.kind, sourceId: document.contentHash, recordHash: record.recordHash }],
      })
      let mutationTraversals = 0
      const mutations = new Proxy(cut.mutations, {
        get(target, key, receiver) {
          if (key === Symbol.iterator)
            return function* () {
              mutationTraversals++
              yield* target
            }
          return Reflect.get(target, key, receiver)
        },
      })
      const replayed = await runtime.runPromise(
        Effect.gen(function* () {
          yield* persistSystemSourceRecord(record)
          return yield* replayOperationalSourceRecords({ ...cut, mutations }, registration)
        }),
      )
      expect(mutationTraversals).toBe(1)
      const expected = Result.getOrThrow(
        decisionAdmissionWitnesses(
          legacy,
          document.bindings.authorityGenerationHash,
          indexDecisionAdmissionMutations(legacy.mutations),
        ),
      )
      expect(replayed.admissions).toEqual(expected)
      expect(replayed.admissions.witnesses.some((w) => w.sourceHash === f.evidence.intentId)).toBe(true)
      const hash = testHash('same logical evidence for protected entry')
      expect(Result.getOrThrow(bindOperationalWork(cut, registration, hash, replayed.work))).toEqual(
        Result.getOrThrow(bindOperationalObligations(legacy, registration, hash)),
      )
      const missing = { ...cut, records: [] }
      expect(Exit.isFailure(await runtime.runPromiseExit(replayOperationalSourceRecords(missing, registration)))).toBe(
        true,
      )
    },
    // Full native document construction and canonical replay must finish before the next schema reset.
    30000,
  )

  test.each(['success', 'failure', 'interruption'] as const)('removes private spool files after %s', async (mode) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        let directory: string | undefined
        const observedFs = {
          ...fs,
          makeTempDirectoryScoped: (...args: Parameters<typeof fs.makeTempDirectoryScoped>) =>
            fs.makeTempDirectoryScoped(...args).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  directory = path
                }),
              ),
            ),
        }
        const written = yield* Deferred.make<void>()
        const operation = Effect.scoped(
          Effect.gen(function* () {
            const archive = yield* makeOperationalSourceSpool
            yield* archive.spool(SystemSourceRecordKind.Controller, testHash('spooled source'), {
              retained: 'full raw bytes',
            })
            expect(directory).toBeDefined()
            const files = yield* fs.readDirectory(directory!)
            expect(files).toHaveLength(1)
            const stat = yield* fs.stat(`${directory}/${files[0]}`)
            expect(stat.mode & 0o777).toBe(0o600)
            expect((yield* fs.stat(directory!)).mode & 0o777).toBe(0o700)
            if (mode === 'success') {
              yield* archive.persist
              expect(yield* fs.readDirectory(directory!)).toEqual([])
              return
            }
            yield* Deferred.succeed(written, undefined)
            return yield* mode === 'failure' ? Effect.fail('capture failed') : Effect.never
          }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, observedFs))
        if (mode === 'interruption') {
          const running = yield* Effect.forkChild(operation)
          yield* Deferred.await(written)
          yield* Fiber.interrupt(running)
        } else expect(Exit.isSuccess(yield* Effect.exit(operation))).toBe(mode === 'success')
        expect(yield* fs.exists(directory!)).toBe(false)
        const rows = yield* (yield* PgClient.PgClient)`SELECT count(*)::integer AS count FROM system_source_records`
        expect(rows).toEqual([{ count: mode === 'success' ? 1 : 0 }])
      }).pipe(Effect.scoped),
    )
  })
})
