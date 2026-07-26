import type { Effect, Option, Redacted } from 'effect'

import type { BaynCandidateRuntime } from '../../../../packages/scripts/src/bayn/update-manifests'

import type { MarketDataSnapshot } from '../market-data'
import type { IsoDate } from '../schemas'
import type { CausalProtocol } from '../types'

export interface CandidatePostgresTlsConfig {
  readonly caPath: string
  readonly serverName: string
}

export interface CandidateConfigInput {
  readonly publicationDate: IsoDate
  readonly clickhouseUrls: readonly URL[]
  readonly publisherUsername: string
  readonly publisherPassword: Redacted.Redacted<string>
  readonly postgresUrl: Redacted.Redacted<string>
  readonly postgresTls: boolean
  readonly postgresCaPath: Option.Option<string>
  readonly postgresTlsServerName: Option.Option<string>
  readonly tigerBeetleClusterId: string
  readonly tigerBeetleAddresses: string
  readonly tigerBeetleLedger: string
  readonly operationTimeoutMs: number
}

export interface CandidateConfig extends Omit<
  CandidateConfigInput,
  'postgresCaPath' | 'postgresTls' | 'postgresTlsServerName'
> {
  readonly postgresTls: CandidatePostgresTlsConfig | undefined
}

export interface CandidateReplicaObservation {
  readonly endpointHost: string
  readonly replica: string
  readonly principal: string
  readonly snapshot: MarketDataSnapshot
}

