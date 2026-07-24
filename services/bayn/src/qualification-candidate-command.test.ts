import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect } from 'effect'

import {
  loadQualificationCandidateConfig,
  makeCandidatePostgresSslOptions,
  QualificationCandidateError,
  verifyQualificationCandidate,
  type CandidateReplicaObservation,
  type QualificationCandidateInput,
  type QualificationCandidateReaders,
} from './qualification-candidate-command'
import { fixtureProtocol, makeSnapshot } from './test-fixtures'

const publisherPrincipal = 'signal_publisher'
const endpoints = [
  new URL('http://signal-clickhouse-0.signal.svc:8123'),
  new URL('http://signal-clickhouse-1.signal.svc:8123'),
] as const
const snapshot = makeSnapshot(270)
const publicationDate = snapshot.manifest.finalizedSnapshot.asOfSession

const candidateEnvironment = (): Record<string, string> => ({
  BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE: publicationDate,
  BAYN_CANDIDATE_CLICKHOUSE_URLS: endpoints.map((endpoint) => endpoint.href).join(','),
  BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME: publisherPrincipal,
  BAYN_CANDIDATE_SIGNAL_PUBLISHER_PASSWORD: 'publisher-password',
  BAYN_CANDIDATE_POSTGRES_URL: 'postgresql://bayn:password@127.0.0.1:5432/bayn',
  BAYN_CANDIDATE_POSTGRES_TLS: 'true',
  BAYN_CANDIDATE_POSTGRES_CA_PATH: '/tmp/bayn-ca.crt',
  BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME: 'bayn-db-rw.bayn',
  BAYN_CANDIDATE_TIGERBEETLE_CLUSTER_ID: '122731676035874920802382025803517750735',
  BAYN_CANDIDATE_TIGERBEETLE_ADDRESSES:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000',
  BAYN_CANDIDATE_TIGERBEETLE_LEDGER: '7001',
})

const loadCandidateConfig = (environment: Record<string, string>) =>
  Effect.runPromise(
    loadQualificationCandidateConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    ),
  )

const input = (overrides: Partial<QualificationCandidateInput> = {}): QualificationCandidateInput => ({
  publicationDate,
  clickhouseUrls: endpoints,
  publisherPrincipal,
  protocol: fixtureProtocol,
  tigerBeetleClusterId: '122731676035874920802382025803517750735',
  tigerBeetleAddresses:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000',
  tigerBeetleLedger: '7001',
  ...overrides,
})

const observations = (
  overrides: Partial<CandidateReplicaObservation>[] = [],
): readonly CandidateReplicaObservation[] => [
  {
    endpointHost: endpoints[0].hostname,
    replica: 'chi-torghut-clickhouse-default-0-0-0',
    principal: publisherPrincipal,
    snapshot,
    ...overrides[0],
  },
  {
    endpointHost: endpoints[1].hostname,
    replica: 'chi-torghut-clickhouse-default-0-1-0',
    principal: publisherPrincipal,
    snapshot,
    ...overrides[1],
  },
]

const readers = (
  replicaObservations: readonly CandidateReplicaObservation[] = observations(),
  lockCount = 0,
): QualificationCandidateReaders => ({
  readReplica: (endpoint) => {
    const observation = replicaObservations.find((candidate) => candidate.endpointHost === endpoint.hostname)
    return observation === undefined
      ? Effect.fail(
          new QualificationCandidateError({
            operation: 'replica',
            message: `missing fixture for ${endpoint.hostname}`,
          }),
        )
      : Effect.succeed(observation)
  },
  readQualificationLocks: () =>
    Effect.succeed({
      transactionReadOnly: true,
      count: lockCount,
    }),
})

const failure = async (
  candidateInput: QualificationCandidateInput,
  candidateReaders: QualificationCandidateReaders,
): Promise<QualificationCandidateError> =>
  Effect.runPromise(Effect.flip(verifyQualificationCandidate(candidateInput, candidateReaders)))

