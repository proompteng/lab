import { Effect } from 'effect'

import { fixtureProtocol, makeSnapshot } from '../test-fixtures'
import type {
  CandidateReplicaEndpoint,
  CandidateReplicaObservation,
  QualificationCandidateInput,
  QualificationCandidateReaders,
} from './model'

export const candidatePublisherPrincipal = 'signal_publisher'
export const candidateEndpoints = [
  new URL('http://signal-clickhouse-0.signal.svc:8123'),
  new URL('http://signal-clickhouse-1.signal.svc:8123'),
] as const
export const candidateReplicaEndpoints: readonly [CandidateReplicaEndpoint, CandidateReplicaEndpoint] = [
  { href: candidateEndpoints[0].href, hostname: candidateEndpoints[0].hostname },
  { href: candidateEndpoints[1].href, hostname: candidateEndpoints[1].hostname },
]
export const candidateSnapshot = makeSnapshot(270)
export const candidatePublicationDate = candidateSnapshot.manifest.finalizedSnapshot.asOfSession

export const candidateEnvironment = (): Record<string, string> => ({
  BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE: candidatePublicationDate,
  BAYN_CANDIDATE_CLICKHOUSE_URLS: candidateEndpoints.map((endpoint) => endpoint.href).join(','),
  BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME: candidatePublisherPrincipal,
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

export const candidateInput = (overrides: Partial<QualificationCandidateInput> = {}): QualificationCandidateInput => ({
  publicationDate: candidatePublicationDate,
  clickhouseUrls: candidateEndpoints,
  publisherPrincipal: candidatePublisherPrincipal,
  protocol: fixtureProtocol,
  tigerBeetleClusterId: '122731676035874920802382025803517750735',
  tigerBeetleAddresses:
    'ledger-0.ledger-headless.bayn.svc.cluster.local:3000,ledger-1.ledger-headless.bayn.svc.cluster.local:3000',
  tigerBeetleLedger: '7001',
  ...overrides,
})

export const candidateObservations = (
  overrides: Partial<CandidateReplicaObservation>[] = [],
): readonly CandidateReplicaObservation[] => [
  {
    endpointHost: candidateEndpoints[0].hostname,
    replica: 'chi-torghut-clickhouse-default-0-0-0',
    principal: candidatePublisherPrincipal,
    snapshot: candidateSnapshot,
    ...overrides[0],
  },
  {
    endpointHost: candidateEndpoints[1].hostname,
    replica: 'chi-torghut-clickhouse-default-0-1-0',
    principal: candidatePublisherPrincipal,
    snapshot: candidateSnapshot,
    ...overrides[1],
  },
]

export const candidateReaders = (
  replicaObservations: readonly CandidateReplicaObservation[] = candidateObservations(),
  lockCount = 0,
): QualificationCandidateReaders => ({
  readReplica: (endpoint) => {
    const observation = replicaObservations.find((candidate) => candidate.endpointHost === endpoint.hostname)
    return observation === undefined
      ? Effect.fail({
          _tag: 'ReplicaReadFailed',
          endpointHost: endpoint.hostname,
          cause: 'missing fixture',
        } as const)
      : Effect.succeed(observation)
  },
  readQualificationLocks: () =>
    Effect.succeed({
      transactionReadOnly: true,
      count: lockCount,
    }),
})
