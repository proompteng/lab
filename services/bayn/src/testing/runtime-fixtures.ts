import { Redacted, Result } from 'effect'

import type { RuntimeConfig } from '../config'
import { makeRuntimeProvenance } from '../contracts'
import { deriveCycleOperationsStatus } from '../cycle/observability'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { Authority } from '../execution/contracts'
import { canonicalHashV1OrThrow } from '../hash'
import type { RuntimeState } from '../runtime-state'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  loadActiveStrategyProtocol,
  makeActiveStrategyRuntime,
} from '../strategy'

export const fixtureProtocol = Result.getOrThrow(loadActiveStrategyProtocol())
export const provenance = makeRuntimeProvenance({
  sourceRevision: 'a'.repeat(40),
  image: {
    repository: 'registry.ide-newton.ts.net/lab/bayn',
    digest: `sha256:${'b'.repeat(64)}`,
  },
  strategy: {
    name: activeStrategyName,
    behaviorHash: activeStrategyBehaviorHash,
    parameterHash: canonicalHashV1OrThrow(fixtureProtocol),
    parameterSchemaVersion: fixtureProtocol.schemaVersion,
  },
})

export const fixtureRuntime = makeActiveStrategyRuntime(fixtureProtocol, provenance)

export const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  execution: {
    brokerIdentity: undefined,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  build: {
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyBehaviorHash: provenance.strategy.behaviorHash,
    strategyParameterHash: provenance.strategy.parameterHash,
    verification: 'embedded',
  },
  healthIntervalMs: 100,
  operationTimeoutMs: 250,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  clickhouse: {
    url: 'http://clickhouse.test:8123',
    username: 'bayn',
    password: Redacted.make('secret'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-08-28',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2026-08-28',
      dataEnd: '2026-08-28',
      lookbackStart: '2026-08-28',
      evaluationStart: '2026-08-28',
      evaluationEnd: '2026-08-28',
    },
  },
  postgres: {
    url: Redacted.make('postgresql://bayn:secret@postgres.test:5432/bayn'),
    tls: false,
    caPath: '/tmp/test-postgres-ca.crt',
  },
  tigerBeetle: { clusterId: 2001n, replicaAddresses: ['3000'], ledger: 7001 },
}

export const readyState = (): RuntimeState => {
  const checkedAt = '2026-08-28T16:00:00.000Z'
  return {
    status: 'READY',
    health: {
      sequence: 1,
      checkedAt,
      dependencies: {
        postgresql: { status: 'AVAILABLE', checkedAt, error: null },
        signal: { status: 'AVAILABLE', checkedAt, error: null },
        tigerBeetle: { status: 'AVAILABLE', checkedAt, error: null },
        cycle: { status: 'AVAILABLE', checkedAt, error: null },
        cycleRunner: { status: 'AVAILABLE', checkedAt, error: null },
      },
    },
    cycle: deriveCycleOperationsStatus(
      {
        current: null,
        last: null,
        unfinishedCycleCount: 0,
        authority: null,
        reconciliation: null,
        mutations: {
          eventCount: 0,
          recoveryFoundCount: 0,
          approvedIntentCount: 0,
          acknowledgedIntentCount: 0,
          unresolvedCount: 0,
          oldestUnresolvedAt: null,
          latestOccurredAt: null,
        },
      },
      Date.parse(checkedAt),
      Authority.Observe,
      config,
    ),
    autonomousCycleLoop: {
      configured: true,
      owner: 'Restate',
      startedAt: checkedAt,
      lastPass: { result: 'SUCCESS', outcome: 'WINDOW_CLOSED', observedAt: checkedAt },
    },
    capitalActivation: { _tag: 'NotConfigured' },
    broker: null,
    error: null,
  }
}
