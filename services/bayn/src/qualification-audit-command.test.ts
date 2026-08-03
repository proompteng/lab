import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Redacted, Ref } from 'effect'

import type { AuditDatabaseSnapshot } from './audit/audit'
import {
  loadAuditSignal,
  makeQualificationAuditReaders,
  QualificationAuditCommandError,
  readAuditDatabase,
  readAuditSignalAccess,
  runQualificationAudit,
  type AuditConfig,
  type AuditSignalReplicaClient,
} from './qualification-audit-command'
import { fixtureProtocol, makeSnapshot } from './test-fixtures'

const commandPath = new URL('./qualification-audit-command.ts', import.meta.url).pathname
const secretMarkers = ['postgres-secret-marker', 'signal-secret-marker', 'audit-secret-marker'] as const

const runCommand = async (output: 'audit' | 'dossier', overrides: Record<string, string> = {}) => {
  const child = Bun.spawn({
    cmd: [process.execPath, commandPath],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BAYN_AUDIT_OUTPUT: output,
      BAYN_AUDIT_RUN_ID: '0'.repeat(64),
      BAYN_AUDIT_POSTGRES_URL: `postgresql://audit:${secretMarkers[0]}@127.0.0.1:1/bayn_audit_test`,
      BAYN_AUDIT_POSTGRES_TLS: 'false',
      BAYN_AUDIT_SIGNAL_URL: 'http://127.0.0.1:1',
      BAYN_AUDIT_SIGNAL_USERNAME: 'bayn-audit-candidate',
      BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME: 'bayn-audit-publisher',
      BAYN_AUDIT_SIGNAL_PASSWORD: secretMarkers[1],
      BAYN_AUDIT_CLICKHOUSE_URLS: 'http://127.0.0.1:1,http://127.0.0.1:2',
      BAYN_AUDIT_CLICKHOUSE_USERNAME: 'bayn-audit-query-log',
      BAYN_AUDIT_CLICKHOUSE_PASSWORD: secretMarkers[2],
      BAYN_AUDIT_REPOSITORY_PATH: import.meta.dir,
      BAYN_AUDIT_OPERATION_TIMEOUT_MS: '100',
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const auditConfig = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
  output: 'audit',
  runId: 'a'.repeat(64),
  postgresUrl: Redacted.make('postgresql://audit:audit@127.0.0.1:5432/bayn_audit_test'),
  postgresTls: false,
  postgresCaPath: '',
  signalUrl: 'http://signal.invalid',
  signalUsername: 'bayn-audit-candidate',
  signalPublisherUsername: 'bayn-audit-publisher',
  signalPassword: Redacted.make('signal-password'),
  auditClickhouseUrls: [new URL('http://audit-0.invalid'), new URL('http://audit-1.invalid')],
  auditClickhouseUsername: 'bayn-audit-query-log',
  auditClickhousePassword: Redacted.make('audit-password'),
  repositoryPath: import.meta.dir,
  candidateModulePath: '',
  candidateModuleSha256: '',
  operationTimeoutMs: 5_000,
  ...overrides,
})

const opaqueDatabase = {
  artifacts: [],
  run: { runId: 'a'.repeat(64), snapshotId: 'b'.repeat(64) },
  qualification: { resultCommittedAt: '2026-07-25T00:00:00.000000Z' },
} as unknown as AuditDatabaseSnapshot

const signalSnapshot = makeSnapshot(270)

const replicaSource = (index: number, topology: readonly string[]) => ({
  replica: topology[index] ?? `replica-${index}`,
  topology,
  access: [],
})

describe('qualification audit command', () => {
  for (const output of ['audit', 'dossier'] as const) {
    test(`fails closed without exposing credentials in ${output} test mode`, async () => {
      const result = await runCommand(output)
      const outputText = `${result.stdout}\n${result.stderr}`

      expect(result.exitCode).not.toBe(0)
      expect(outputText).toContain('PostgreSQL read-only qualification audit failed')
      for (const secret of secretMarkers) {
        expect(outputText).not.toContain(secret)
      }
    })
  }

  test('bounds the configured audit replica set before opening database or ClickHouse clients', async () => {
    const urls = Array.from({ length: 9 }, (_, index) => `http://audit-${index}.invalid`).join(',')
    const result = await runCommand('audit', { BAYN_AUDIT_CLICKHOUSE_URLS: urls })
    const outputText = `${result.stdout}\n${result.stderr}`

    expect(result.exitCode).not.toBe(0)
    expect(outputText).toContain('BAYN_AUDIT_CLICKHOUSE_URLS')
    expect(outputText).not.toContain('PostgreSQL read-only qualification audit failed')
  })

  test('keeps live reader acquisition lazy and stops after the first failed audit phase', async () => {
    const acquisitions = { database: 0, repository: 0, signal: 0, signalReplica: 0 }
    const input = auditConfig()
    const readers = makeQualificationAuditReaders(input, {
      database: () =>
        Effect.sync(() => {
          acquisitions.database += 1
          return { read: () => Effect.succeed(opaqueDatabase) }
        }),
      signal: () =>
        Effect.sync(() => {
          acquisitions.signal += 1
          throw new Error('Signal must not be acquired after the database phase fails')
        }),
      signalReplica: () =>
        Effect.sync(() => {
          acquisitions.signalReplica += 1
          throw new Error('Signal replicas must not be acquired after the database phase fails')
        }),
      repository: () =>
        Effect.sync(() => {
          acquisitions.repository += 1
          throw new Error('Repository access must not be acquired after the database phase fails')
        }),
    })

    const failure = await Effect.runPromise(Effect.flip(runQualificationAudit(input, readers)))

    expect(failure.message).toBe('input-manifest artifact is missing')
    expect(acquisitions).toEqual({ database: 1, repository: 0, signal: 0, signalReplica: 0 })
  })

  test('verifies the persisted source checkout before loading an audited strategy', async () => {
    const sourceRevision = 'c'.repeat(40)
    const repositoryFailure = new QualificationAuditCommandError({
      operation: 'repository',
      message: 'audit repository must be a clean checkout at the persisted source revision',
    })
    const database = {
      ...opaqueDatabase,
      run: { ...opaqueDatabase.run, sourceRevision },
      artifacts: [
        {
          name: 'input-manifest',
          schemaVersion: signalSnapshot.manifest.schemaVersion,
          contentHash: 'd'.repeat(64),
          payload: signalSnapshot.manifest,
        },
      ],
    } as unknown as AuditDatabaseSnapshot
    const input = auditConfig()
    const readers = makeQualificationAuditReaders(input, {
      database: () => Effect.succeed({ read: () => Effect.succeed(database) }),
      signal: () => Effect.die('signal must not be acquired before source verification'),
      signalReplica: () => Effect.die('signal replica must not be acquired before source verification'),
      repository: () =>
        Effect.succeed({
          verifySourceCheckout: () => Effect.fail(repositoryFailure),
          audit: () => Effect.fail(repositoryFailure),
        }),
    })

    const failure = await Effect.runPromise(Effect.flip(runQualificationAudit(input, readers)))

    expect(failure).toBe(repositoryFailure)
  })

  test('acquires, uses, and releases the PostgreSQL audit client exactly once', async () => {
    let acquisitions = 0
    let releases = 0

    const result = await Effect.runPromise(
      readAuditDatabase<never>(auditConfig(), auditConfig().runId, () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions += 1
            return { read: () => Effect.succeed(opaqueDatabase) }
          }),
          () =>
            Effect.sync(() => {
              releases += 1
            }),
        ),
      ),
    )

    expect(result).toBe(opaqueDatabase)
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
  })

  test('interrupts an in-flight PostgreSQL audit read and releases the client exactly once', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const acquisitions = yield* Ref.make(0)
        const releases = yield* Ref.make(0)
        const fiber = yield* readAuditDatabase<never>(auditConfig(), auditConfig().runId, () =>
          Effect.acquireRelease(
            Ref.update(acquisitions, (count) => count + 1).pipe(
              Effect.as({
                read: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              }),
            ),
            () => Ref.update(releases, (count) => count + 1),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Effect.all({
          acquisitions: Ref.get(acquisitions),
          releases: Ref.get(releases),
        })
      }),
    )

    expect(counts).toEqual({ acquisitions: 1, releases: 1 })
  })

  test('acquires, uses, and releases the Signal audit client exactly once', async () => {
    let acquisitions = 0
    let releases = 0

    const result = await Effect.runPromise(
      loadAuditSignal<never>(auditConfig(), signalSnapshot.manifest, fixtureProtocol, () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions += 1
            return { load: () => Effect.succeed(signalSnapshot) }
          }),
          () =>
            Effect.sync(() => {
              releases += 1
            }),
        ),
      ),
    )

    expect(result).toBe(signalSnapshot)
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
  })

  test('interrupts an in-flight Signal audit read and releases the client exactly once', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const acquisitions = yield* Ref.make(0)
        const releases = yield* Ref.make(0)
        const fiber = yield* loadAuditSignal<never>(auditConfig(), signalSnapshot.manifest, fixtureProtocol, () =>
          Effect.acquireRelease(
            Ref.update(acquisitions, (count) => count + 1).pipe(
              Effect.as({
                load: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              }),
            ),
            () => Ref.update(releases, (count) => count + 1),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Effect.all({
          acquisitions: Ref.get(acquisitions),
          releases: Ref.get(releases),
        })
      }),
    )

    expect(counts).toEqual({ acquisitions: 1, releases: 1 })
  })

  test('acquires, reads, and releases every query-log replica client exactly once', async () => {
    const input = auditConfig()
    const topology = input.auditClickhouseUrls.map((_, index) => `replica-${index}`)
    let acquisitions = 0
    let releases = 0

    const result = await Effect.runPromise(
      readAuditSignalAccess<never>(
        input,
        opaqueDatabase,
        '2026-07-24T00:00:00.000000Z',
        signalSnapshot.manifest.tables,
        (_config, url) =>
          Effect.acquireRelease(
            Effect.sync((): AuditSignalReplicaClient => {
              acquisitions += 1
              const index = input.auditClickhouseUrls.findIndex((candidate) => candidate.href === url.href)
              return { url, read: () => Effect.succeed(replicaSource(index, topology)) }
            }),
            () =>
              Effect.sync(() => {
                releases += 1
              }),
          ),
      ),
    )

    expect(result.replicas).toEqual(topology)
    expect(acquisitions).toBe(2)
    expect(releases).toBe(2)
  })

  test('interrupts a sibling query-log read and releases every replica client after failure', async () => {
    const input = auditConfig()
    const topology = input.auditClickhouseUrls.map((_, index) => `replica-${index}`)
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const readsStarted = yield* Ref.make(0)
        const bothStarted = yield* Deferred.make<void>()
        const siblingFinalized = yield* Ref.make(0)
        const releases = yield* Ref.make(0)
        const failure = yield* readAuditSignalAccess<never>(
          input,
          opaqueDatabase,
          '2026-07-24T00:00:00.000000Z',
          signalSnapshot.manifest.tables,
          (_config, url) =>
            Effect.acquireRelease(
              Effect.sync((): AuditSignalReplicaClient => {
                const index = input.auditClickhouseUrls.findIndex((candidate) => candidate.href === url.href)
                return {
                  url,
                  read: () =>
                    Ref.updateAndGet(readsStarted, (count) => count + 1).pipe(
                      Effect.tap((count) =>
                        count === input.auditClickhouseUrls.length
                          ? Deferred.succeed(bothStarted, undefined)
                          : Effect.void,
                      ),
                      Effect.andThen(Deferred.await(bothStarted)),
                      Effect.andThen(
                        index === 0
                          ? Effect.fail(
                              new QualificationAuditCommandError({
                                operation: 'signal-access',
                                message: 'fixture query-log failure',
                              }),
                            )
                          : Effect.never.pipe(Effect.ensuring(Ref.update(siblingFinalized, (count) => count + 1))),
                      ),
                    ),
                }
              }),
              () => Ref.update(releases, (count) => count + 1),
            ),
        ).pipe(Effect.flip)
        return {
          failure,
          releases: yield* Ref.get(releases),
          siblingFinalized: yield* Ref.get(siblingFinalized),
          started: yield* Ref.get(readsStarted),
          topology,
        }
      }),
    )

    expect(observed.failure.message).toBe('fixture query-log failure')
    expect(observed.started).toBe(2)
    expect(observed.siblingFinalized).toBe(1)
    expect(observed.releases).toBe(2)
  })

  test('limits query-log reads to four concurrent replicas', async () => {
    const urls = Array.from({ length: 8 }, (_, index) => new URL(`http://audit-${index}.invalid`))
    const input = auditConfig({ auditClickhouseUrls: urls })
    const topology = urls.map((_, index) => `replica-${index}`)
    const maximum = await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* Ref.make(0)
        const maximum = yield* Ref.make(0)
        const reachedFour = yield* Deferred.make<void>()
        const releaseReads = yield* Deferred.make<void>()
        const fiber = yield* readAuditSignalAccess<never>(
          input,
          opaqueDatabase,
          '2026-07-24T00:00:00.000000Z',
          signalSnapshot.manifest.tables,
          (_config, url) =>
            Effect.succeed({
              url,
              read: () =>
                Effect.acquireUseRelease(
                  Ref.updateAndGet(active, (count) => count + 1).pipe(
                    Effect.tap((count) => Ref.update(maximum, (current) => Math.max(current, count))),
                    Effect.tap((count) => (count === 4 ? Deferred.succeed(reachedFour, undefined) : Effect.void)),
                  ),
                  () =>
                    Deferred.await(releaseReads).pipe(
                      Effect.as(
                        replicaSource(
                          urls.findIndex((candidate) => candidate.href === url.href),
                          topology,
                        ),
                      ),
                    ),
                  () => Ref.update(active, (count) => count - 1),
                ),
            }),
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(reachedFour)
        const observed = yield* Ref.get(maximum)
        yield* Deferred.succeed(releaseReads, undefined)
        yield* Fiber.join(fiber)
        return observed
      }),
    )

    expect(maximum).toBe(4)
  })
})
