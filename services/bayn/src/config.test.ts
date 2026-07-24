import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Redacted, Result } from 'effect'

import type { EmbeddedBuildMetadata } from './build'
import {
  loadConfig,
  resolveRuntimeConfig,
  type ParsedRuntimeConfig,
  type RuntimeConfigResolutionFailure,
  type RuntimeConfigResolutionInput,
} from './config'
import { Authority } from './paper'

const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
const imageDigest = `sha256:${'b'.repeat(64)}`
const authorityGenerationHash = '1'.repeat(64)
const buildMetadata: EmbeddedBuildMetadata = {
  sourceRevision,
  imageRepository,
  strategyBehaviorHash: 'c'.repeat(64),
  strategyParameterHash: 'f'.repeat(64),
}
const qualificationRunId = 'e'.repeat(64)
const alpacaAccountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const alpacaKey = 'paper-key-must-remain-redacted'
const alpacaSecret = 'paper-secret-must-remain-redacted'
const clickhousePassword = 'clickhouse-password-must-remain-redacted'
const postgresUrl = 'postgresql://bayn:postgres-secret-must-remain-redacted@postgres.test:5432/bayn'

const baseParsedConfig: ParsedRuntimeConfig = {
  host: '0.0.0.0',
  port: 8080,
  qualificationRunId: undefined,
  configuredPaperProofCommand: undefined,
  configuredPaperProofPhase: undefined,
  maximumAuthority: Authority.Observe,
  configuredBuild: {
    ...buildMetadata,
    imageDigest,
  },
  provenanceMode: 'production',
  healthIntervalMs: 30_000,
  operationTimeoutMs: 30_000,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  cyclePollIntervalMs: 30_000,
  authorityGenerationHash,
  configuredAlpaca: {
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
    snapshotId: 'd'.repeat(64),
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

const completeAlpacaConfig: ParsedRuntimeConfig['configuredAlpaca'] = {
  ...baseParsedConfig.configuredAlpaca,
  accountId: alpacaAccountId,
  key: Redacted.make(alpacaKey),
  secret: Redacted.make(alpacaSecret),
}

const resolutionInput = (
  overrides: Partial<ParsedRuntimeConfig> = {},
  embedded: EmbeddedBuildMetadata | null = buildMetadata,
): RuntimeConfigResolutionInput => ({
  parsed: {
    ...baseParsedConfig,
    ...overrides,
  },
  embeddedBuildMetadata: embedded === null ? undefined : embedded,
})

const runtimeEnvironment = new Map([
  ['BAYN_CODE_REVISION', sourceRevision],
  ['BAYN_IMAGE_REPOSITORY', imageRepository],
  ['BAYN_IMAGE_DIGEST', imageDigest],
  ['BAYN_STRATEGY_BEHAVIOR_HASH', buildMetadata.strategyBehaviorHash],
  ['BAYN_STRATEGY_PARAMETER_HASH', buildMetadata.strategyParameterHash],
  ['BAYN_AUTHORITY_GENERATION_HASH', authorityGenerationHash],
  ['BAYN_CLICKHOUSE_URL', 'http://clickhouse.test:8123'],
  ['BAYN_CLICKHOUSE_USERNAME', 'bayn'],
  ['BAYN_CLICKHOUSE_PASSWORD', 'secret'],
  ['BAYN_SIGNAL_SNAPSHOT_ID', 'd'.repeat(64)],
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

const expectResolutionFailure = (
  input: RuntimeConfigResolutionInput,
  expected: RuntimeConfigResolutionFailure,
): void => {
  const result = resolveRuntimeConfig(input)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toEqual(expected)
  }
}

describe('pure runtime configuration resolution', () => {
  const validModes = [
    {
      name: 'production OBSERVE without an Alpaca binding',
      input: resolutionInput({ authorityGenerationHash: undefined }),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'embedded',
        hasAlpaca: false,
        hasPaperProofCommand: false,
      },
    },
    {
      name: 'production OBSERVE with an Alpaca read binding',
      input: resolutionInput({ configuredAlpaca: completeAlpacaConfig }),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'embedded',
        hasAlpaca: true,
        hasPaperProofCommand: false,
      },
    },
    {
      name: 'production OBSERVE PREPARE DISCOVER',
      input: resolutionInput({
        qualificationRunId,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
        configuredAlpaca: completeAlpacaConfig,
      }),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'embedded',
        hasAlpaca: true,
        hasPaperProofCommand: true,
      },
    },
    {
      name: 'production PAPER with a complete Alpaca binding',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        configuredAlpaca: completeAlpacaConfig,
      }),
      expected: {
        maximumAuthority: Authority.Paper,
        verification: 'embedded',
        hasAlpaca: true,
        hasPaperProofCommand: false,
      },
    },
    {
      name: 'development OBSERVE without an Alpaca binding',
      input: resolutionInput(
        {
          provenanceMode: 'development',
          authorityGenerationHash: undefined,
          postgres: { ...baseParsedConfig.postgres, tls: false },
        },
        null,
      ),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'development-configured',
        hasAlpaca: false,
        hasPaperProofCommand: false,
      },
    },
    {
      name: 'development OBSERVE with an Alpaca read binding',
      input: resolutionInput(
        {
          provenanceMode: 'development',
          configuredAlpaca: completeAlpacaConfig,
        },
        null,
      ),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'development-configured',
        hasAlpaca: true,
        hasPaperProofCommand: false,
      },
    },
    {
      name: 'development OBSERVE PREPARE DISCOVER',
      input: resolutionInput(
        {
          provenanceMode: 'development',
          qualificationRunId,
          configuredPaperProofCommand: 'PREPARE',
          configuredPaperProofPhase: 'DISCOVER',
          configuredAlpaca: completeAlpacaConfig,
        },
        null,
      ),
      expected: {
        maximumAuthority: Authority.Observe,
        verification: 'development-configured',
        hasAlpaca: true,
        hasPaperProofCommand: true,
      },
    },
    {
      name: 'development PAPER with a complete Alpaca binding',
      input: resolutionInput(
        {
          provenanceMode: 'development',
          maximumAuthority: Authority.Paper,
          configuredAlpaca: completeAlpacaConfig,
        },
        null,
      ),
      expected: {
        maximumAuthority: Authority.Paper,
        verification: 'development-configured',
        hasAlpaca: true,
        hasPaperProofCommand: false,
      },
    },
  ] as const

  for (const mode of validModes) {
    test(mode.name, () => {
      const result = resolveRuntimeConfig(mode.input)

      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect({
          maximumAuthority: result.success.maximumAuthority,
          verification: result.success.build.verification,
          hasAlpaca: result.success.alpaca !== undefined,
          hasPaperProofCommand: result.success.paperProofCommand !== undefined,
        }).toEqual(mode.expected)
        expect(result.success.build.imageDigest).toBe(imageDigest)
        expect(Redacted.isRedacted(result.success.clickhouse.password)).toBe(true)
        expect(Redacted.isRedacted(result.success.postgres.url)).toBe(true)
        if (result.success.alpaca !== undefined) {
          expect(Redacted.isRedacted(result.success.alpaca.key)).toBe(true)
          expect(Redacted.isRedacted(result.success.alpaca.secret)).toBe(true)
        }
      }
    })
  }

  const partialCredentialCases = [
    ['account ID only', true, false, false],
    ['key ID only', false, true, false],
    ['secret key only', false, false, true],
    ['account ID and key ID', true, true, false],
    ['account ID and secret key', true, false, true],
    ['key ID and secret key', false, true, true],
  ] as const

  for (const [name, hasAccountId, hasKeyId, hasSecretKey] of partialCredentialCases) {
    test(`rejects partial Alpaca credentials with ${name}`, () => {
      const input = resolutionInput({
        configuredAlpaca: {
          ...baseParsedConfig.configuredAlpaca,
          accountId: hasAccountId ? alpacaAccountId : undefined,
          key: hasKeyId ? Redacted.make(alpacaKey) : undefined,
          secret: hasSecretKey ? Redacted.make(alpacaSecret) : undefined,
        },
      })

      expectResolutionFailure(input, {
        _tag: 'IncompleteAlpacaCredentials',
        configured: {
          accountId: hasAccountId,
          keyId: hasKeyId,
          secretKey: hasSecretKey,
        },
      })
    })
  }

  const relationalFailures = [
    {
      name: 'cycle poll interval equal to stall threshold',
      input: resolutionInput({ cyclePollIntervalMs: 300_000 }),
      expected: {
        _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
        cyclePollIntervalMs: 300_000,
        cycleStallThresholdMs: 300_000,
      },
    },
    {
      name: 'cycle poll interval greater than stall threshold',
      input: resolutionInput({ cyclePollIntervalMs: 300_001 }),
      expected: {
        _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
        cyclePollIntervalMs: 300_001,
        cycleStallThresholdMs: 300_000,
      },
    },
    {
      name: 'complete Alpaca credentials without an authority generation',
      input: resolutionInput({
        authorityGenerationHash: undefined,
        configuredAlpaca: completeAlpacaConfig,
      }),
      expected: {
        _tag: 'MissingAlpacaAuthorityGeneration',
        accountId: alpacaAccountId,
      },
    },
    {
      name: 'PAPER without an Alpaca binding',
      input: resolutionInput({ maximumAuthority: Authority.Paper }),
      expected: {
        _tag: 'PaperAuthorityRequiresAlpacaBinding',
        maximumAuthority: Authority.Paper,
      },
    },
    {
      name: 'paper command without its phase',
      input: resolutionInput({ configuredPaperProofCommand: 'PREPARE' }),
      expected: {
        _tag: 'IncompletePaperProofCommand',
        commandConfigured: true,
        phaseConfigured: false,
      },
    },
    {
      name: 'paper phase without its command',
      input: resolutionInput({ configuredPaperProofPhase: 'DISCOVER' }),
      expected: {
        _tag: 'IncompletePaperProofCommand',
        commandConfigured: false,
        phaseConfigured: true,
      },
    },
    {
      name: 'PREPARE DISCOVER with PAPER authority',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        configuredAlpaca: completeAlpacaConfig,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
      }),
      expected: {
        _tag: 'PaperProofCommandRequiresObserveAuthority',
        maximumAuthority: Authority.Paper,
      },
    },
    {
      name: 'PREPARE DISCOVER without a qualification run',
      input: resolutionInput({
        configuredAlpaca: completeAlpacaConfig,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
      }),
      expected: {
        _tag: 'PaperProofCommandRequiresQualificationRun',
      },
    },
    {
      name: 'PREPARE DISCOVER without an Alpaca read binding',
      input: resolutionInput({
        qualificationRunId,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
      }),
      expected: {
        _tag: 'PaperProofCommandRequiresAlpacaBinding',
      },
    },
    {
      name: 'production provenance without embedded metadata',
      input: resolutionInput({}, null),
      expected: {
        _tag: 'ProductionProvenanceRequiresEmbeddedMetadata',
        provenanceMode: 'production',
      },
    },
    {
      name: 'development provenance with embedded metadata',
      input: resolutionInput({ provenanceMode: 'development' }),
      expected: {
        _tag: 'EmbeddedMetadataRequiresProductionProvenance',
        provenanceMode: 'development',
      },
    },
    {
      name: 'production PostgreSQL without TLS',
      input: resolutionInput({
        postgres: { ...baseParsedConfig.postgres, tls: false },
      }),
      expected: {
        _tag: 'ProductionPostgresRequiresTls',
        postgresTls: false,
      },
    },
    {
      name: 'configured source revision mismatch',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          sourceRevision: 'd'.repeat(40),
        },
      }),
      expected: {
        _tag: 'SourceRevisionMismatch',
        configuredSourceRevision: 'd'.repeat(40),
        embeddedSourceRevision: sourceRevision,
      },
    },
    {
      name: 'configured image repository mismatch',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          imageRepository: 'registry.example.invalid/bayn',
        },
      }),
      expected: {
        _tag: 'ImageRepositoryMismatch',
        configuredImageRepository: 'registry.example.invalid/bayn',
        embeddedImageRepository: imageRepository,
      },
    },
    {
      name: 'configured strategy behavior hash mismatch',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          strategyBehaviorHash: 'd'.repeat(64),
        },
      }),
      expected: {
        _tag: 'StrategyBehaviorHashMismatch',
        configuredStrategyBehaviorHash: 'd'.repeat(64),
        embeddedStrategyBehaviorHash: buildMetadata.strategyBehaviorHash,
      },
    },
    {
      name: 'configured strategy parameter hash mismatch',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          strategyParameterHash: 'e'.repeat(64),
        },
      }),
      expected: {
        _tag: 'StrategyParameterHashMismatch',
        configuredStrategyParameterHash: 'e'.repeat(64),
        embeddedStrategyParameterHash: buildMetadata.strategyParameterHash,
      },
    },
  ] as const satisfies ReadonlyArray<{
    readonly name: string
    readonly input: RuntimeConfigResolutionInput
    readonly expected: RuntimeConfigResolutionFailure
  }>

  for (const invalid of relationalFailures) {
    test(`rejects ${invalid.name}`, () => {
      expectResolutionFailure(invalid.input, invalid.expected)
    })
  }

  const invalidBounds = [
    {
      name: 'data start after data end',
      bounds: {
        ...baseParsedConfig.clickhouse.bounds,
        dataStart: '2026-07-18',
        lookbackStart: '2026-07-18',
        evaluationStart: '2026-07-18',
        evaluationEnd: '2026-07-18',
      },
      message: 'must not be after dataEnd\n  at ["dataStart"]\nmust not follow dataEnd\n  at ["evaluationEnd"]',
    },
    {
      name: 'lookback start before data start',
      bounds: {
        ...baseParsedConfig.clickhouse.bounds,
        dataStart: '2018-01-03',
      },
      message: 'must not precede dataStart\n  at ["lookbackStart"]',
    },
    {
      name: 'evaluation start before lookback start',
      bounds: {
        ...baseParsedConfig.clickhouse.bounds,
        lookbackStart: '2019-01-03',
      },
      message: 'must not precede lookbackStart\n  at ["evaluationStart"]',
    },
    {
      name: 'evaluation end before evaluation start',
      bounds: {
        ...baseParsedConfig.clickhouse.bounds,
        evaluationStart: '2025-01-03',
        evaluationEnd: '2024-01-03',
      },
      message: 'must not precede evaluationStart\n  at ["evaluationEnd"]',
    },
    {
      name: 'evaluation end after data end',
      bounds: {
        ...baseParsedConfig.clickhouse.bounds,
        dataEnd: '2025-01-03',
      },
      message: 'must not follow dataEnd\n  at ["evaluationEnd"]',
    },
  ] as const

  for (const invalid of invalidBounds) {
    test(`preserves the structured Schema cause for ${invalid.name}`, () => {
      const result = resolveRuntimeConfig(
        resolutionInput({
          clickhouse: {
            ...baseParsedConfig.clickhouse,
            bounds: invalid.bounds,
          },
        }),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('InvalidEvaluationBounds')
        if (result.failure._tag === 'InvalidEvaluationBounds') {
          expect(result.failure.cause._tag).toBe('SchemaError')
          expect(result.failure.cause.issue._tag).toBe('Composite')
          expect(result.failure.cause.message).toBe(invalid.message)
        }
      }
    })
  }

  test('preserves the structured Schema cause for malformed embedded metadata', () => {
    const result = resolveRuntimeConfig(resolutionInput({}, { ...buildMetadata, sourceRevision: 'incomplete' }))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('InvalidEmbeddedBuildMetadata')
      if (result.failure._tag === 'InvalidEmbeddedBuildMetadata') {
        expect(result.failure.cause._tag).toBe('SchemaError')
        expect(result.failure.cause.issue._tag).toBe('Composite')
        expect(result.failure.cause.message).toBe(
          'Expected a string matching the RegExp ^[a-f0-9]{40}$, got "incomplete"\n  at ["sourceRevision"]',
        )
      }
    }
  })

  const precedenceCases = [
    {
      name: 'evaluation bounds before cycle timing',
      input: resolutionInput({
        cyclePollIntervalMs: 300_000,
        clickhouse: {
          ...baseParsedConfig.clickhouse,
          bounds: {
            ...baseParsedConfig.clickhouse.bounds,
            evaluationStart: '2026-07-18',
          },
        },
      }),
      expectedTag: 'InvalidEvaluationBounds',
    },
    {
      name: 'cycle timing before Alpaca credential completeness',
      input: resolutionInput({
        cyclePollIntervalMs: 300_000,
        configuredAlpaca: {
          ...baseParsedConfig.configuredAlpaca,
          key: Redacted.make(alpacaKey),
        },
      }),
      expectedTag: 'CyclePollIntervalNotShorterThanStallThreshold',
    },
    {
      name: 'credential completeness before authority generation',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        authorityGenerationHash: undefined,
        configuredAlpaca: {
          ...baseParsedConfig.configuredAlpaca,
          key: Redacted.make(alpacaKey),
        },
      }),
      expectedTag: 'IncompleteAlpacaCredentials',
    },
    {
      name: 'authority generation before PAPER binding',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        authorityGenerationHash: undefined,
        configuredAlpaca: completeAlpacaConfig,
      }),
      expectedTag: 'MissingAlpacaAuthorityGeneration',
    },
    {
      name: 'PAPER binding before paper command completeness',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        configuredPaperProofCommand: 'PREPARE',
      }),
      expectedTag: 'PaperAuthorityRequiresAlpacaBinding',
    },
    {
      name: 'paper command completeness before provenance',
      input: resolutionInput({
        configuredPaperProofCommand: 'PREPARE',
        provenanceMode: 'development',
      }),
      expectedTag: 'IncompletePaperProofCommand',
    },
    {
      name: 'paper command authority before qualification pin',
      input: resolutionInput({
        maximumAuthority: Authority.Paper,
        configuredAlpaca: completeAlpacaConfig,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
      }),
      expectedTag: 'PaperProofCommandRequiresObserveAuthority',
    },
    {
      name: 'qualification pin before Alpaca read binding',
      input: resolutionInput({
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
      }),
      expectedTag: 'PaperProofCommandRequiresQualificationRun',
    },
    {
      name: 'Alpaca read binding before provenance',
      input: resolutionInput({
        qualificationRunId,
        configuredPaperProofCommand: 'PREPARE',
        configuredPaperProofPhase: 'DISCOVER',
        provenanceMode: 'development',
      }),
      expectedTag: 'PaperProofCommandRequiresAlpacaBinding',
    },
    {
      name: 'missing embedded metadata before PostgreSQL TLS',
      input: resolutionInput(
        {
          postgres: { ...baseParsedConfig.postgres, tls: false },
        },
        null,
      ),
      expectedTag: 'ProductionProvenanceRequiresEmbeddedMetadata',
    },
    {
      name: 'provenance mode before PostgreSQL TLS',
      input: resolutionInput({
        provenanceMode: 'development',
        postgres: { ...baseParsedConfig.postgres, tls: false },
      }),
      expectedTag: 'EmbeddedMetadataRequiresProductionProvenance',
    },
    {
      name: 'PostgreSQL TLS before embedded metadata decoding',
      input: resolutionInput(
        {
          postgres: { ...baseParsedConfig.postgres, tls: false },
        },
        { ...buildMetadata, sourceRevision: 'incomplete' },
      ),
      expectedTag: 'ProductionPostgresRequiresTls',
    },
    {
      name: 'embedded metadata decoding before provenance mismatches',
      input: resolutionInput(
        {
          configuredBuild: {
            ...baseParsedConfig.configuredBuild,
            sourceRevision: 'd'.repeat(40),
          },
        },
        { ...buildMetadata, sourceRevision: 'incomplete' },
      ),
      expectedTag: 'InvalidEmbeddedBuildMetadata',
    },
    {
      name: 'source revision before image repository',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          sourceRevision: 'd'.repeat(40),
          imageRepository: 'registry.example.invalid/bayn',
        },
      }),
      expectedTag: 'SourceRevisionMismatch',
    },
    {
      name: 'image repository before strategy behavior hash',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          imageRepository: 'registry.example.invalid/bayn',
          strategyBehaviorHash: 'd'.repeat(64),
        },
      }),
      expectedTag: 'ImageRepositoryMismatch',
    },
    {
      name: 'strategy behavior hash before strategy parameter hash',
      input: resolutionInput({
        configuredBuild: {
          ...baseParsedConfig.configuredBuild,
          strategyBehaviorHash: 'd'.repeat(64),
          strategyParameterHash: 'e'.repeat(64),
        },
      }),
      expectedTag: 'StrategyBehaviorHashMismatch',
    },
  ] as const satisfies ReadonlyArray<{
    readonly name: string
    readonly input: RuntimeConfigResolutionInput
    readonly expectedTag: RuntimeConfigResolutionFailure['_tag']
  }>

  for (const precedence of precedenceCases) {
    test(`preserves precedence: ${precedence.name}`, () => {
      const result = resolveRuntimeConfig(precedence.input)

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe(precedence.expectedTag)
      }
    })
  }

  test('does not render any configured secret in a failure', () => {
    const result = resolveRuntimeConfig(
      resolutionInput({
        configuredAlpaca: {
          ...baseParsedConfig.configuredAlpaca,
          key: Redacted.make(alpacaKey),
          secret: Redacted.make(alpacaSecret),
        },
      }),
    )
    const rendered = JSON.stringify(result)

    expect(Result.isFailure(result)).toBe(true)
    for (const secret of [alpacaKey, alpacaSecret, clickhousePassword, postgresUrl]) {
      expect(rendered).not.toContain(secret)
    }
  })
})

