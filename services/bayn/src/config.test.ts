import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Redacted, Result } from 'effect'

import { BrokerProvider, alpacaLiveBaseUrl, alpacaSandboxBaseUrl } from './broker/connection'
import type { EmbeddedBuildMetadata } from './build'
import {
  loadConfig,
  resolveRuntimeConfig,
  type ParsedRuntimeConfig,
  type RuntimeConfigResolutionFailure,
  type RuntimeConfigResolutionInput,
} from './config'
import { BrokerAccess, BrokerEnvironment, CapitalAuthorityKind } from './execution/authority'
import { CapitalAuthoritySelection } from './execution/configuration'
import type { ExecutionPrepareRequest } from './execution-prepare'
import { makeExecutionPrepareDiscoveryReceiptFixture } from './execution-prepare/test-fixture'

const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
const imageDigest = `sha256:${'b'.repeat(64)}`
const authorityGenerationHash = '1'.repeat(64)
const liveCapitalGrantHash = '2'.repeat(64)
const buildMetadata: EmbeddedBuildMetadata = {
  sourceRevision,
  imageRepository,
  strategyBehaviorHash: 'c'.repeat(64),
  strategyParameterHash: 'd'.repeat(64),
}
const qualificationRunId = 'e'.repeat(64)
const alpacaAccountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const clickhousePassword = 'clickhouse-password-must-remain-redacted'
const postgresUrl = 'postgresql://bayn:postgres-secret-must-remain-redacted@postgres.test:5432/bayn'
const executionPrepareStrategy = {
  name: 'risk-balanced-trend' as const,
  behaviorHash: buildMetadata.strategyBehaviorHash,
  parameterHash: buildMetadata.strategyParameterHash,
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4' as const,
}
const executionPrepareStrategyProtocolHash = '7'.repeat(64)
const executionPrepareRiskPolicyHash = 'd'.repeat(64)
const executionPrepareReconciliationId = 'e'.repeat(64)
const executionPrepareReconciliationContentHash = 'f'.repeat(64)
const executionPrepareDiscoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
  sourceRevision,
  imageRepository,
  imageDigest,
  strategy: executionPrepareStrategy,
  strategyProtocolHash: executionPrepareStrategyProtocolHash,
  qualificationRunId,
  accountId: alpacaAccountId,
  authorityGenerationHash,
  policyHash: executionPrepareRiskPolicyHash,
  reconciliationId: executionPrepareReconciliationId,
  reconciliationContentHash: executionPrepareReconciliationContentHash,
})
const executionPrepareCandidate = executionPrepareDiscoveryReceipt.candidateFacts.candidates[0]!

const executionPrepareRequest: ExecutionPrepareRequest = {
  schemaVersion: 'bayn.execution-prepare-request.v1',
  qualification: {
    runId: qualificationRunId,
    lockId: '8'.repeat(64),
    resultHash: '9'.repeat(64),
    verdict: 'QUALIFIED',
    sourceRevision: 'f'.repeat(40),
    imageRepository,
    imageDigest: `sha256:${'1'.repeat(64)}`,
    candidateOrdinal: executionPrepareCandidate.ordinal,
  },
  discoveryReceipt: executionPrepareDiscoveryReceipt,
}

const baseParsedConfig: ParsedRuntimeConfig = {
  host: '0.0.0.0',
  port: 8080,
  qualificationRunId: undefined,
  configuredOperation: undefined,
  executionPrepareRequest: undefined,
  legacyMaximumAuthority: 'OBSERVE',
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: CapitalAuthoritySelection.None,
  liveCapitalGrantHash: undefined,
  configuredBuild: { ...buildMetadata, imageDigest },
  provenanceMode: 'production',
  healthIntervalMs: 30_000,
  operationTimeoutMs: 30_000,
  lifecycleOwner: 'Process',
  lifecycleCommandPort: 8081,
  lifecycleControllerKey: 'primary',
  lifecyclePreviousSourceRevision: undefined,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  cyclePollIntervalMs: 30_000,
  authorityGenerationHash,
  configuredAlpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    accountId: undefined,
    key: undefined,
    secret: undefined,
    proxyUrl: 'http://bayn-egress-proxy:3128',
    retryAttempts: 2,
    reconciliationIntervalMs: 30_000,
  },
  clickhouse: {
    url: 'http://clickhouse.test:8123',
    username: 'bayn',
    password: Redacted.make(clickhousePassword),
    snapshotId: 'f'.repeat(64),
    publicationAsOf: '2026-07-17',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2017-01-03',
      dataEnd: '2026-07-17',
      lookbackStart: '2017-01-03',
      evaluationStart: '2018-01-03',
      evaluationEnd: '2026-07-17',
    },
  },
  postgres: {
    url: Redacted.make(postgresUrl),
    tls: true,
    caPath: '/var/run/secrets/bayn/postgres/ca.crt',
  },
  tigerBeetle: {
    clusterId: 2001n,
    replicaAddresses: ['tigerbeetle.test:3000'],
    ledger: 7001,
  },
}

