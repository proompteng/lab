import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Context, Effect } from 'effect'

import {
  QualificationCandidateError,
  renderQualificationCandidateFailure,
  toQualificationCandidateError,
  type QualificationCandidateFailure,
} from './failure'
import { makeCandidatePostgresSslOptions } from './live'
import type { QualificationCandidateInput, QualificationCandidateReaders } from './model'
import { loadQualificationCandidateConfig, verifyQualificationCandidate } from './program'
import {
  candidateEndpoints,
  candidateEnvironment,
  candidateInput,
  candidateObservations,
  candidatePublicationDate,
  candidatePublisherPrincipal,
  candidateReaders,
  candidateSnapshot,
} from './test-fixtures'

const loadCandidateConfig = (environment: Record<string, string>) =>
  Effect.runPromise(
    loadQualificationCandidateConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    ),
  )

const failure = async (
  candidateInput: QualificationCandidateInput,
  candidateReaders: QualificationCandidateReaders,
): Promise<QualificationCandidateFailure> =>
  Effect.runPromise(Effect.flip(verifyQualificationCandidate(candidateInput, candidateReaders)))

class ReaderRequirement extends Context.Service<ReaderRequirement, { readonly enabled: true }>()(
  'bayn/test/QualificationCandidateReaderRequirement',
) {}

