import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Config, Data, Effect, FileSystem, Layer, Redacted, Schema, Stdio, Stream } from 'effect'

import type { BaynCandidateRuntime } from '../../../packages/scripts/src/bayn/update-manifests'

import { canonicalHashV1, canonicalJsonV1 } from './hash'
import { MarketData, MarketDataLive, type MarketDataSnapshot } from './market-data'
import { loadDefaultProtocol } from './protocol'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  TrimmedNonEmptyStringSchema,
  strictParseOptions,
  type IsoDate,
} from './schemas'
import type { CausalProtocol } from './types'

const maximumTigerBeetleClusterId = (1n << 128n) - 1n
const maximumTigerBeetleLedger = 2 ** 32 - 1
const canonicalDecimalPattern = /^(?:0|[1-9][0-9]*)$/
const transportAddressesPattern = /^[A-Za-z0-9.[\]:_-]+(?:,[A-Za-z0-9.[\]:_-]+)*$/

const ExactReplicaUrls = Config.Array(Schema.URLFromString).check(
  Schema.makeFilter((urls: readonly URL[]) => urls.length === 2, {
    expected: 'exactly two direct ClickHouse replica URLs',
  }),
)
const CandidateRow = Schema.Struct({
  snapshot_id: Sha256Schema,
  calendar_version: TrimmedNonEmptyStringSchema,
})
const ReplicaIdentityRow = Schema.Struct({
  replica: TrimmedNonEmptyStringSchema,
  principal: TrimmedNonEmptyStringSchema,
})
const ReadOnlyRow = Schema.Struct({ read_only: Schema.Boolean })
const LockCountRow = Schema.Struct({
  lock_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const decodeCandidateRow = Schema.decodeUnknownEffect(Schema.Tuple([CandidateRow]), strictParseOptions)
const decodeReplicaIdentity = Schema.decodeUnknownEffect(Schema.Tuple([ReplicaIdentityRow]), strictParseOptions)
const decodeReadOnlyRow = Schema.decodeUnknownEffect(Schema.Tuple([ReadOnlyRow]), strictParseOptions)
const decodeLockCountRow = Schema.decodeUnknownEffect(Schema.Tuple([LockCountRow]), strictParseOptions)

const config = Config.all({
  publicationDate: Config.schema(IsoDateSchema, 'BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE'),
  clickhouseUrls: Config.schema(ExactReplicaUrls, 'BAYN_CANDIDATE_CLICKHOUSE_URLS'),
  publisherUsername: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME'),
  publisherPassword: Config.redacted('BAYN_CANDIDATE_SIGNAL_PUBLISHER_PASSWORD'),
  postgresUrl: Config.redacted('BAYN_CANDIDATE_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_CANDIDATE_POSTGRES_TLS').pipe(Config.withDefault(false)),
  postgresCaPath: Config.string('BAYN_CANDIDATE_POSTGRES_CA_PATH').pipe(Config.withDefault('')),
  tigerBeetleClusterId: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_CLUSTER_ID'),
  tigerBeetleAddresses: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_ADDRESSES'),
  tigerBeetleLedger: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_LEDGER'),
  operationTimeoutMs: Config.schema(PositiveIntegerSchema, 'BAYN_CANDIDATE_OPERATION_TIMEOUT_MS').pipe(
    Config.withDefault(60_000),
  ),
})

type CandidateConfig = Config.Success<typeof config>

export class QualificationCandidateError extends Data.TaggedError('QualificationCandidateError')<{
  readonly operation: 'config' | 'postgres' | 'replica' | 'runtime'
  readonly message: string
  readonly cause?: unknown
}> {}

const candidateError = (
  operation: QualificationCandidateError['operation'],
  message: string,
  cause?: unknown,
): QualificationCandidateError => new QualificationCandidateError({ operation, message, cause })

const preserveCandidateError = (
  operation: QualificationCandidateError['operation'],
  message: string,
  cause: unknown,
): QualificationCandidateError =>
  cause instanceof QualificationCandidateError ? cause : candidateError(operation, message, cause)

export interface CandidateReplicaObservation {
  readonly endpointHost: string
  readonly replica: string
  readonly principal: string
  readonly snapshot: MarketDataSnapshot
}

export interface QualificationLockObservation {
  readonly transactionReadOnly: boolean
  readonly count: number
}

export interface QualificationCandidateInput {
  readonly publicationDate: IsoDate
  readonly clickhouseUrls: readonly URL[]
  readonly publisherPrincipal: string
  readonly protocol: CausalProtocol
  readonly tigerBeetleClusterId: string
  readonly tigerBeetleAddresses: string
  readonly tigerBeetleLedger: string
}

export interface QualificationCandidateReaders {
  readonly readReplica: (endpoint: URL) => Effect.Effect<CandidateReplicaObservation, QualificationCandidateError>
  readonly readQualificationLocks: (
    snapshotId: string,
  ) => Effect.Effect<QualificationLockObservation, QualificationCandidateError>
}

export interface QualificationCandidateReport {
  readonly schemaVersion: 'bayn.qualification-candidate.v1'
  readonly publicationDate: string
  readonly publisherPrincipal: string
  readonly snapshotCanonicalHash: string
  readonly inputManifestHash: string
  readonly rowCount: number
  readonly sessionCount: number
  readonly replicas: readonly {
    readonly endpointHost: string
    readonly replica: string
    readonly snapshotCanonicalHash: string
  }[]
  readonly qualificationLockCount: 0
  readonly candidateRuntime: BaynCandidateRuntime
}

export const validateCandidateEndpoints = (urls: readonly URL[]): readonly [URL, URL] => {
  if (urls.length !== 2) throw new TypeError('exactly two direct ClickHouse replica URLs are required')
  const [first, second] = urls
  if (first === undefined || second === undefined) {
    throw new TypeError('exactly two direct ClickHouse replica URLs are required')
  }
  for (const url of urls) {
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new TypeError(
        `ClickHouse endpoint for host ${url.hostname || '<missing>'} is not a direct credential-free HTTP(S) origin`,
      )
    }
  }
  if (first.href === second.href) throw new TypeError('ClickHouse replica endpoints must be distinct')
  if (first.hostname === second.hostname) throw new TypeError('ClickHouse replica endpoint hosts must be distinct')
  return [first, second]
}

const validateTigerBeetleRuntime = (clusterId: string, addresses: string, ledgerValue: string): void => {
  if (!canonicalDecimalPattern.test(clusterId)) {
    throw new TypeError('TigerBeetle cluster ID must be a canonical unsigned decimal')
  }
  const parsedClusterId = BigInt(clusterId)
  if (parsedClusterId <= 0n || parsedClusterId > maximumTigerBeetleClusterId) {
    throw new TypeError('TigerBeetle cluster ID is outside the unsigned 128-bit range')
  }
  if (!transportAddressesPattern.test(addresses)) {
    throw new TypeError('TigerBeetle addresses are not a canonical comma-separated transport list')
  }
  const addressList = addresses.split(',')
  if (new Set(addressList).size !== addressList.length) {
    throw new TypeError('TigerBeetle transport addresses must be unique')
  }
  if (!canonicalDecimalPattern.test(ledgerValue)) {
    throw new TypeError('TigerBeetle ledger must be a canonical unsigned decimal')
  }
  const ledger = Number(ledgerValue)
  if (!Number.isSafeInteger(ledger) || ledger <= 0 || ledger > maximumTigerBeetleLedger) {
    throw new TypeError('TigerBeetle ledger is outside the unsigned 32-bit range')
  }
}

export const makeCandidateRuntime = (
  input: QualificationCandidateInput,
  snapshot: MarketDataSnapshot,
): BaynCandidateRuntime => {
  validateTigerBeetleRuntime(input.tigerBeetleClusterId, input.tigerBeetleAddresses, input.tigerBeetleLedger)
  const finalized = snapshot.manifest.finalizedSnapshot
  const bounds = snapshot.manifest.bounds
  if (
    finalized.universeId !== input.protocol.universeId ||
    finalized.universeSymbolHash !== input.protocol.universeSymbolHash ||
    finalized.asOfSession !== input.publicationDate ||
    finalized.lastSession !== input.publicationDate ||
    finalized.requestedStart !== input.protocol.historyStart ||
    bounds.dataStart !== input.protocol.historyStart ||
    bounds.lookbackStart !== input.protocol.historyStart ||
    bounds.evaluationStart !== input.protocol.evaluationStart ||
    bounds.dataEnd !== input.publicationDate ||
    bounds.evaluationEnd !== input.publicationDate
  ) {
    throw new TypeError('verified Signal snapshot does not match the source-controlled candidate contract')
  }
  return {
    BAYN_SIGNAL_SNAPSHOT_ID: finalized.snapshotId,
    BAYN_SIGNAL_PUBLICATION_ASOF: input.publicationDate,
    BAYN_SIGNAL_CALENDAR_VERSION: finalized.calendarVersion,
    BAYN_SIGNAL_DATA_START: input.protocol.historyStart,
    BAYN_SIGNAL_DATA_END: input.publicationDate,
    BAYN_SIGNAL_LOOKBACK_START: input.protocol.historyStart,
    BAYN_SIGNAL_EVALUATION_START: input.protocol.evaluationStart,
    BAYN_SIGNAL_EVALUATION_END: input.publicationDate,
    BAYN_TIGERBEETLE_CLUSTER_ID: input.tigerBeetleClusterId,
    BAYN_TIGERBEETLE_ADDRESSES: input.tigerBeetleAddresses,
    BAYN_TIGERBEETLE_LEDGER: input.tigerBeetleLedger,
  }
}

const compareReplicaObservations = (
  input: QualificationCandidateInput,
  observations: readonly CandidateReplicaObservation[],
): Omit<QualificationCandidateReport, 'qualificationLockCount'> => {
  if (observations.length !== 2) throw new TypeError('exactly two replica observations are required')
  const endpointHosts = validateCandidateEndpoints(input.clickhouseUrls)
    .map((url) => url.hostname)
    .sort()
  const observedEndpointHosts = observations.map((observation) => observation.endpointHost).sort()
  if (canonicalJsonV1(observedEndpointHosts) !== canonicalJsonV1(endpointHosts)) {
    throw new TypeError('replica observations do not match the requested direct endpoint hosts')
  }
  if (observations.some((observation) => observation.principal !== input.publisherPrincipal)) {
    throw new TypeError('a replica read did not use the declared Signal publisher principal')
  }
  const observedReplicas = observations.map((observation) => observation.replica).sort()
  if (new Set(observedReplicas).size !== observedReplicas.length) {
    throw new TypeError('ClickHouse endpoints resolved to the same physical replica')
  }
  const canonicalSnapshots = observations.map((observation) => canonicalJsonV1(observation.snapshot))
  const canonicalSnapshot = canonicalSnapshots[0]
  if (canonicalSnapshot === undefined || canonicalSnapshots.some((value) => value !== canonicalSnapshot)) {
    throw new TypeError('fully verified Signal snapshots diverge across physical replicas')
  }
  const snapshot = observations[0]?.snapshot
  if (snapshot === undefined) throw new TypeError('verified Signal snapshot is missing')
  const snapshotCanonicalHash = canonicalHashV1(snapshot)
  const candidateRuntime = makeCandidateRuntime(input, snapshot)
  return {
    schemaVersion: 'bayn.qualification-candidate.v1',
    publicationDate: input.publicationDate,
    publisherPrincipal: input.publisherPrincipal,
    snapshotCanonicalHash,
    inputManifestHash: snapshot.manifest.hash,
    rowCount: snapshot.manifest.rowCount,
    sessionCount: snapshot.manifest.sessionCount,
    replicas: [...observations]
      .sort((left, right) => left.replica.localeCompare(right.replica))
      .map((observation) => ({
        endpointHost: observation.endpointHost,
        replica: observation.replica,
        snapshotCanonicalHash: canonicalHashV1(observation.snapshot),
      })),
    candidateRuntime,
  }
}

export const verifyQualificationCandidate = (
  input: QualificationCandidateInput,
  readers: QualificationCandidateReaders,
): Effect.Effect<QualificationCandidateReport, QualificationCandidateError> =>
  Effect.gen(function* () {
    const endpoints = yield* Effect.try({
      try: () => validateCandidateEndpoints(input.clickhouseUrls),
      catch: (cause) => candidateError('config', 'invalid candidate replica endpoints', cause),
    })
    const observations = [yield* readers.readReplica(endpoints[0]), yield* readers.readReplica(endpoints[1])] as const
    const consensus = yield* Effect.try({
      try: () => compareReplicaObservations(input, observations),
      catch: (cause) => candidateError('replica', 'Signal replica candidate verification failed', cause),
    })
    const locks = yield* readers.readQualificationLocks(consensus.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID)
    if (!locks.transactionReadOnly) {
      return yield* Effect.fail(candidateError('postgres', 'qualification-lock check was not read-only'))
    }
    if (locks.count !== 0) {
      return yield* Effect.fail(
        candidateError(
          'postgres',
          `Signal snapshot ${consensus.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID} is already consumed by ${locks.count} qualification lock(s)`,
        ),
      )
    }
    return { ...consensus, qualificationLockCount: 0 }
  })

const candidateBounds = (protocol: CausalProtocol, publicationDate: IsoDate) => ({
  schemaVersion: 'bayn.evaluation-bounds.v1' as const,
  dataStart: protocol.historyStart,
  dataEnd: publicationDate,
  lookbackStart: protocol.historyStart,
  evaluationStart: protocol.evaluationStart,
  evaluationEnd: publicationDate,
})

const readReplica = (
  input: QualificationCandidateInput,
  endpoint: URL,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
): Effect.Effect<CandidateReplicaObservation, QualificationCandidateError> => {
  const clickhouse = ClickhouseClient.layer({
    url: endpoint.href,
    username: input.publisherPrincipal,
    password: Redacted.value(password),
    database: 'signal',
    application: 'bayn-qualification-candidate',
    request_timeout: operationTimeoutMs,
    clickhouse_settings: { readonly: '1' },
  }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
  const program = Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const identityRows = yield* decodeReplicaIdentity(
      yield* sql`
        SELECT hostName() AS replica, currentUser() AS principal
      `.pipe(sql.withQueryId('bayn-candidate-replica-identity')),
    )
    const candidateRows = yield* decodeCandidateRow(
      yield* sql`
        SELECT snapshot_id, calendar_version
        FROM signal.snapshot_manifests_v2
        WHERE universe_id = ${sql.param('String', input.protocol.universeId)}
          AND universe_symbol_hash = ${sql.param('String', input.protocol.universeSymbolHash)}
          AND requested_start = toDate(${sql.param('String', input.protocol.historyStart)})
          AND publication_asof = toDate(${sql.param('String', input.publicationDate)})
        ORDER BY finalized_at DESC, snapshot_id DESC
        LIMIT 1
      `.pipe(sql.withQueryId(`bayn-candidate-select-${input.publicationDate}`)),
    )
    const [identity] = identityRows
    const [candidate] = candidateRows
    const marketData = yield* MarketData.pipe(
      Effect.provide(
        MarketDataLive(
          {
            operationTimeoutMs,
            clickhouse: {
              url: endpoint.href,
              username: input.publisherPrincipal,
              password,
              snapshotId: candidate.snapshot_id,
              publicationAsOf: input.publicationDate,
              calendarVersion: candidate.calendar_version,
              bounds: candidateBounds(input.protocol, input.publicationDate),
            },
          },
          input.protocol,
        ),
      ),
    )
    const snapshot = yield* marketData.loadSnapshotPublication({
      snapshotId: candidate.snapshot_id,
      signalSessionDate: input.publicationDate,
      signalCalendarVersion: candidate.calendar_version,
    })
    return {
      endpointHost: endpoint.hostname,
      replica: identity.replica,
      principal: identity.principal,
      snapshot,
    }
  })
  return program.pipe(
    Effect.provide(clickhouse),
    Effect.mapError((cause) =>
      preserveCandidateError('replica', `candidate read failed for ClickHouse host ${endpoint.hostname}`, cause),
    ),
  )
}