const alpaca = (environment: BrokerEnvironment): ParsedRuntimeConfig['configuredAlpaca'] => ({
  ...baseParsedConfig.configuredAlpaca,
  environment,
  baseUrl: environment === BrokerEnvironment.Sandbox ? alpacaSandboxBaseUrl : alpacaLiveBaseUrl,
  accountId: alpacaAccountId,
  key: Redacted.make(`${environment}-key`),
  secret: Redacted.make(`${environment}-secret`),
})

const resolutionInput = (
  overrides: Partial<ParsedRuntimeConfig> = {},
  embedded: EmbeddedBuildMetadata | undefined = buildMetadata,
): RuntimeConfigResolutionInput => ({
  parsed: { ...baseParsedConfig, ...overrides },
  embeddedBuildMetadata: embedded,
})

const expectFailure = (overrides: Partial<ParsedRuntimeConfig>, expected: RuntimeConfigResolutionFailure): void => {
  const result = resolveRuntimeConfig(resolutionInput(overrides))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toEqual(expected)
}

describe('pure runtime configuration resolution', () => {
  test('resolves brokerless and connected read-only services with no capital', () => {
    const brokerless = Result.getOrThrow(resolveRuntimeConfig(resolutionInput({ authorityGenerationHash: undefined })))
    const sandbox = Result.getOrThrow(
      resolveRuntimeConfig(resolutionInput({ configuredAlpaca: alpaca(BrokerEnvironment.Sandbox) })),
    )
    const live = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({ configuredAlpaca: alpaca(BrokerEnvironment.Live), legacyMaximumAuthority: undefined }),
      ),
    )

    expect(brokerless).toMatchObject({
      runtimeMode: 'BrokerlessService',
      execution: { brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: { _tag: CapitalAuthorityKind.None } },
    })
    expect(sandbox).toMatchObject({
      runtimeMode: 'AutonomousService',
      execution: {
        brokerIdentity: { environment: BrokerEnvironment.Sandbox },
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: { _tag: CapitalAuthorityKind.None },
      },
    })
    expect(live).toMatchObject({
      runtimeMode: 'AutonomousService',
      execution: {
        brokerIdentity: { environment: BrokerEnvironment.Live },
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: { _tag: CapitalAuthorityKind.None },
      },
    })
  })

  test('resolves sandbox and live mutation through the same explicit policy shape', () => {
    const sandbox = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({
          configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
          legacyMaximumAuthority: 'PAPER',
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.Sandbox,
        }),
      ),
    )
    const live = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({
          configuredAlpaca: alpaca(BrokerEnvironment.Live),
          legacyMaximumAuthority: undefined,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.LiveGrant,
          liveCapitalGrantHash,
        }),
      ),
    )

    expect(sandbox).toMatchObject({
      runtimeMode: 'AutonomousService',
      execution: {
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: { _tag: CapitalAuthorityKind.Granted, authorityGenerationHash },
      },
    })
    expect(live).toMatchObject({
      runtimeMode: 'AutonomousService',
      execution: {
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: {
          _tag: CapitalAuthorityKind.Granted,
          authorityGenerationHash,
          persistedGrantHash: liveCapitalGrantHash,
        },
      },
    })
  })

  test('reserves the prior post-timestamp tail and next full-pass deadline for every mutation capital mode', () => {
    const paper = {
      configuredAlpaca: {
        ...alpaca(BrokerEnvironment.Sandbox),
        reconciliationIntervalMs: 59_999,
      },
      legacyMaximumAuthority: 'PAPER' as const,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: CapitalAuthoritySelection.Sandbox,
    }
    const accepted = Result.getOrThrow(resolveRuntimeConfig(resolutionInput(paper)))
    expect(accepted).toMatchObject({
      runtimeMode: 'AutonomousService',
      alpaca: { reconciliationIntervalMs: 59_999 },
      execution: {
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: { _tag: CapitalAuthorityKind.Granted },
      },
    })

    expectFailure(
      {
        ...paper,
        configuredAlpaca: {
          ...paper.configuredAlpaca,
          reconciliationIntervalMs: 60_000,
        },
      },
      {
        _tag: 'PaperReconciliationCadenceNotWithinStaleThreshold',
        reconciliationIntervalMs: 60_000,
        priorReconciliationTailTimeoutMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        reconciliationStaleThresholdMs: 120_000,
      },
    )
    expectFailure(
      {
        ...paper,
        configuredAlpaca: {
          ...paper.configuredAlpaca,
          reconciliationIntervalMs: 89_999,
        },
      },
      {
        _tag: 'PaperReconciliationCadenceNotWithinStaleThreshold',
        reconciliationIntervalMs: 89_999,
        priorReconciliationTailTimeoutMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        reconciliationStaleThresholdMs: 120_000,
      },
    )
    expectFailure(
      {
        ...paper,
        operationTimeoutMs: 120_000,
        configuredAlpaca: {
          ...paper.configuredAlpaca,
          reconciliationIntervalMs: 1,
        },
      },
      {
        _tag: 'PaperReconciliationCadenceNotWithinStaleThreshold',
        reconciliationIntervalMs: 1,
        priorReconciliationTailTimeoutMs: 120_000,
        reconciliationPassTimeoutMs: 120_000,
        reconciliationStaleThresholdMs: 120_000,
      },
    )

    const live = {
      configuredAlpaca: {
        ...alpaca(BrokerEnvironment.Live),
        reconciliationIntervalMs: 59_999,
      },
      legacyMaximumAuthority: undefined,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: CapitalAuthoritySelection.LiveGrant,
      liveCapitalGrantHash,
    }
    expect(Result.getOrThrow(resolveRuntimeConfig(resolutionInput(live)))).toMatchObject({
      runtimeMode: 'AutonomousService',
      alpaca: { reconciliationIntervalMs: 59_999 },
      execution: {
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: { _tag: CapitalAuthorityKind.Granted, persistedGrantHash: liveCapitalGrantHash },
      },
    })
    expectFailure(
      {
        ...live,
        configuredAlpaca: {
          ...live.configuredAlpaca,
          reconciliationIntervalMs: 60_000,
        },
      },
      {
        _tag: 'PaperReconciliationCadenceNotWithinStaleThreshold',
        reconciliationIntervalMs: 60_000,
        priorReconciliationTailTimeoutMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        reconciliationStaleThresholdMs: 120_000,
      },
    )

    const observe = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({
          configuredAlpaca: {
            ...alpaca(BrokerEnvironment.Sandbox),
            reconciliationIntervalMs: 120_000,
          },
        }),
      ),
    )
    expect(observe).toMatchObject({
      execution: { brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: { _tag: CapitalAuthorityKind.None } },
      alpaca: { reconciliationIntervalMs: 120_000 },
    })
  })

  test('translates the historical discovery token into a read-only candidate operation', () => {
    const config = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({
          qualificationRunId,
          configuredOperation: 'ExecutionCandidateDiscovery',
          configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
        }),
      ),
    )

    expect(config).toMatchObject({
      runtimeMode: 'ExecutionCandidateDiscovery',
      qualificationRunId,
      execution: { brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: { _tag: CapitalAuthorityKind.None } },
    })
  })

  test('resolves EXECUTION_PREPARE as an explicit read-only bounded operation', () => {
    const config = Result.getOrThrow(
      resolveRuntimeConfig(
        resolutionInput({
          qualificationRunId,
          configuredOperation: 'ExecutionPrepare',
          executionPrepareRequest,
          configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
        }),
      ),
    )

    expect(config).toMatchObject({
      runtimeMode: 'ExecutionPrepare',
      qualificationRunId,
      executionPrepareRequest,
      execution: { brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: { _tag: CapitalAuthorityKind.None } },
      alpaca: { environment: BrokerEnvironment.Sandbox, expectedAccountId: alpacaAccountId },
    })
  })

  test('rejects partial credentials and connection binding failures before composition', () => {
    expectFailure(
      {
        configuredAlpaca: {
          ...baseParsedConfig.configuredAlpaca,
          accountId: alpacaAccountId,
        },
      },
      {
        _tag: 'IncompleteAlpacaCredentials',
        configured: { accountId: true, keyId: false, secretKey: false },
      },
    )
    expectFailure(
      { configuredAlpaca: alpaca(BrokerEnvironment.Sandbox), authorityGenerationHash: undefined },
      { _tag: 'MissingAlpacaAuthorityGeneration' },
    )
  })

  test('rejects every authority mismatch before startup', () => {
    const invalid = [
      {
        overrides: {
          configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: CapitalAuthoritySelection.Sandbox,
        },
        tag: 'ReadOnlyBrokerRequiresNoCapital',
      },
      {
        overrides: {
          configuredAlpaca: alpaca(BrokerEnvironment.Live),
          legacyMaximumAuthority: undefined,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.Sandbox,
        },
        tag: 'LiveBrokerRequiresLiveCapitalGrant',
      },
      {
        overrides: {
          configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
          legacyMaximumAuthority: undefined,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.LiveGrant,
          liveCapitalGrantHash,
        },
        tag: 'SandboxBrokerRequiresSandboxCapital',
      },
      {
        overrides: {
          configuredAlpaca: alpaca(BrokerEnvironment.Live),
          legacyMaximumAuthority: undefined,
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: CapitalAuthoritySelection.LiveGrant,
          liveCapitalGrantHash: undefined,
        },
        tag: 'LiveCapitalRequiresGrantHash',
      },
    ] as const

    for (const entry of invalid) {
      const result = resolveRuntimeConfig(resolutionInput(entry.overrides))
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidExecutionPolicy', cause: { _tag: entry.tag } },
      })
    }
  })

  test('fails closed when legacy authority disagrees with explicit policy', () => {
    expectFailure(
      {
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
        legacyMaximumAuthority: 'OBSERVE',
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
      {
        _tag: 'LegacyAuthorityMismatch',
        legacyMaximumAuthority: 'OBSERVE',
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
    )
  })

  test('requires candidate discovery to remain read-only, pinned, and broker-bound', () => {
    expectFailure(
      {
        configuredOperation: 'ExecutionCandidateDiscovery',
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
      },
      { _tag: 'ExecutionCandidateDiscoveryRequiresQualificationRun' },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionCandidateDiscovery',
        qualificationRunId,
        authorityGenerationHash: undefined,
      },
      { _tag: 'ExecutionCandidateDiscoveryRequiresAlpacaBinding' },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionCandidateDiscovery',
        qualificationRunId,
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
        legacyMaximumAuthority: undefined,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
      {
        _tag: 'ExecutionCandidateDiscoveryRequiresReadOnlyNoCapital',
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
    )
  })

  test('requires EXECUTION_PREPARE to remain read-only, pinned, and broker-bound', () => {
    expectFailure(
      {
        configuredOperation: 'ExecutionPrepare',
        qualificationRunId,
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
      },
      { _tag: 'ExecutionPrepareRequiresRequest' },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionPrepare',
        executionPrepareRequest,
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
      },
      { _tag: 'ExecutionCandidateDiscoveryRequiresQualificationRun' },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionPrepare',
        executionPrepareRequest,
        qualificationRunId,
        authorityGenerationHash: undefined,
      },
      { _tag: 'ExecutionCandidateDiscoveryRequiresAlpacaBinding' },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionPrepare',
        executionPrepareRequest,
        qualificationRunId,
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
        legacyMaximumAuthority: undefined,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
      {
        _tag: 'ExecutionCandidateDiscoveryRequiresReadOnlyNoCapital',
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
      },
    )
    expectFailure(
      {
        configuredOperation: 'ExecutionPrepare',
        executionPrepareRequest,
        qualificationRunId,
        configuredAlpaca: alpaca(BrokerEnvironment.Live),
      },
      {
        _tag: 'ExecutionPrepareRequiresSandboxBroker',
        brokerEnvironment: BrokerEnvironment.Live,
      },
    )
  })

  test('validates provenance, PostgreSQL TLS, bounds, and cycle timing before runtime startup', () => {
    expectFailure(
      { cyclePollIntervalMs: 300_000 },
      {
        _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
        cyclePollIntervalMs: 300_000,
        cycleStallThresholdMs: 300_000,
      },
    )
    expectFailure(
      {
        lifecycleOwner: 'Restate',
        lifecycleCommandPort: 8080,
        configuredAlpaca: alpaca(BrokerEnvironment.Sandbox),
      },
      { _tag: 'LifecycleCommandPortConflict', httpPort: 8080, lifecycleCommandPort: 8080 },
    )
    expectFailure(
      { lifecycleOwner: 'Restate', authorityGenerationHash: undefined },
      { _tag: 'RestateLifecycleRequiresAutonomousService' },
    )
    expectFailure(
      { postgres: { ...baseParsedConfig.postgres, tls: false } },
      { _tag: 'ProductionPostgresRequiresTls', postgresTls: false },
    )
    const noEmbedded = resolveRuntimeConfig({
      parsed: baseParsedConfig,
      embeddedBuildMetadata: undefined,
    })
    expect(noEmbedded).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProductionProvenanceRequiresEmbeddedMetadata' },
    })
    const invalidBounds = resolveRuntimeConfig(
      resolutionInput({
        clickhouse: {
          ...baseParsedConfig.clickhouse,
          bounds: { ...baseParsedConfig.clickhouse.bounds, evaluationEnd: '2016-01-01' },
        },
      }),
    )
    expect(invalidBounds).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidEvaluationBounds' } })
  })
})