export interface CandidateReplicaEndpoint {
  readonly href: string
  readonly hostname: string
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
  readonly readReplica: (
    endpoint: CandidateReplicaEndpoint,
  ) => Effect.Effect<CandidateReplicaObservation, QualificationCandidateFailure>
  readonly readQualificationLocks: (
    snapshotId: string,
  ) => Effect.Effect<QualificationLockObservation, QualificationCandidateFailure>
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

export type QualificationCandidateConsensus = Omit<QualificationCandidateReport, 'qualificationLockCount'>

export type QualificationCandidateFailure =
  | { readonly _tag: 'ConfigurationLoadFailed'; readonly cause: unknown }
  | { readonly _tag: 'PostgresUrlMalformed' }
  | { readonly _tag: 'PostgresUrlInvalidOrigin' }
  | { readonly _tag: 'PostgresUrlOverride'; readonly parameter: string }
  | {
      readonly _tag: 'PostgresTlsHostMismatch'
      readonly host: string
      readonly expectedServerName: string
    }
  | { readonly _tag: 'PostgresTlsFieldsPresentWhileDisabled' }
  | { readonly _tag: 'PostgresTlsCaMissing' }
  | { readonly _tag: 'PostgresTlsServerNameMissing' }
  | { readonly _tag: 'ReplicaEndpointCountMismatch'; readonly observed: number }
  | { readonly _tag: 'ReplicaEndpointInvalidOrigin'; readonly endpointHost: string }
  | { readonly _tag: 'ReplicaEndpointDuplicate'; readonly endpointHost: string }
  | { readonly _tag: 'ReplicaEndpointHostDuplicate'; readonly endpointHost: string }
  | { readonly _tag: 'TigerBeetleClusterIdInvalidFormat' }
  | { readonly _tag: 'TigerBeetleClusterIdOutOfRange' }
  | { readonly _tag: 'TigerBeetleAddressesInvalidFormat' }
  | { readonly _tag: 'TigerBeetleAddressesDuplicate' }
  | { readonly _tag: 'TigerBeetleLedgerInvalidFormat' }
  | { readonly _tag: 'TigerBeetleLedgerOutOfRange' }
  | {
      readonly _tag: 'SnapshotContractMismatch'
      readonly fields: readonly {
        readonly field: string
        readonly observed: string
        readonly expected: string
      }[]
    }
  | { readonly _tag: 'ReplicaObservationCountMismatch'; readonly observed: number }
  | {
      readonly _tag: 'ReplicaEndpointSetMismatch'
      readonly observed: readonly string[]
      readonly expected: readonly string[]
    }
  | {
      readonly _tag: 'ReplicaPrincipalMismatch'
      readonly replica: string
      readonly observed: string
      readonly expected: string
    }
  | { readonly _tag: 'ReplicaIdentityDuplicate'; readonly replicas: readonly string[] }
  | {
      readonly _tag: 'ReplicaIdentitySetMismatch'
      readonly observed: readonly string[]
      readonly expected: readonly string[]
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly subject: 'snapshot' | 'report'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'ReplicaSnapshotsDiverged'
      readonly replicas: readonly { readonly replica: string; readonly snapshotCanonicalHash: string }[]
    }
  | { readonly _tag: 'ReplicaReadFailed'; readonly endpointHost: string; readonly cause: unknown }
  | { readonly _tag: 'PostgresReadFailed'; readonly cause: unknown }
  | { readonly _tag: 'QualificationLockCheckNotReadOnly' }
  | { readonly _tag: 'SnapshotAlreadyConsumed'; readonly snapshotId: string; readonly count: number }
  | { readonly _tag: 'ProtocolLoadFailed'; readonly cause: unknown }
  | { readonly _tag: 'OutputWriteFailed'; readonly cause: unknown }

interface FailurePresentation {
  readonly operation: 'config' | 'postgres' | 'replica' | 'runtime'
  readonly message: string
}

const presentQualificationCandidateFailure = (failure: QualificationCandidateFailure): FailurePresentation => {
  switch (failure._tag) {
    case 'ConfigurationLoadFailed':
      return { operation: 'config', message: 'qualification candidate configuration could not be decoded' }
    case 'PostgresUrlMalformed':
      return { operation: 'config', message: 'BAYN_CANDIDATE_POSTGRES_URL must be a valid PostgreSQL URL' }
    case 'PostgresUrlInvalidOrigin':
      return { operation: 'config', message: 'BAYN_CANDIDATE_POSTGRES_URL must be a PostgreSQL URL with a host' }
    case 'PostgresUrlOverride':
      return {
        operation: 'config',
        message: `BAYN_CANDIDATE_POSTGRES_URL must not contain TLS or routing override parameter ${failure.parameter}`,
      }
    case 'PostgresTlsHostMismatch':
      return {
        operation: 'config',
        message: `BAYN_CANDIDATE_POSTGRES_URL host ${failure.host} must be an IP literal or exactly match BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME ${failure.expectedServerName}`,
      }
    case 'PostgresTlsFieldsPresentWhileDisabled':
      return {
        operation: 'config',
        message:
          'BAYN_CANDIDATE_POSTGRES_CA_PATH and BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME must be absent when PostgreSQL TLS is disabled',
      }
    case 'PostgresTlsCaMissing':
      return {
        operation: 'config',
        message: 'BAYN_CANDIDATE_POSTGRES_CA_PATH is required when PostgreSQL TLS is enabled',
      }
    case 'PostgresTlsServerNameMissing':
      return {
        operation: 'config',
        message: 'BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME is required when PostgreSQL TLS is enabled',
      }
    case 'ReplicaEndpointCountMismatch':
      return {
        operation: 'config',
        message: `exactly two direct ClickHouse replica URLs are required; observed ${failure.observed}`,
      }
    case 'ReplicaEndpointInvalidOrigin':
      return {
        operation: 'config',
        message: `ClickHouse endpoint for host ${failure.endpointHost || '<missing>'} is not a direct credential-free HTTP(S) origin`,
      }
    case 'ReplicaEndpointDuplicate':
      return {
        operation: 'config',
        message: `ClickHouse replica endpoints must be distinct; duplicate host ${failure.endpointHost}`,
      }
    case 'ReplicaEndpointHostDuplicate':
      return {
        operation: 'config',
        message: `ClickHouse replica endpoint hosts must be distinct; duplicate host ${failure.endpointHost}`,
      }
    case 'TigerBeetleClusterIdInvalidFormat':
      return { operation: 'replica', message: 'TigerBeetle cluster ID must be a canonical unsigned decimal' }
    case 'TigerBeetleClusterIdOutOfRange':
      return { operation: 'replica', message: 'TigerBeetle cluster ID is outside the unsigned 128-bit range' }
    case 'TigerBeetleAddressesInvalidFormat':
      return {
        operation: 'replica',
        message: 'TigerBeetle addresses are not a canonical comma-separated transport list',
      }
    case 'TigerBeetleAddressesDuplicate':
      return { operation: 'replica', message: 'TigerBeetle transport addresses must be unique' }
    case 'TigerBeetleLedgerInvalidFormat':
      return { operation: 'replica', message: 'TigerBeetle ledger must be a canonical unsigned decimal' }
    case 'TigerBeetleLedgerOutOfRange':
      return { operation: 'replica', message: 'TigerBeetle ledger is outside the unsigned 32-bit range' }
    case 'SnapshotContractMismatch':
      return {
        operation: 'replica',
        message: `verified Signal snapshot does not match the source-controlled candidate contract: ${failure.fields
          .map(({ field, observed, expected }) => `${field} observed=${observed} expected=${expected}`)
          .join(', ')}`,
      }
    case 'ReplicaObservationCountMismatch':
      return {
        operation: 'replica',
        message: `exactly two replica observations are required; observed ${failure.observed}`,
      }
    case 'ReplicaEndpointSetMismatch':
      return {
        operation: 'replica',
        message: `replica observations do not match the requested direct endpoint hosts: observed=${failure.observed.join(',')} expected=${failure.expected.join(',')}`,
      }
    case 'ReplicaPrincipalMismatch':
      return {
        operation: 'replica',
        message: `replica ${failure.replica} used principal ${failure.observed}; expected ${failure.expected}`,
      }
    case 'ReplicaIdentityDuplicate':
      return {
        operation: 'replica',
        message: `ClickHouse endpoints resolved to the same physical replica: ${failure.replicas.join(',')}`,
      }
    case 'ReplicaIdentitySetMismatch':
      return {
        operation: 'replica',
        message: `ClickHouse endpoints do not cover the source-controlled physical replica identities: observed=${failure.observed.join(',')} expected=${failure.expected.join(',')}`,
      }
    case 'CanonicalizationFailed':
      return {
        operation: failure.subject === 'report' ? 'runtime' : 'replica',
        message: `${failure.subject} canonicalization failed`,
      }
    case 'ReplicaSnapshotsDiverged':
      return {
        operation: 'replica',
        message: `fully verified Signal snapshots diverge across physical replicas: ${failure.replicas
          .map(({ replica, snapshotCanonicalHash }) => `${replica}=${snapshotCanonicalHash}`)
          .join(',')}`,
      }
    case 'ReplicaReadFailed':
      return {
        operation: 'replica',
        message: `candidate read failed for ClickHouse host ${failure.endpointHost}`,
      }
    case 'PostgresReadFailed':
      return { operation: 'postgres', message: 'read-only qualification-lock check failed' }
    case 'QualificationLockCheckNotReadOnly':
      return { operation: 'postgres', message: 'qualification-lock check was not read-only' }
    case 'SnapshotAlreadyConsumed':
      return {
        operation: 'postgres',
        message: `Signal snapshot ${failure.snapshotId} is already consumed by ${failure.count} qualification lock(s)`,
      }
    case 'ProtocolLoadFailed':
      return { operation: 'runtime', message: 'compiled Bayn protocol is invalid' }
    case 'OutputWriteFailed':
      return { operation: 'runtime', message: 'qualification candidate report could not be written' }
  }
}

export const renderQualificationCandidateFailure = (failure: QualificationCandidateFailure): string =>
  presentQualificationCandidateFailure(failure).message

export interface QualificationCandidateError {
  readonly _tag: 'QualificationCandidateError'
  readonly operation: 'config' | 'postgres' | 'replica' | 'runtime'
  readonly message: string
  readonly failure: QualificationCandidateFailure
  readonly cause: QualificationCandidateFailure
}

export const toQualificationCandidateError = (failure: QualificationCandidateFailure): QualificationCandidateError => {
  const { operation, message } = presentQualificationCandidateFailure(failure)
  return {
    _tag: 'QualificationCandidateError',
    operation,
    message,
    failure,
    cause: failure,
  }
}
