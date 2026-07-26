import { isIP } from 'node:net'

import { Option, pipe, Redacted, Result } from 'effect'

import { canonicalJsonV1, sha256 } from '../hash'
import type { MarketDataSnapshot } from '../market-data'
import type { QualificationCandidateFailure } from './failure'
import type {
  CandidateConfig,
  CandidateConfigInput,
  CandidatePostgresTlsConfig,
  CandidateReplicaEndpoint,
  CandidateReplicaObservation,
  QualificationCandidateConsensus,
  QualificationCandidateInput,
  QualificationCandidateReport,
  QualificationLockObservation,
} from './model'

const maximumTigerBeetleClusterId = (1n << 128n) - 1n
const maximumTigerBeetleLedger = 2 ** 32 - 1
const canonicalDecimalPattern = /^(?:0|[1-9][0-9]*)$/
const transportAddressesPattern = /^[A-Za-z0-9.[\]:_-]+(?:,[A-Za-z0-9.[\]:_-]+)*$/
const postgresUrlRoutingParameters = new Set(['host', 'port'])
const signalReplicaIdentities = [
  'chi-torghut-clickhouse-default-0-0-0',
  'chi-torghut-clickhouse-default-0-1-0',
] as const

const success = <A>(value: A): Result.Result<A, QualificationCandidateFailure> => Result.succeed(value)
const failure = (value: QualificationCandidateFailure): Result.Result<never, QualificationCandidateFailure> =>
  Result.fail(value)

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const parsePostgresUrl = (redactedUrl: Redacted.Redacted<string>): Result.Result<URL, QualificationCandidateFailure> =>
  Result.try({
    try: () => new URL(Redacted.value(redactedUrl)),
    catch: () => ({ _tag: 'PostgresUrlMalformed' }),
  })

const validatePostgresUrl = (
  redactedUrl: Redacted.Redacted<string>,
  tls: CandidatePostgresTlsConfig | undefined,
): Result.Result<void, QualificationCandidateFailure> =>
  pipe(
    parsePostgresUrl(redactedUrl),
    Result.flatMap((url) => {
      if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname.length === 0) {
        return failure({ _tag: 'PostgresUrlInvalidOrigin' })
      }
      const overrideParameter = [...url.searchParams.keys()].find((key) => {
        const normalized = key.toLowerCase()
        return (
          postgresUrlRoutingParameters.has(normalized) ||
          normalized === 'uselibpqcompat' ||
          normalized.startsWith('ssl') ||
          normalized.startsWith('tls')
        )
      })
      if (overrideParameter !== undefined) {
        return failure({ _tag: 'PostgresUrlOverride', parameter: overrideParameter })
      }
      if (tls === undefined) return success(undefined)
      const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
      return isIP(host) === 0 && host !== tls.serverName
        ? failure({ _tag: 'PostgresTlsHostMismatch', host, expectedServerName: tls.serverName })
        : success(undefined)
    }),
  )

export const resolveCandidateConfig = (
  input: CandidateConfigInput,
): Result.Result<CandidateConfig, QualificationCandidateFailure> => {
  const { postgresCaPath, postgresTls, postgresTlsServerName, ...rest } = input
  if (!postgresTls) {
    return pipe(
      validatePostgresUrl(input.postgresUrl, undefined),
      Result.flatMap(() =>
        Option.isSome(postgresCaPath) || Option.isSome(postgresTlsServerName)
          ? failure({ _tag: 'PostgresTlsFieldsPresentWhileDisabled' })
          : success({ ...rest, postgresTls: undefined }),
      ),
    )
  }
  if (Option.isNone(postgresCaPath)) return failure({ _tag: 'PostgresTlsCaMissing' })
  if (Option.isNone(postgresTlsServerName)) return failure({ _tag: 'PostgresTlsServerNameMissing' })
  const resolvedPostgresTls = {
    caPath: postgresCaPath.value,
    serverName: postgresTlsServerName.value,
  }
  return pipe(
    validatePostgresUrl(input.postgresUrl, resolvedPostgresTls),
    Result.map(() => ({ ...rest, postgresTls: resolvedPostgresTls })),
  )
}

const isDirectClickHouseOrigin = (url: URL): boolean =>
  (url.protocol === 'http:' || url.protocol === 'https:') &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  (url.pathname === '' || url.pathname === '/') &&
  url.search.length === 0 &&
  url.hash.length === 0