const runtimeEnvironment = new Map([
  ['BAYN_CODE_REVISION', sourceRevision],
  ['BAYN_IMAGE_REPOSITORY', imageRepository],
  ['BAYN_IMAGE_DIGEST', imageDigest],
  ['BAYN_STRATEGY_BEHAVIOR_HASH', buildMetadata.strategyBehaviorHash],
  ['BAYN_STRATEGY_PARAMETER_HASH', buildMetadata.strategyParameterHash],
  ['BAYN_MAXIMUM_AUTHORITY', 'OBSERVE'],
  ['BAYN_AUTHORITY_GENERATION_HASH', authorityGenerationHash],
  ['BAYN_ALPACA_ACCOUNT_ID', alpacaAccountId],
  ['BAYN_ALPACA_KEY_ID', 'sandbox-key'],
  ['BAYN_ALPACA_SECRET_KEY', 'sandbox-secret'],
  ['BAYN_QUALIFICATION_RUN_ID', qualificationRunId],
  ['BAYN_OPERATION', 'PAPER_CANDIDATE_DISCOVERY'],
  ['BAYN_CLICKHOUSE_URL', 'http://clickhouse.test:8123'],
  ['BAYN_CLICKHOUSE_USERNAME', 'bayn'],
  ['BAYN_CLICKHOUSE_PASSWORD', 'secret'],
  ['BAYN_SIGNAL_SNAPSHOT_ID', 'f'.repeat(64)],
  ['BAYN_SIGNAL_PUBLICATION_ASOF', '2026-07-17'],
  ['BAYN_SIGNAL_CALENDAR_VERSION', 'alpaca-us-equity-calendar-v1'],
  ['BAYN_SIGNAL_DATA_START', '2017-01-03'],
  ['BAYN_SIGNAL_DATA_END', '2026-07-17'],
  ['BAYN_SIGNAL_LOOKBACK_START', '2017-01-03'],
  ['BAYN_SIGNAL_EVALUATION_START', '2018-01-03'],
  ['BAYN_SIGNAL_EVALUATION_END', '2026-07-17'],
  ['BAYN_POSTGRES_URL', 'postgresql://bayn:secret@postgres.test:5432/bayn'],
  ['BAYN_TIGERBEETLE_ADDRESSES', 'tigerbeetle.test:3000'],
])