const postgresLayer = (input: CandidateConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      let ca: string | undefined
      if (input.postgresTls) {
        if (input.postgresCaPath.length === 0) {
          return yield* Effect.fail(
            candidateError('config', 'BAYN_CANDIDATE_POSTGRES_CA_PATH is required when PostgreSQL TLS is enabled'),
          )
        }
        const fileSystem = yield* FileSystem.FileSystem
        ca = yield* fileSystem.readFileString(input.postgresCaPath)
      }
      return PgClient.layerFrom(
        PgClient.make({
          url: input.postgresUrl,
          ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
          applicationName: 'bayn-qualification-candidate',
          connectTimeout: input.operationTimeoutMs,
          idleTimeout: '30 seconds',
          maxConnections: 1,
          minConnections: 0,
          transformJson: false,
        }),
      )
    }),
  )

const readQualificationLocks = (
  input: CandidateConfig,
  snapshotId: string,
): Effect.Effect<QualificationLockObservation, QualificationCandidateError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
        const [readOnlyRows, countRows] = yield* Effect.all(
          [
            decodeReadOnlyRow(yield* sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`),
            decodeLockCountRow(
              yield* sql`
                SELECT count(*)::integer AS lock_count
                FROM qualification_locks
                WHERE snapshot_id = ${snapshotId}
              `,
            ),
          ],
          { concurrency: 1 },
        )
        const [readOnly] = readOnlyRows
        const [count] = countRows
        return { transactionReadOnly: readOnly.read_only, count: count.lock_count }
      }),
    )
  }).pipe(
    Effect.provide(postgresLayer(input)),
    Effect.mapError((cause) => preserveCandidateError('postgres', 'read-only qualification-lock check failed', cause)),
  )

const main = Effect.gen(function* () {
  const input = yield* config
  const protocol = yield* loadDefaultProtocol.pipe(
    Effect.mapError((cause) => candidateError('runtime', 'compiled Bayn protocol is invalid', cause)),
  )
  const candidateInput: QualificationCandidateInput = {
    publicationDate: input.publicationDate,
    clickhouseUrls: input.clickhouseUrls,
    publisherPrincipal: input.publisherUsername,
    protocol,
    tigerBeetleClusterId: input.tigerBeetleClusterId,
    tigerBeetleAddresses: input.tigerBeetleAddresses,
    tigerBeetleLedger: input.tigerBeetleLedger,
  }
  const fileSystem = yield* FileSystem.FileSystem
  const report = yield* verifyQualificationCandidate(candidateInput, {
    readReplica: (endpoint) => readReplica(candidateInput, endpoint, input.publisherPassword, input.operationTimeoutMs),
    readQualificationLocks: (snapshotId) =>
      readQualificationLocks(input, snapshotId).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
  })
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${canonicalJsonV1(report)}\n`), stdio.stdout())
})

if (import.meta.main) {
  NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
}
