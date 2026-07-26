import type { Effect, Option, Redacted } from 'effect'

import type { BaynCandidateRuntime } from '../../../../packages/scripts/src/bayn/update-manifests'

import type { MarketDataSnapshot } from '../market-data'
import type { IsoDate } from '../schemas'
import type { CausalProtocol } from '../types'
import type { QualificationCandidateFailure } from './failure'

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