const provideEnvironment = <A, E>(effect: Effect.Effect<A, E>, environment: Map<string, string>) =>
  effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(Object.fromEntries(environment))),
  )

describe('runtime configuration loading', () => {
  test('decodes the deployed historical tokens into the new read-only runtime contract', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), runtimeEnvironment))

    expect(config).toMatchObject({
      runtimeMode: 'ExecutionCandidateDiscovery',
      execution: {
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: { _tag: CapitalAuthorityKind.None },
      },
    })
    expect(
      JSON.stringify(config, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ).not.toContain('sandbox-secret')
  })

  test('loads the canonical capital activation request', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.set('BAYN_CAPITAL_ACTIVATION_REQUEST', '{"request":"canonical"}')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), environment))

    expect(config.capitalActivationRequestJson).toBe('{"request":"canonical"}')
  })

  test('loads the legacy capital activation request as a compatibility fallback', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.set('BAYN_PAPER_ACTIVATION_REQUEST', '{"request":"legacy"}')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), environment))

    expect(config.capitalActivationRequestJson).toBe('{"request":"legacy"}')
  })

  test('rejects ambiguous canonical and legacy capital activation requests', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.set('BAYN_CAPITAL_ACTIVATION_REQUEST', '{"request":"canonical"}')
    environment.set('BAYN_PAPER_ACTIVATION_REQUEST', '{"request":"legacy"}')

    const failure = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), environment)))

    expect(failure).toMatchObject({ component: 'config', operation: 'load', retryable: false })
    expect(String(failure.cause)).toContain(
      'BAYN_CAPITAL_ACTIVATION_REQUEST and legacy BAYN_PAPER_ACTIVATION_REQUEST cannot both be configured',
    )
  })

  test('returns a typed startup error for an invalid authority combination', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.delete('BAYN_OPERATION')
    environment.delete('BAYN_QUALIFICATION_RUN_ID')
    environment.delete('BAYN_MAXIMUM_AUTHORITY')
    environment.set('BAYN_BROKER_ACCESS', BrokerAccess.Mutation)
    environment.set('BAYN_CAPITAL_AUTHORITY', CapitalAuthoritySelection.LiveGrant)

    const failure = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), environment)))

    expect(failure).toMatchObject({
      component: 'config',
      operation: 'execution-authority',
      retryable: false,
      cause: {
        _tag: 'InvalidExecutionPolicy',
        cause: { _tag: 'SandboxBrokerRequiresSandboxCapital' },
      },
    })
  })

  test('loads one Restate owner and one bounded prior rollout source for the autonomous service', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.delete('BAYN_OPERATION')
    environment.set('BAYN_LIFECYCLE_OWNER', 'RESTATE')
    environment.set('BAYN_LIFECYCLE_COMMAND_PORT', '8081')
    environment.set('BAYN_LIFECYCLE_CONTROLLER_KEY', 'primary')
    environment.set('BAYN_LIFECYCLE_PREVIOUS_SOURCE_REVISION', 'e'.repeat(40))

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), environment))

    expect(config).toMatchObject({
      runtimeMode: 'AutonomousService',
      lifecycleOwner: 'Restate',
      lifecycleCommandPort: 8081,
      lifecycleControllerKey: 'primary',
      lifecyclePreviousSourceRevision: 'e'.repeat(40),
    })
  })

  test('loads the public EXECUTION_PREPARE token and strict JSON request without exposing credentials', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.set('BAYN_OPERATION', 'EXECUTION_PREPARE')
    environment.set('BAYN_EXECUTION_PREPARE_REQUEST', JSON.stringify(executionPrepareRequest))

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), environment))
    expect(config).toMatchObject({
      runtimeMode: 'ExecutionPrepare',
      executionPrepareRequest,
      execution: { brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: { _tag: CapitalAuthorityKind.None } },
    })
    const serialized = JSON.stringify(config, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
    expect(serialized).not.toContain('sandbox-secret')
    expect(serialized).not.toContain('sandbox-key')
  })

  test('rejects malformed EXECUTION_PREPARE JSON at the config boundary', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.set('BAYN_OPERATION', 'EXECUTION_PREPARE')
    environment.set('BAYN_EXECUTION_PREPARE_REQUEST', '{"schemaVersion":"wrong"}')

    const failure = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), environment)))
    expect(failure).toMatchObject({ component: 'config', operation: 'load', retryable: false })
  })
})