describe('Effect configuration', () => {
  test('loads runtime configuration with validated defaults', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), runtimeEnvironment))

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8080)
    expect(config.qualificationRunId).toBeUndefined()
    expect(config.paperProofCommand).toBeUndefined()
    expect(config.maximumAuthority).toBe(Authority.Observe)
    expect(config.healthIntervalMs).toBe(30_000)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.cycleStallThresholdMs).toBe(300_000)
    expect(config.reconciliationStaleThresholdMs).toBe(120_000)
    expect(config.unknownMutationThresholdMs).toBe(300_000)
    expect(config.cyclePollIntervalMs).toBe(30_000)
    expect(config.alpaca).toBeUndefined()
    expect(config.clickhouse).toMatchObject({
      snapshotId: 'd'.repeat(64),
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
    })
    expect(Redacted.isRedacted(config.clickhouse.password)).toBe(true)
    expect(Redacted.isRedacted(config.postgres.url)).toBe(true)
    expect(config.postgres).toMatchObject({
      tls: true,
      caPath: '/var/run/secrets/bayn/postgres/ca.crt',
    })
    expect(config.tigerBeetle.clusterId).toBe(2001n)
    expect(config.tigerBeetle.replicaAddresses).toEqual(['tigerbeetle.test:3000'])
    expect(config.build).toEqual({ ...buildMetadata, imageDigest, verification: 'embedded' })
  })

  test('loads an optional pinned terminal qualification run', async () => {
    const pinned = new Map(runtimeEnvironment)
    pinned.set('BAYN_QUALIFICATION_RUN_ID', 'e'.repeat(64))

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), pinned))

    expect(config.qualificationRunId).toBe('e'.repeat(64))
  })

  test('enables only an explicit OBSERVE PREPARE DISCOVER command', async () => {
    const configured = new Map(runtimeEnvironment)
    configured.set('BAYN_QUALIFICATION_RUN_ID', 'e'.repeat(64))
    configured.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    configured.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    configured.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')
    configured.set('BAYN_PAPER_COMMAND', 'PREPARE')
    configured.set('BAYN_PAPER_PREPARE_PHASE', 'DISCOVER')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), configured))

    expect(config.paperProofCommand).toEqual({ command: 'PREPARE', phase: 'DISCOVER' })
    expect(config.maximumAuthority).toBe(Authority.Observe)
  })

  test('rejects invalid, incomplete, and PAPER discovery commands before runtime composition', async () => {
    const complete = new Map(runtimeEnvironment)
    complete.set('BAYN_QUALIFICATION_RUN_ID', 'e'.repeat(64))
    complete.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    complete.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    complete.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')

    const invalid = new Map(complete)
    invalid.set('BAYN_PAPER_COMMAND', 'SUBMIT')
    invalid.set('BAYN_PAPER_PREPARE_PHASE', 'DISCOVER')
    expect(await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })

    const incomplete = new Map(complete)
    incomplete.set('BAYN_PAPER_COMMAND', 'PREPARE')
    expect(
      await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), incomplete))),
    ).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'paper-command',
    })

    const missingPin = new Map(complete)
    missingPin.delete('BAYN_QUALIFICATION_RUN_ID')
    missingPin.set('BAYN_PAPER_COMMAND', 'PREPARE')
    missingPin.set('BAYN_PAPER_PREPARE_PHASE', 'DISCOVER')
    expect(
      await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), missingPin))),
    ).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'paper-command',
      message: 'PREPARE DISCOVER requires a pinned terminal qualification run',
    })

    const missingBroker = new Map(runtimeEnvironment)
    missingBroker.set('BAYN_QUALIFICATION_RUN_ID', 'e'.repeat(64))
    missingBroker.set('BAYN_PAPER_COMMAND', 'PREPARE')
    missingBroker.set('BAYN_PAPER_PREPARE_PHASE', 'DISCOVER')
    expect(
      await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), missingBroker))),
    ).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'paper-command',
      message: 'PREPARE DISCOVER requires a complete Alpaca read binding',
    })

    const paper = new Map(complete)
    paper.set('BAYN_PAPER_COMMAND', 'PREPARE')
    paper.set('BAYN_PAPER_PREPARE_PHASE', 'DISCOVER')
    paper.set('BAYN_MAXIMUM_AUTHORITY', Authority.Paper)
    expect(await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), paper)))).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'paper-command',
      message: 'PREPARE DISCOVER requires OBSERVE maximum authority',
    })
  })

  test('allows no authority generation while autonomous cycle composition is disabled', async () => {
    const environment = new Map(runtimeEnvironment)
    environment.delete('BAYN_AUTHORITY_GENERATION_HASH')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), environment))

    expect(config.alpaca).toBeUndefined()
  })

  test('requires an explicit valid authority generation to resolve an Alpaca binding', async () => {
    for (const value of [undefined, 'not-a-generation-hash']) {
      const environment = new Map(runtimeEnvironment)
      environment.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
      environment.set('BAYN_ALPACA_KEY_ID', 'paper-key')
      environment.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')
      if (value === undefined) {
        environment.delete('BAYN_AUTHORITY_GENERATION_HASH')
      } else {
        environment.set('BAYN_AUTHORITY_GENERATION_HASH', value)
      }

      const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), environment)))

      expect(error).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: value === undefined ? 'authority-generation' : 'load',
      })
    }
  })

  test('loads one complete redacted Alpaca read binding', async () => {
    const configured = new Map(runtimeEnvironment)
    configured.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    configured.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    configured.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), configured))

    expect(config.alpaca).toMatchObject({
      accountId: '61e69015-8549-4bfd-b9c3-01e75843f47d',
      authorityGenerationHash,
      proxyUrl: 'http://bayn-egress-proxy:3128',
      retryAttempts: 2,
      reconciliationIntervalMs: 30_000,
    })
    expect(config.alpaca).toBeDefined()
    if (config.alpaca !== undefined) {
      expect(Redacted.isRedacted(config.alpaca.key)).toBe(true)
      expect(Redacted.isRedacted(config.alpaca.secret)).toBe(true)
    }
  })

  test('rejects a partial Alpaca credential binding instead of silently staying dormant', async () => {
    const partial = new Map(runtimeEnvironment)
    partial.set('BAYN_ALPACA_KEY_ID', alpacaKey)

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), partial)))

    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'alpaca',
      message: 'Alpaca account ID, key ID, and secret key must be configured together',
      cause: {
        _tag: 'IncompleteAlpacaCredentials',
        configured: {
          accountId: false,
          keyId: true,
          secretKey: false,
        },
      },
    })
    expect(JSON.stringify(error)).not.toContain(alpacaKey)
    expect(String(error)).not.toContain(alpacaKey)
  })

  test('requires a complete Alpaca binding for PAPER while allowing credential-free OBSERVE', async () => {
    const observe = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), runtimeEnvironment))
    expect(observe.maximumAuthority).toBe(Authority.Observe)
    expect(observe.alpaca).toBeUndefined()

    const paper = new Map(runtimeEnvironment)
    paper.set('BAYN_MAXIMUM_AUTHORITY', Authority.Paper)
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), paper)))

    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'alpaca',
      message: 'PAPER maximum authority requires a complete Alpaca account binding',
    })
  })

  test('supports an explicit, visibly unverified development provenance path', async () => {
    const development = new Map(runtimeEnvironment)
    development.set('BAYN_PROVENANCE_MODE', 'development')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(undefined), development))

    expect(config.build).toMatchObject({
      sourceRevision,
      imageRepository,
      imageDigest,
      verification: 'development-configured',
    })
    expect(config.build.strategyBehaviorHash).toMatch(/^[a-f0-9]{64}$/)
    expect(config.build.strategyParameterHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('does not let missing build facts or development mode bypass production verification', async () => {
    const missing = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(undefined), runtimeEnvironment)))
    expect(missing).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
    })

    const bypass = new Map(runtimeEnvironment)
    bypass.set('BAYN_PROVENANCE_MODE', 'development')
    const mismatch = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), bypass)))
    expect(mismatch).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
    })
  })

  test('returns a typed configuration failure for invalid values', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_OPERATION_TIMEOUT_MS', '0')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('keeps operational thresholds and the cycle poll interval bounded to one day', async () => {
    for (const [name, value] of [
      ['BAYN_CYCLE_STALL_THRESHOLD_MS', '999'],
      ['BAYN_RECONCILIATION_STALE_THRESHOLD_MS', '86400001'],
      ['BAYN_UNKNOWN_MUTATION_THRESHOLD_MS', '0'],
      ['BAYN_CYCLE_POLL_INTERVAL_MS', '999'],
      ['BAYN_CYCLE_POLL_INTERVAL_MS', '86400001'],
    ] as const) {
      const invalid = new Map(runtimeEnvironment)
      invalid.set(name, value)

      const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
      expect(error).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'load',
      })
    }

    const configured = new Map(runtimeEnvironment)
    configured.set('BAYN_CYCLE_POLL_INTERVAL_MS', '15000')
    expect(
      (await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), configured))).cyclePollIntervalMs,
    ).toBe(15_000)

    const incoherent = new Map(runtimeEnvironment)
    incoherent.set('BAYN_CYCLE_POLL_INTERVAL_MS', '300000')
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), incoherent)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'cycle-loop',
      message: 'cycle poll interval must be shorter than the cycle stall threshold',
    })
  })

  test('rejects an invalid pinned qualification run ID', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_QUALIFICATION_RUN_ID', 'not-a-run-id')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('accepts only the closed broker-authority vocabulary', async () => {
    const paper = new Map(runtimeEnvironment)
    paper.set('BAYN_MAXIMUM_AUTHORITY', Authority.Paper)
    paper.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    paper.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    paper.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')
    expect((await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), paper))).maximumAuthority).toBe(
      Authority.Paper,
    )

    const live = new Map(runtimeEnvironment)
    live.set('BAYN_MAXIMUM_AUTHORITY', 'LIVE')
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), live)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('rejects evaluation bounds that are not ordered', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_SIGNAL_EVALUATION_START', '2026-07-18')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
      message: 'invalid Signal evaluation bounds: must not precede evaluationStart\n  at ["evaluationEnd"]',
      cause: {
        _tag: 'InvalidEvaluationBounds',
        cause: {
          _tag: 'SchemaError',
          message: 'must not precede evaluationStart\n  at ["evaluationEnd"]',
          issue: {
            _tag: 'Composite',
          },
        },
      },
    })
  })

  test('does not permit plaintext PostgreSQL in a production artifact', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_POSTGRES_TLS', 'false')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
    })
  })

  test('fails closed when configured and embedded provenance diverge', async () => {
    for (const [name, value] of [
      ['BAYN_CODE_REVISION', 'd'.repeat(40)],
      ['BAYN_IMAGE_REPOSITORY', 'registry.example.invalid/bayn'],
      ['BAYN_STRATEGY_BEHAVIOR_HASH', 'd'.repeat(64)],
      ['BAYN_STRATEGY_PARAMETER_HASH', 'e'.repeat(64)],
    ] as const) {
      const invalid = new Map(runtimeEnvironment)
      invalid.set(name, value)

      const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
      expect(error).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'provenance',
      })
    }
  })
})