describe('qualification candidate command', () => {
  test('converts pure failure data to one cause-preserving runtime error', () => {
    const failure: QualificationCandidateFailure = { _tag: 'PostgresTlsServerNameMissing' }
    const error = toQualificationCandidateError(failure)

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(QualificationCandidateError)
    expect(error).toMatchObject({
      _tag: 'QualificationCandidateError',
      operation: 'config',
      message: 'BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME is required when PostgreSQL TLS is enabled',
      failure,
      cause: failure,
    })
  })

  test('requires a decoded PostgreSQL TLS server identity before candidate I/O', async () => {
    const environment = candidateEnvironment()
    delete environment.BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME

    const error = await Effect.runPromise(
      Effect.flip(
        loadQualificationCandidateConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )

    expect(error).toEqual({ _tag: 'PostgresTlsServerNameMissing' })
    expect(renderQualificationCandidateFailure(error)).toBe(
      'BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME is required when PostgreSQL TLS is enabled',
    )
  })

  test.each([' ', '127.0.0.1', 'bayn-db-rw.bayn:5432', 'bayn_db_rw.bayn', '-bayn-db-rw.bayn'])(
    'rejects invalid PostgreSQL TLS server identity %j',
    async (serverName) => {
      const environment = candidateEnvironment()
      environment.BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME = serverName

      const error = await Effect.runPromise(
        Effect.flip(
          loadQualificationCandidateConfig.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
          ),
        ),
      )

      expect(error._tag).toBe('ConfigurationLoadFailed')
      if (error._tag !== 'ConfigurationLoadFailed') return
      expect(String(error.cause)).toContain('BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME')
      expect(String(error.cause)).toContain('non-empty DNS name')
    },
  )

  test('allows missing PostgreSQL TLS identity only when TLS is disabled', async () => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_TLS = 'false'
    delete environment.BAYN_CANDIDATE_POSTGRES_CA_PATH
    delete environment.BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME

    const loaded = await loadCandidateConfig(environment)

    expect(loaded.postgresTls).toBeUndefined()
  })

  test.each([
    ['CA path only', { BAYN_CANDIDATE_POSTGRES_CA_PATH: '/tmp/bayn-ca.crt' }],
    ['server identity only', { BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME: 'bayn-db-rw.bayn' }],
    [
      'CA path and server identity',
      {
        BAYN_CANDIDATE_POSTGRES_CA_PATH: '/tmp/bayn-ca.crt',
        BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME: 'bayn-db-rw.bayn',
      },
    ],
  ])('rejects TLS-disabled config with %s before I/O', async (_description, tlsEnvironment) => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_TLS = 'false'
    delete environment.BAYN_CANDIDATE_POSTGRES_CA_PATH
    delete environment.BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME
    Object.assign(environment, tlsEnvironment)

    const error = await Effect.runPromise(
      Effect.flip(
        loadQualificationCandidateConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )

    expect(error).toEqual({ _tag: 'PostgresTlsFieldsPresentWhileDisabled' })
  })

  test('rejects a connection-string TLS override even when configured TLS is disabled', async () => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_TLS = 'false'
    environment.BAYN_CANDIDATE_POSTGRES_URL = 'postgresql://bayn:password@127.0.0.1:5432/bayn?sslmode=no-verify'
    delete environment.BAYN_CANDIDATE_POSTGRES_CA_PATH
    delete environment.BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME

    const error = await Effect.runPromise(
      Effect.flip(
        loadQualificationCandidateConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )

    expect(error).toEqual({ _tag: 'PostgresUrlOverride', parameter: 'sslmode' })
  })

  test('rejects a malformed PostgreSQL URL without retaining credential text', async () => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_URL = 'not-a-url-with-secret-password'

    const error = await Effect.runPromise(
      Effect.flip(
        loadQualificationCandidateConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )

    expect(error).toEqual({ _tag: 'PostgresUrlMalformed' })
    expect(renderQualificationCandidateFailure(error)).not.toContain('secret-password')
    expect(JSON.stringify(error)).not.toContain('secret-password')
  })

  test('rejects a non-IP tunnel host that differs from the certificate identity before I/O', async () => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_URL = 'postgresql://bayn:password@localhost:5432/bayn'

    const error = await Effect.runPromise(
      Effect.flip(
        loadQualificationCandidateConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )

    expect(error).toEqual({
      _tag: 'PostgresTlsHostMismatch',
      host: 'localhost',
      expectedServerName: 'bayn-db-rw.bayn',
    })
  })

  test('accepts an IP-literal tunnel URL and resolves exact verified PostgreSQL TLS options', async () => {
    const loaded = await loadCandidateConfig(candidateEnvironment())
    if (loaded.postgresTls === undefined) throw new Error('TLS fixture must resolve PostgreSQL TLS options')

    expect(loaded.postgresTls).toEqual({
      caPath: '/tmp/bayn-ca.crt',
      serverName: 'bayn-db-rw.bayn',
    })
    expect(makeCandidatePostgresSslOptions(loaded.postgresTls.serverName, 'test-ca')).toEqual({
      ca: 'test-ca',
      rejectUnauthorized: true,
      servername: 'bayn-db-rw.bayn',
    })
  })

  test('accepts a PostgreSQL DNS host exactly matching the certificate identity', async () => {
    const environment = candidateEnvironment()
    environment.BAYN_CANDIDATE_POSTGRES_URL = 'postgresql://bayn:password@bayn-db-rw.bayn:5432/bayn'

    const loaded = await loadCandidateConfig(environment)

    expect(loaded.postgresTls?.serverName).toBe('bayn-db-rw.bayn')
  })

  test.each(['sslmode=require', 'ssl=true', 'host=127.0.0.1'])(
    'rejects PostgreSQL URL override query %s before I/O',
    async (query) => {
      const environment = candidateEnvironment()
      environment.BAYN_CANDIDATE_POSTGRES_URL = `postgresql://bayn:password@127.0.0.1:5432/bayn?${query}`

      const error = await Effect.runPromise(
        Effect.flip(
          loadQualificationCandidateConfig.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
          ),
        ),
      )

      expect(error).toEqual({ _tag: 'PostgresUrlOverride', parameter: query.split('=')[0] })
    },
  )

  test('emits one deterministic complete runtime from direct physical hosts without topology metadata', async () => {
    let checkedSnapshotId: string | undefined
    const readers = candidateReaders()
    const report = await Effect.runPromise(
      verifyQualificationCandidate(candidateInput(), {
        ...readers,
        readQualificationLocks: (snapshotId) => {
          checkedSnapshotId = snapshotId
          return readers.readQualificationLocks(snapshotId)
        },
      }),
    )

    expect(checkedSnapshotId).toBe(candidateSnapshot.manifest.finalizedSnapshot.snapshotId)
    expect(report).toMatchObject({
      schemaVersion: 'bayn.qualification-candidate.v1',
      publicationDate: candidatePublicationDate,
      publisherPrincipal: candidatePublisherPrincipal,
      inputManifestHash: candidateSnapshot.manifest.hash,
      rowCount: candidateSnapshot.manifest.rowCount,
      sessionCount: candidateSnapshot.manifest.sessionCount,
      qualificationLockCount: 0,
      candidateRuntime: {
        BAYN_SIGNAL_SNAPSHOT_ID: candidateSnapshot.manifest.finalizedSnapshot.snapshotId,
        BAYN_SIGNAL_PUBLICATION_ASOF: candidatePublicationDate,
        BAYN_SIGNAL_CALENDAR_VERSION: candidateSnapshot.manifest.finalizedSnapshot.calendarVersion,
        BAYN_SIGNAL_DATA_START: candidateInput().protocol.historyStart,
        BAYN_SIGNAL_DATA_END: candidatePublicationDate,
        BAYN_SIGNAL_LOOKBACK_START: candidateInput().protocol.historyStart,
        BAYN_SIGNAL_EVALUATION_START: candidateInput().protocol.evaluationStart,
        BAYN_SIGNAL_EVALUATION_END: candidatePublicationDate,
        BAYN_TIGERBEETLE_CLUSTER_ID: candidateInput().tigerBeetleClusterId,
        BAYN_TIGERBEETLE_ADDRESSES: candidateInput().tigerBeetleAddresses,
        BAYN_TIGERBEETLE_LEDGER: candidateInput().tigerBeetleLedger,
      },
    })
    expect(report.replicas.map((replica) => replica.replica)).toEqual([
      'chi-torghut-clickhouse-default-0-0-0',
      'chi-torghut-clickhouse-default-0-1-0',
    ])
    expect(new Set(report.replicas.map((replica) => replica.snapshotCanonicalHash)).size).toBe(1)
  })

  test('keeps reader requirements visible until the composition boundary', async () => {
    const readers = candidateReaders()
    const report = await Effect.runPromise(
      verifyQualificationCandidate(candidateInput(), {
        readReplica: (endpoint) =>
          ReaderRequirement.pipe(
            Effect.flatMap((requirement) =>
              requirement.enabled
                ? readers.readReplica(endpoint)
                : Effect.die(new Error('reader requirement must be enabled')),
            ),
          ),
        readQualificationLocks: (snapshotId) =>
          ReaderRequirement.pipe(
            Effect.flatMap((requirement) =>
              requirement.enabled
                ? readers.readQualificationLocks(snapshotId)
                : Effect.die(new Error('reader requirement must be enabled')),
            ),
          ),
      }).pipe(Effect.provideService(ReaderRequirement, { enabled: true })),
    )

    expect(report.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID).toBe(
      candidateSnapshot.manifest.finalizedSnapshot.snapshotId,
    )
  })

  test.each([
    {
      name: 'duplicate endpoint',
      urls: [candidateEndpoints[0], candidateEndpoints[0]],
      expected: 'ClickHouse replica endpoints must be distinct',
    },
    {
      name: 'duplicate host',
      urls: [candidateEndpoints[0], new URL('https://signal-clickhouse-0.signal.svc:8443')],
      expected: 'ClickHouse replica endpoint hosts must be distinct',
    },
    {
      name: 'credential-bearing endpoint',
      urls: [new URL('http://signal_publisher:secret@signal-clickhouse-0.signal.svc:8123'), candidateEndpoints[1]],
      expected: 'direct credential-free HTTP(S) origin',
      forbidden: 'secret',
    },
  ])('rejects a $name before any replica read', async ({ urls, expected, forbidden }) => {
    let reads = 0
    const candidateReaders: QualificationCandidateReaders = {
      readReplica: () => {
        reads += 1
        return Effect.die(new Error('invalid endpoints must fail before reading'))
      },
      readQualificationLocks: () => Effect.die(new Error('invalid endpoints must fail before PostgreSQL')),
    }

    const error = await failure(candidateInput({ clickhouseUrls: urls }), candidateReaders)
    const rendered = renderQualificationCandidateFailure(error)
    expect(rendered).toContain(expected)
    if (forbidden !== undefined) expect(rendered).not.toContain(forbidden)
    expect(reads).toBe(0)
  })

  test('does not start a sibling replica read after a normal replica failure', async () => {
    const reads: string[] = []
    const error = await failure(candidateInput(), {
      readReplica: (endpoint) => {
        reads.push(endpoint.hostname)
        return Effect.fail({
          _tag: 'ReplicaReadFailed',
          endpointHost: endpoint.hostname,
          cause: 'fixture failure',
        } as const)
      },
      readQualificationLocks: () => Effect.die(new Error('failed replica must stop before PostgreSQL')),
    })

    expect(error).toMatchObject({ _tag: 'ReplicaReadFailed', endpointHost: candidateEndpoints[0].hostname })
    expect(reads).toEqual([candidateEndpoints[0].hostname])
  })

  test('rejects a snapshot already consumed by a qualification lock', async () => {
    const error = await failure(candidateInput(), candidateReaders(candidateObservations(), 1))

    expect(error).toMatchObject({ _tag: 'SnapshotAlreadyConsumed', count: 1 })
  })

  test('rejects a qualification-lock check that was not transactionally read-only', async () => {
    const readers = candidateReaders()
    const error = await failure(candidateInput(), {
      ...readers,
      readQualificationLocks: () => Effect.succeed({ transactionReadOnly: false, count: 0 }),
    })

    expect(error).toEqual({ _tag: 'QualificationLockCheckNotReadOnly' })
  })
})
