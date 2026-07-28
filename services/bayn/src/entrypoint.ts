import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, flow, Layer, Match, pipe, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import {
  makeApplicationPlan,
  runApplication,
  type ApplicationDependencies,
  type ApplicationIdentity,
  type ApplicationPlan,
  type ApplicationPlanFor,
} from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { BrokerSession, live as AlpacaBrokerLive, type BrokerReadShape } from './broker/alpaca'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig, type LoadedRuntimeConfig } from './config'
import {
  makeRuntimeProvenanceResult,
  makeStrategyProtocolHashResult,
  type ContractConstructionFailure,
  type RuntimeProvenance,
} from './contracts'
import { CycleObservability, CycleObservabilityLive } from './db/cycle-observability'
import { CycleStoreLive } from './db/cycle-store'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from './db/evidence-store'
import { PaperStoreLive } from './db/paper-store'
import { WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import { canonicalHashV1Result, type CanonicalJsonFailure } from './hash'
import { HttpServerLive } from './http'
import { Journal, JournalLive } from './ledger'
import { MarketData, MarketDataLive } from './market-data'
import { loadObserveRiskPolicy, makeObserveAutonomousCycleStartup } from './observe-composition'
import { sqlResource } from './operations'
import {
  discoverPaperCandidates,
  renderPaperCandidateDiscoveryError,
  type PaperCandidateDiscoveryReceipt,
} from './paper-candidate-discovery'
import { loadDefaultProtocol, type CausalProtocol } from './protocol'
import { makeStrategy, type Strategy } from './strategy'

type RuntimeIdentityFailure =
  | {
      readonly _tag: 'RuntimeParameterHashFailed'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'RuntimeProvenanceFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'RuntimeStrategyProtocolHashFailed'
      readonly cause: ContractConstructionFailure
    }

type RuntimeSeed = {
  readonly config: LoadedRuntimeConfig
  readonly protocol: CausalProtocol
}

type ParameterizedRuntime = RuntimeSeed & { readonly parameterHash: string }
type ProvenanceRuntime = ParameterizedRuntime & { readonly provenance: RuntimeProvenance }
type StrategyRuntime = ProvenanceRuntime & { readonly strategy: Strategy }

const hashRuntimeParameters = (seed: RuntimeSeed): Result.Result<ParameterizedRuntime, RuntimeIdentityFailure> =>
  pipe(
    canonicalHashV1Result(seed.protocol),
    Result.mapError((cause): RuntimeIdentityFailure => ({ _tag: 'RuntimeParameterHashFailed', cause })),
    Result.map((parameterHash) => ({ ...seed, parameterHash })),
  )

const addRuntimeProvenance = (
  parameterized: ParameterizedRuntime,
): Result.Result<ProvenanceRuntime, RuntimeIdentityFailure> =>
  pipe(
    makeRuntimeProvenanceResult({
      sourceRevision: parameterized.config.build.sourceRevision,
      image: {
        repository: parameterized.config.build.imageRepository,
        digest: parameterized.config.build.imageDigest,
      },
      strategy: {
        name: 'risk-balanced-trend',
        behaviorHash: riskBalancedTrendBehaviorHash,
        parameterHash: parameterized.parameterHash,
        parameterSchemaVersion: parameterized.protocol.schemaVersion,
      },
    }),
    Result.mapError(
      (cause): RuntimeIdentityFailure => ({
        _tag: 'RuntimeProvenanceFailed',
        cause,
      }),
    ),
    Result.map((provenance) => ({ ...parameterized, provenance })),
  )

const addStrategy = (runtime: ProvenanceRuntime): StrategyRuntime => ({
  ...runtime,
  strategy: makeStrategy(runtime.protocol, runtime.provenance),
})

const addStrategyProtocolHash = (
  runtime: StrategyRuntime,
): Result.Result<ApplicationIdentity, RuntimeIdentityFailure> =>
  pipe(
    makeStrategyProtocolHashResult(runtime.strategy.provenance.strategy),
    Result.mapError(
      (cause): RuntimeIdentityFailure => ({
        _tag: 'RuntimeStrategyProtocolHashFailed',
        cause,
      }),
    ),
    Result.map((strategyProtocolHash) => ({
      config: runtime.config,
      protocol: runtime.protocol,
      parameterHash: runtime.parameterHash,
      strategy: runtime.strategy,
      strategyProtocolHash,
    })),
  )

const makeRuntimeIdentity = flow(
  hashRuntimeParameters,
  Result.flatMap(addRuntimeProvenance),
  Result.map(addStrategy),
  Result.flatMap(addStrategyProtocolHash),
)

const runtimeIdentityError = (failure: RuntimeIdentityFailure) =>
  pipe(
    Match.value(failure),
    Match.tag('RuntimeParameterHashFailed', ({ cause }) =>
      operationalError(
        'strategy',
        'runtime-identity/parameter-hash',
        'runtime strategy parameter-hash construction failed',
        cause,
      ),
    ),
    Match.tag('RuntimeProvenanceFailed', ({ cause }) =>
      operationalError(
        'strategy',
        'runtime-identity/provenance',
        'runtime strategy provenance construction failed',
        cause,
      ),
    ),
    Match.tag('RuntimeStrategyProtocolHashFailed', ({ cause }) =>
      operationalError(
        'strategy',
        'runtime-identity/strategy-protocol-hash',
        'runtime strategy protocol-hash construction failed',
        cause,
      ),
    ),
    Match.exhaustive,
  )

const verifyRuntimeIdentity = (
  identity: ApplicationIdentity,
): Effect.Effect<ApplicationIdentity, ReturnType<typeof operationalError>> =>
  pipe(
    Effect.all(
      [
        verifyBehaviorHash(identity.config.build, riskBalancedTrendBehaviorHash),
        verifyParameterHash(identity.config.build, identity.parameterHash),
      ],
      { discard: true },
    ),
    Effect.as(identity),
  )

export const loadApplicationPlan = pipe(
  Effect.all({ config: loadConfig(), protocol: loadDefaultProtocol }),
  Effect.flatMap(flow(makeRuntimeIdentity, Effect.fromResult, Effect.mapError(runtimeIdentityError))),
  Effect.flatMap(verifyRuntimeIdentity),
  Effect.map(makeApplicationPlan),
)

export const ClickHouseClientResourceLive = (config: LoadedRuntimeConfig) =>
  ClickhouseClient.layer({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: Redacted.value(config.clickhouse.password),
    database: 'signal',
    application: 'bayn',
    request_timeout: config.operationTimeoutMs,
  })

export const PostgresClientResourceLive = (config: LoadedRuntimeConfig) => PostgresClientLive(config)

export const EvidenceStoreResourceLive = (config: LoadedRuntimeConfig) => EvidenceStoreFromPostgres(config)

export const MarketDataResourceLive = (plan: ApplicationIdentity) => MarketDataLive(plan.config, plan.protocol)

export const JournalResourceLive = (config: LoadedRuntimeConfig) => JournalLive(config)

export const CycleObservabilityResourceLive = CycleObservabilityLive

export const PaperStoreResourceLive = (config: LoadedRuntimeConfig) => PaperStoreLive(config)

export const CycleStoreResourceLive = CycleStoreLive

export const WriterFenceResourceLive = WriterFenceLive

export const BrokerSessionResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  AlpacaBrokerLive(config.alpaca)

export const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const SignalMarketDataLive = (plan: ApplicationIdentity) => {
  const clickHouse = sqlResource(ClickHouseClientResourceLive(plan.config))
  return MarketDataResourceLive(plan).pipe(Layer.provide(clickHouse))
}

const PostgresAuthorityLive = (config: LoadedRuntimeConfig) =>
  sqlResource(EvidenceStoreResourceLive(config).pipe(Layer.provideMerge(PostgresClientResourceLive(config))))

export const BrokerlessApplicationResourcesLive = (plan: ApplicationPlanFor<'BrokerlessService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  return Layer.mergeAll(
    HttpServerLive(plan.config),
    SignalMarketDataLive(plan),
    postgres,
    JournalResourceLive(plan.config),
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const AutonomousObserveApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousObserveService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    HttpServerLive(plan.config),
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
    BrokerSessionResourceLive(plan.config),
    PaperStoreResourceLive(plan.config).pipe(Layer.provide(Layer.merge(postgres, journal))),
    WriterFenceResourceLive.pipe(Layer.provide(postgres)),
    CycleStoreResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const PaperCandidateDiscoveryResourcesLive = (plan: ApplicationPlanFor<'PaperCandidateDiscovery'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  return Layer.mergeAll(
    postgres,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
    CycleStoreResourceLive.pipe(Layer.provide(postgres)),
    BrokerSessionResourceLive(plan.config),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

const applicationDependencies: Effect.Effect<
  ApplicationDependencies,
  never,
  MarketData | Journal | EvidenceStore | CycleObservability
> = Effect.all({
  marketData: MarketData,
  journal: Journal,
  evidenceStore: EvidenceStore,
  cycleObservability: CycleObservability,
})

const runBrokerlessService = (plan: ApplicationPlanFor<'BrokerlessService'>) =>
  applicationDependencies.pipe(
    Effect.flatMap((dependencies) =>
      runApplication<never, never>(plan.config, plan.strategy, dependencies, { _tag: 'Brokerless' }),
    ),
  )

const observeBroker = (plan: ApplicationPlanFor<'AutonomousObserveService'>, read: BrokerReadShape) => ({
  read,
  expectedAccountId: plan.config.alpaca.expectedAccountId,
  executionEligible: false,
  executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE' as const,
})

const observeCycle = (plan: ApplicationPlanFor<'AutonomousObserveService'>) =>
  makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
    maximumAuthority: plan.config.maximumAuthority,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    strategy: plan.strategy,
  })

const runAutonomousObserveService = (plan: ApplicationPlanFor<'AutonomousObserveService'>) =>
  Effect.all({ dependencies: applicationDependencies, session: BrokerSession }).pipe(
    Effect.flatMap(({ dependencies, session }) =>
      runApplication(plan.config, plan.strategy, dependencies, {
        _tag: 'AutonomousObserve',
        broker: observeBroker(plan, session.read),
        startCycle: observeCycle(plan),
      }),
    ),
  )

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const writeDiscoveryReceipt = (receipt: PaperCandidateDiscoveryReceipt) =>
  pipe(
    encodeJson(receipt),
    Effect.mapError((cause) =>
      operationalError('strategy', 'paper-candidate-output', 'paper candidate receipt encoding failed', cause),
    ),
    Effect.flatMap((output) =>
      pipe(
        Stdio.Stdio,
        Effect.flatMap((stdio) => Stream.run(Stream.make(`${output}\n`), stdio.stdout())),
      ),
    ),
  )

const policyHash = (policy: unknown): Effect.Effect<string, ReturnType<typeof operationalError>> =>
  pipe(
    canonicalHashV1Result(policy),
    Result.mapError((cause) =>
      operationalError(
        'strategy',
        'paper-candidate-policy',
        'source-controlled OBSERVE risk policy canonicalization failed',
        cause,
      ),
    ),
    Effect.fromResult,
  )

const paperCandidateIdentity = (plan: ApplicationPlanFor<'PaperCandidateDiscovery'>, riskPolicyHash: string) => ({
  sourceRevision: plan.config.build.sourceRevision,
  image: {
    repository: plan.config.build.imageRepository,
    digest: plan.config.build.imageDigest,
  },
  strategy: plan.strategy.provenance.strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  qualificationRunId: plan.config.qualificationRunId,
  accountId: plan.config.alpaca.expectedAccountId,
  authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  policyHash: riskPolicyHash,
})

const discoverPaperCandidate = (plan: ApplicationPlanFor<'PaperCandidateDiscovery'>, riskPolicyHash: string) =>
  discoverPaperCandidates(paperCandidateIdentity(plan, riskPolicyHash)).pipe(
    Effect.mapError((cause) =>
      operationalError('strategy', 'paper-candidate-discovery', renderPaperCandidateDiscoveryError(cause), cause),
    ),
  )

const runPaperCandidateDiscovery = (plan: ApplicationPlanFor<'PaperCandidateDiscovery'>) =>
  pipe(
    loadObserveRiskPolicy(plan.config.alpaca.expectedAccountId, plan.strategy.parameters.universe),
    Effect.mapError((cause) =>
      operationalError(
        'config',
        'paper-candidate-discovery',
        'source-controlled OBSERVE risk policy is invalid',
        cause,
      ),
    ),
    Effect.flatMap(policyHash),
    Effect.flatMap((riskPolicyHash) => discoverPaperCandidate(plan, riskPolicyHash)),
    Effect.flatMap(writeDiscoveryReceipt),
  )

export const runApplicationPlan = pipe(
  Match.type<ApplicationPlan>(),
  Match.tag('BrokerlessService', (plan) =>
    runBrokerlessService(plan).pipe(Effect.provide(BrokerlessApplicationResourcesLive(plan))),
  ),
  Match.tag('AutonomousObserveService', (plan) =>
    runAutonomousObserveService(plan).pipe(Effect.provide(AutonomousObserveApplicationResourcesLive(plan))),
  ),
  Match.tag('PaperCandidateDiscovery', (plan) =>
    runPaperCandidateDiscovery(plan).pipe(Effect.provide(PaperCandidateDiscoveryResourcesLive(plan))),
  ),
  Match.exhaustive,
)

export const program = loadApplicationPlan.pipe(Effect.flatMap(runApplicationPlan), Effect.scoped)