describe('qualification candidate command', () => {
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

    expect(error).toBeInstanceOf(QualificationCandidateError)
    expect(error).toMatchObject({
      operation: 'config',
      message: 'BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME is required when PostgreSQL TLS is enabled',
    })
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

      expect(String(error)).toContain('BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME')
      expect(String(error)).toContain('non-empty DNS name')
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

    expect(error).toBeInstanceOf(QualificationCandidateError)
    expect(error).toMatchObject({
      operation: 'config',
      message:
        'BAYN_CANDIDATE_POSTGRES_CA_PATH and BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME must be absent when PostgreSQL TLS is disabled',
    })
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

    expect(error).toBeInstanceOf(QualificationCandidateError)
    expect(error).toMatchObject({
      operation: 'config',
      message: 'invalid BAYN_CANDIDATE_POSTGRES_URL',
    })
    expect(String(error.cause)).toContain('must not contain TLS or routing override parameter sslmode')
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

    expect(error).toBeInstanceOf(QualificationCandidateError)
    expect(error).toMatchObject({
      operation: 'config',
      message: 'invalid BAYN_CANDIDATE_POSTGRES_URL',
    })
    expect(String(error.cause)).toContain('host must be an IP literal or exactly match')
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

      expect(error).toBeInstanceOf(QualificationCandidateError)
      expect(error).toMatchObject({
        operation: 'config',
        message: 'invalid BAYN_CANDIDATE_POSTGRES_URL',
      })
      expect(String(error.cause)).toContain('must not contain TLS or routing override parameter')
    },
  )

  test('emits one deterministic complete runtime from direct physical hosts without topology metadata', async () => {
    let checkedSnapshotId: string | undefined
    const candidateReaders = readers()
    const report = await Effect.runPromise(
      verifyQualificationCandidate(input(), {
        ...candidateReaders,
        readQualificationLocks: (snapshotId) => {
          checkedSnapshotId = snapshotId
          return candidateReaders.readQualificationLocks(snapshotId)
        },
      }),
    )

    expect(checkedSnapshotId).toBe(snapshot.manifest.finalizedSnapshot.snapshotId)
    expect(report).toMatchObject({
      schemaVersion: 'bayn.qualification-candidate.v1',
      publicationDate,
      publisherPrincipal,
      inputManifestHash: snapshot.manifest.hash,
      rowCount: snapshot.manifest.rowCount,
      sessionCount: snapshot.manifest.sessionCount,
      qualificationLockCount: 0,
      candidateRuntime: {
        BAYN_SIGNAL_SNAPSHOT_ID: snapshot.manifest.finalizedSnapshot.snapshotId,
        BAYN_SIGNAL_PUBLICATION_ASOF: publicationDate,
        BAYN_SIGNAL_CALENDAR_VERSION: snapshot.manifest.finalizedSnapshot.calendarVersion,
        BAYN_SIGNAL_DATA_START: fixtureProtocol.historyStart,
        BAYN_SIGNAL_DATA_END: publicationDate,
        BAYN_SIGNAL_LOOKBACK_START: fixtureProtocol.historyStart,
        BAYN_SIGNAL_EVALUATION_START: fixtureProtocol.evaluationStart,
        BAYN_SIGNAL_EVALUATION_END: publicationDate,
        BAYN_TIGERBEETLE_CLUSTER_ID: input().tigerBeetleClusterId,
        BAYN_TIGERBEETLE_ADDRESSES: input().tigerBeetleAddresses,
        BAYN_TIGERBEETLE_LEDGER: input().tigerBeetleLedger,
      },
    })
    expect(report.replicas.map((replica) => replica.replica)).toEqual([
      'chi-torghut-clickhouse-default-0-0-0',
      'chi-torghut-clickhouse-default-0-1-0',
    ])
    expect(new Set(report.replicas.map((replica) => replica.snapshotCanonicalHash)).size).toBe(1)
  })

  test.each([
    {
      name: 'duplicate endpoint',
      urls: [endpoints[0], endpoints[0]],
      expected: 'ClickHouse replica endpoints must be distinct',
    },
    {
      name: 'duplicate host',
      urls: [endpoints[0], new URL('https://signal-clickhouse-0.signal.svc:8443')],
      expected: 'ClickHouse replica endpoint hosts must be distinct',
    },
    {
      name: 'credential-bearing endpoint',
      urls: [new URL('http://signal_publisher:secret@signal-clickhouse-0.signal.svc:8123'), endpoints[1]],
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

    const error = await failure(input({ clickhouseUrls: urls }), candidateReaders)
    expect(error.message).toBe('invalid candidate replica endpoints')
    expect(String(error.cause)).toContain(expected)
    if (forbidden !== undefined) expect(String(error.cause)).not.toContain(forbidden)
    expect(reads).toBe(0)
  })

  test('rejects duplicate observed physical hostnames', async () => {
    const error = await failure(
      input(),
      readers(observations([{}, { replica: 'chi-torghut-clickhouse-default-0-0-0' }])),
    )

    expect(error.message).toBe('Signal replica candidate verification failed')
    expect(String(error.cause)).toContain('same physical replica')
  })

  test('rejects distinct physical hosts outside the source-controlled replica pair', async () => {
    const error = await failure(
      input(),
      readers(observations([{}, { replica: 'chi-another-clickhouse-default-0-1-0' }])),
    )

    expect(error.message).toBe('Signal replica candidate verification failed')
    expect(String(error.cause)).toContain('source-controlled physical replica identities')
  })

  test('rejects canonical snapshot divergence across replicas', async () => {
    const [firstBar, ...remainingBars] = snapshot.bars
    if (firstBar === undefined) throw new Error('snapshot fixture requires at least one bar')
    const divergentSnapshot = {
      ...snapshot,
      bars: [{ ...firstBar, close: firstBar.close + 1 }, ...remainingBars],
    }
    const error = await failure(input(), readers(observations([{}, { snapshot: divergentSnapshot }])))

    expect(error.message).toBe('Signal replica candidate verification failed')
    expect(String(error.cause)).toContain('snapshots diverge across physical replicas')
  })

  test('rejects a read performed by a principal other than the declared Signal publisher', async () => {
    const error = await failure(input(), readers(observations([{}, { principal: 'bayn' }])))

    expect(error.message).toBe('Signal replica candidate verification failed')
    expect(String(error.cause)).toContain('declared Signal publisher principal')
  })

  test('does not start a sibling replica read after a normal replica failure', async () => {
    const reads: string[] = []
    const error = await failure(input(), {
      readReplica: (endpoint) => {
        reads.push(endpoint.hostname)
        return Effect.fail(
          new QualificationCandidateError({
            operation: 'replica',
            message: `failed ${endpoint.hostname}`,
          }),
        )
      },
      readQualificationLocks: () => Effect.die(new Error('failed replica must stop before PostgreSQL')),
    })

    expect(error.message).toBe(`failed ${endpoints[0].hostname}`)
    expect(reads).toEqual([endpoints[0].hostname])
  })

  test.each([
    {
      name: 'cluster ID',
      overrides: { tigerBeetleClusterId: '0' },
      expected: 'outside the unsigned 128-bit range',
    },
    {
      name: 'transport addresses',
      overrides: { tigerBeetleAddresses: 'ledger-0:3000, ledger-1:3000' },
      expected: 'canonical comma-separated transport list',
    },
    {
      name: 'ledger',
      overrides: { tigerBeetleLedger: String(2 ** 32) },
      expected: 'outside the unsigned 32-bit range',
    },
  ])('rejects malformed candidate runtime $name', async ({ overrides, expected }) => {
    const error = await failure(input(overrides), readers())

    expect(error.message).toBe('Signal replica candidate verification failed')
    expect(String(error.cause)).toContain(expected)
  })

  test('rejects a snapshot already consumed by a qualification lock', async () => {
    const error = await failure(input(), readers(observations(), 1))

    expect(error.operation).toBe('postgres')
    expect(error.message).toContain('is already consumed by 1 qualification lock(s)')
  })

  test('rejects a qualification-lock check that was not transactionally read-only', async () => {
    const candidateReaders = readers()
    const error = await failure(input(), {
      ...candidateReaders,
      readQualificationLocks: () => Effect.succeed({ transactionReadOnly: false, count: 0 }),
    })

    expect(error.operation).toBe('postgres')
    expect(error.message).toBe('qualification-lock check was not read-only')
  })
})
