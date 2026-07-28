import { Config, Effect, FileSystem, Result, Stdio, Stream } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import { canonicalJsonV1Result } from '../hash'
import { loadDefaultProtocol } from '../protocol'
import { IsoDateSchema, PositiveIntegerSchema, TrimmedNonEmptyStringSchema } from '../schemas'
import type { CausalProtocol } from '../types'
import { toQualificationCandidateError, type QualificationCandidateFailure } from './failure'
import {
  type CandidateConfig,
  type CandidateReplicaEndpoint,
  type CandidateReplicaObservation,
  type QualificationCandidateInput,
  type QualificationCandidateReaders,
  type QualificationCandidateReport,
} from './model'
import {
  acceptQualificationLocks,
  compareReplicaObservations,
  resolveCandidateConfig,
  validateCandidateEndpoints,
} from './domain'
import {
  acquireCandidateReplicaClient,
  acquireQualificationLockClient,
  readCandidateReplica,
  readQualificationLocks,
} from './live'
import { CandidatePostgresTlsServerNameSchema, CandidateReplicaUrlsSchema } from './schema'

const rawConfig = Config.all({
  publicationDate: Config.schema(IsoDateSchema, 'BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE'),
  clickhouseUrls: Config.schema(CandidateReplicaUrlsSchema, 'BAYN_CANDIDATE_CLICKHOUSE_URLS'),
  publisherUsername: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME'),
  publisherPassword: Config.redacted('BAYN_CANDIDATE_SIGNAL_PUBLISHER_PASSWORD'),
  postgresUrl: Config.redacted('BAYN_CANDIDATE_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_CANDIDATE_POSTGRES_TLS').pipe(Config.withDefault(false)),
  postgresCaPath: Config.option(Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_POSTGRES_CA_PATH')),
  postgresTlsServerName: Config.option(
    Config.schema(CandidatePostgresTlsServerNameSchema, 'BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME'),
  ),
  tigerBeetleClusterId: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_CLUSTER_ID'),
  tigerBeetleAddresses: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_ADDRESSES'),
  tigerBeetleLedger: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CANDIDATE_TIGERBEETLE_LEDGER'),
  operationTimeoutMs: Config.schema(PositiveIntegerSchema, 'BAYN_CANDIDATE_OPERATION_TIMEOUT_MS').pipe(
    Config.withDefault(60_000),
  ),
})

export const loadQualificationCandidateConfig = rawConfig.pipe(
  Effect.mapError((cause): QualificationCandidateFailure => ({ _tag: 'ConfigurationLoadFailed', cause })),
  Effect.flatMap((input) => Effect.fromResult(resolveCandidateConfig(input))),
)

const readReplicaPair = <R>(
  endpoints: readonly [CandidateReplicaEndpoint, CandidateReplicaEndpoint],
  readers: QualificationCandidateReaders<R>,
): Effect.Effect<
  readonly [CandidateReplicaObservation, CandidateReplicaObservation],
  QualificationCandidateFailure,
  R
> =>
  readers
    .readReplica(endpoints[0])
    .pipe(
      Effect.flatMap((first) =>
        readers.readReplica(endpoints[1]).pipe(Effect.map((second) => [first, second] as const)),
      ),
    )

export const verifyQualificationCandidate = <R>(
  input: QualificationCandidateInput,
  readers: QualificationCandidateReaders<R>,
): Effect.Effect<QualificationCandidateReport, QualificationCandidateFailure, R> =>
  Effect.fromResult(validateCandidateEndpoints(input.clickhouseUrls)).pipe(
    Effect.flatMap((endpoints) =>
      readReplicaPair(endpoints, readers).pipe(
        Effect.flatMap((observations) => Effect.fromResult(compareReplicaObservations(input, endpoints, observations))),
      ),
    ),
    Effect.flatMap((consensus) =>
      readers
        .readQualificationLocks(consensus.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID)
        .pipe(Effect.flatMap((locks) => Effect.fromResult(acceptQualificationLocks(consensus, locks)))),
    ),
  )

const candidateInput = (input: CandidateConfig, protocol: CausalProtocol): QualificationCandidateInput => ({
  publicationDate: input.publicationDate,
  clickhouseUrls: input.clickhouseUrls,
  publisherPrincipal: input.publisherUsername,
  protocol,
  tigerBeetleClusterId: input.tigerBeetleClusterId,
  tigerBeetleAddresses: input.tigerBeetleAddresses,
  tigerBeetleLedger: input.tigerBeetleLedger,
})

const verifyConfiguredCandidate = (
  input: CandidateConfig,
): Effect.Effect<
  QualificationCandidateReport,
  QualificationCandidateFailure,
  FileSystem.FileSystem | Reactivity.Reactivity
> =>
  loadDefaultProtocol.pipe(
    Effect.mapError((cause): QualificationCandidateFailure => ({ _tag: 'ProtocolLoadFailed', cause })),
    Effect.flatMap((protocol) => {
      const candidate = candidateInput(input, protocol)
      return verifyQualificationCandidate(candidate, {
        readReplica: (endpoint) =>
          readCandidateReplica(
            candidate,
            endpoint,
            input.publisherPassword,
            input.operationTimeoutMs,
            acquireCandidateReplicaClient,
          ),
        readQualificationLocks: (snapshotId) =>
          readQualificationLocks(input, snapshotId, acquireQualificationLockClient),
      })
    }),
  )

const writeReport = (
  report: QualificationCandidateReport,
): Effect.Effect<void, QualificationCandidateFailure, Stdio.Stdio> =>
  Effect.fromResult(
    Result.mapError(
      canonicalJsonV1Result(report),
      (cause): QualificationCandidateFailure => ({
        _tag: 'CanonicalizationFailed',
        subject: 'report',
        cause,
      }),
    ),
  ).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.flatMap((encoded) =>
      Effect.flatMap(Stdio.Stdio, (stdio) =>
        Stream.run(Stream.make(encoded), stdio.stdout()).pipe(
          Effect.mapError((cause): QualificationCandidateFailure => ({ _tag: 'OutputWriteFailed', cause })),
        ),
      ),
    ),
  )

export const runQualificationCandidateCommand = loadQualificationCandidateConfig.pipe(
  Effect.flatMap(verifyConfiguredCandidate),
  Effect.flatMap(writeReport),
)

export const qualificationCandidateMain = runQualificationCandidateCommand.pipe(
  Effect.mapError(toQualificationCandidateError),
)