export const validateCandidateEndpoints = (
  urls: readonly URL[],
): Result.Result<readonly [CandidateReplicaEndpoint, CandidateReplicaEndpoint], QualificationCandidateFailure> => {
  if (urls.length !== 2) return failure({ _tag: 'ReplicaEndpointCountMismatch', observed: urls.length })
  const first = urls[0]
  const second = urls[1]
  if (first === undefined || second === undefined) {
    return failure({ _tag: 'ReplicaEndpointCountMismatch', observed: urls.length })
  }
  const invalid = urls.find((url) => !isDirectClickHouseOrigin(url))
  if (invalid !== undefined) {
    return failure({ _tag: 'ReplicaEndpointInvalidOrigin', endpointHost: invalid.hostname })
  }
  if (first.href === second.href) {
    return failure({ _tag: 'ReplicaEndpointDuplicate', endpointHost: first.hostname })
  }
  if (first.hostname === second.hostname) {
    return failure({ _tag: 'ReplicaEndpointHostDuplicate', endpointHost: first.hostname })
  }
  return success([
    { href: first.href, hostname: first.hostname },
    { href: second.href, hostname: second.hostname },
  ])
}

const validateTigerBeetleRuntime = (
  clusterId: string,
  addresses: string,
  ledgerValue: string,
): Result.Result<void, QualificationCandidateFailure> => {
  if (!canonicalDecimalPattern.test(clusterId)) return failure({ _tag: 'TigerBeetleClusterIdInvalidFormat' })
  if (clusterId.length > 39) return failure({ _tag: 'TigerBeetleClusterIdOutOfRange' })
  const parsedClusterId = BigInt(clusterId)
  if (parsedClusterId <= 0n || parsedClusterId > maximumTigerBeetleClusterId) {
    return failure({ _tag: 'TigerBeetleClusterIdOutOfRange' })
  }
  if (!transportAddressesPattern.test(addresses)) {
    return failure({ _tag: 'TigerBeetleAddressesInvalidFormat' })
  }
  const addressList = addresses.split(',')
  if (new Set(addressList).size !== addressList.length) {
    return failure({ _tag: 'TigerBeetleAddressesDuplicate' })
  }
  if (!canonicalDecimalPattern.test(ledgerValue)) return failure({ _tag: 'TigerBeetleLedgerInvalidFormat' })
  const ledger = Number(ledgerValue)
  return !Number.isSafeInteger(ledger) || ledger <= 0 || ledger > maximumTigerBeetleLedger
    ? failure({ _tag: 'TigerBeetleLedgerOutOfRange' })
    : success(undefined)
}

const snapshotContractMismatches = (
  input: QualificationCandidateInput,
  snapshot: MarketDataSnapshot,
): readonly { readonly field: string; readonly observed: string; readonly expected: string }[] => {
  const finalized = snapshot.manifest.finalizedSnapshot
  const bounds = snapshot.manifest.bounds
  const facts = [
    ['universeId', finalized.universeId, input.protocol.universeId],
    ['universeSymbolHash', finalized.universeSymbolHash, input.protocol.universeSymbolHash],
    ['asOfSession', finalized.asOfSession, input.publicationDate],
    ['lastSession', finalized.lastSession, input.publicationDate],
    ['requestedStart', finalized.requestedStart, input.protocol.historyStart],
    ['dataStart', bounds.dataStart, input.protocol.historyStart],
    ['lookbackStart', bounds.lookbackStart, input.protocol.historyStart],
    ['evaluationStart', bounds.evaluationStart, input.protocol.evaluationStart],
    ['dataEnd', bounds.dataEnd, input.publicationDate],
    ['evaluationEnd', bounds.evaluationEnd, input.publicationDate],
  ] as const
  return facts
    .filter(([, observed, expected]) => observed !== expected)
    .map(([field, observed, expected]) => ({ field, observed, expected }))
}

export const makeCandidateRuntime = (
  input: QualificationCandidateInput,
  snapshot: MarketDataSnapshot,
): Result.Result<QualificationCandidateConsensus['candidateRuntime'], QualificationCandidateFailure> =>
  pipe(
    validateTigerBeetleRuntime(input.tigerBeetleClusterId, input.tigerBeetleAddresses, input.tigerBeetleLedger),
    Result.flatMap(() => {
      const mismatches = snapshotContractMismatches(input, snapshot)
      if (mismatches.length > 0) {
        return failure({ _tag: 'SnapshotContractMismatch', fields: mismatches })
      }
      const finalized = snapshot.manifest.finalizedSnapshot
      return success({
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
      })
    }),
  )

interface CanonicalSnapshot {
  readonly json: string
  readonly hash: string
}

const canonicalSnapshot = (
  snapshot: MarketDataSnapshot,
): Result.Result<CanonicalSnapshot, QualificationCandidateFailure> =>
  pipe(
    Result.try({
      try: () => canonicalJsonV1(snapshot),
      catch: (cause) => ({ _tag: 'CanonicalizationFailed' as const, subject: 'snapshot' as const, cause }),
    }),
    Result.map((json) => ({ json, hash: sha256(json) })),
  )

export const compareReplicaObservations = (
  input: QualificationCandidateInput,
  endpoints: readonly [CandidateReplicaEndpoint, CandidateReplicaEndpoint],
  observations: readonly CandidateReplicaObservation[],
): Result.Result<QualificationCandidateConsensus, QualificationCandidateFailure> => {
  if (observations.length !== 2) {
    return failure({ _tag: 'ReplicaObservationCountMismatch', observed: observations.length })
  }
  const expectedEndpointHosts = endpoints.map((url) => url.hostname).sort()
  const observedEndpointHosts = observations.map((observation) => observation.endpointHost).sort()
  if (!sameStrings(observedEndpointHosts, expectedEndpointHosts)) {
    return failure({
      _tag: 'ReplicaEndpointSetMismatch',
      observed: observedEndpointHosts,
      expected: expectedEndpointHosts,
    })
  }
  const principalMismatch = observations.find((observation) => observation.principal !== input.publisherPrincipal)
  if (principalMismatch !== undefined) {
    return failure({
      _tag: 'ReplicaPrincipalMismatch',
      replica: principalMismatch.replica,
      observed: principalMismatch.principal,
      expected: input.publisherPrincipal,
    })
  }
  const observedReplicas = observations.map((observation) => observation.replica).sort()
  if (new Set(observedReplicas).size !== observedReplicas.length) {
    return failure({ _tag: 'ReplicaIdentityDuplicate', replicas: observedReplicas })
  }
  if (!sameStrings(observedReplicas, signalReplicaIdentities)) {
    return failure({
      _tag: 'ReplicaIdentitySetMismatch',
      observed: observedReplicas,
      expected: signalReplicaIdentities,
    })
  }
  return pipe(
    Result.all(observations.map((observation) => canonicalSnapshot(observation.snapshot))),
    Result.flatMap((snapshots) => {
      const first = snapshots[0]
      if (first === undefined) {
        return failure({ _tag: 'ReplicaObservationCountMismatch', observed: observations.length })
      }
      if (snapshots.some((snapshot) => snapshot.json !== first.json)) {
        return failure({
          _tag: 'ReplicaSnapshotsDiverged',
          replicas: observations.map((observation, index) => ({
            replica: observation.replica,
            snapshotCanonicalHash: snapshots[index]?.hash ?? '<missing>',
          })),
        })
      }
      const snapshot = observations[0]?.snapshot
      if (snapshot === undefined) {
        return failure({ _tag: 'ReplicaObservationCountMismatch', observed: observations.length })
      }
      return pipe(
        makeCandidateRuntime(input, snapshot),
        Result.map((candidateRuntime) => ({
          schemaVersion: 'bayn.qualification-candidate.v1' as const,
          publicationDate: input.publicationDate,
          publisherPrincipal: input.publisherPrincipal,
          snapshotCanonicalHash: first.hash,
          inputManifestHash: snapshot.manifest.hash,
          rowCount: snapshot.manifest.rowCount,
          sessionCount: snapshot.manifest.sessionCount,
          replicas: observations
            .map((observation, index) => ({
              endpointHost: observation.endpointHost,
              replica: observation.replica,
              snapshotCanonicalHash: snapshots[index]?.hash ?? '<missing>',
            }))
            .sort((left, right) => left.replica.localeCompare(right.replica)),
          candidateRuntime,
        })),
      )
    }),
  )
}

export const acceptQualificationLocks = (
  consensus: QualificationCandidateConsensus,
  locks: QualificationLockObservation,
): Result.Result<QualificationCandidateReport, QualificationCandidateFailure> => {
  if (!locks.transactionReadOnly) return failure({ _tag: 'QualificationLockCheckNotReadOnly' })
  if (locks.count !== 0) {
    return failure({
      _tag: 'SnapshotAlreadyConsumed',
      snapshotId: consensus.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID,
      count: locks.count,
    })
  }
  return success({ ...consensus, qualificationLockCount: 0 })
}
