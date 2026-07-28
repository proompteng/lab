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
import { BrokerMutationError, makeMutation } from './broker/alpaca-mutations'
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
import { ExecutionStoreLive } from './db/execution-store'
import { LiveCapitalGrantStore, LiveCapitalGrantStoreLive } from './db/live-capital-grant'
import { BrokerAccess } from './execution/authority'
import { IntentStore, IntentStoreLive } from './execution/intents'
import { MutationStore, MutationStoreLive } from './execution/mutations'
import { makeExecutionProgram } from './execution/runtime-program'
import { renderRuntimeAuthorityFailure, resolveRuntimeAuthority } from './execution/runtime-authority'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import { canonicalHashV1Result, type CanonicalJsonFailure } from './hash'
import { HttpServerLive } from './http'
import { Journal, JournalLive } from './ledger'
import { MarketData, MarketDataLive } from './market-data'
import { loadObserveRiskPolicy, makeObserveAutonomousCycleStartup } from './observe-composition'
import { sqlResource } from './operations'
import {
  discoverPaperCandidates as discoverExecutionCandidatesHistoricalCodec,
  renderExecutionCandidateDiscoveryError,
  type ExecutionCandidateDiscoveryReceipt,
} from './execution-candidate-discovery'
import { loadDefaultProtocol, type CausalProtocol } from './protocol'
import { makeStrategy, type Strategy } from './strategy'
import { currentUtcInstant } from './time'

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

export const ExecutionStoreResourceLive = (config: LoadedRuntimeConfig) => ExecutionStoreLive(config)

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

export const AutonomousApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPersistence = Layer.mergeAll(
    ExecutionStoreResourceLive(plan.config),
    IntentStoreLive,
    MutationStoreLive,
    LiveCapitalGrantStoreLive,
  ).pipe(Layer.provideMerge(writerFence), Layer.provideMerge(postgres), Layer.provideMerge(journal))
  return Layer.mergeAll(
    HttpServerLive(plan.config),
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
    BrokerSessionResourceLive(plan.config),
    executionPersistence,
    CycleStoreResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const ExecutionCandidateDiscoveryResourcesLive = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>) => {
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

const runtimeBroker = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  read: BrokerReadShape,
  mutationEnabled: boolean,
) => ({
  read,
  expectedAccountId: plan.config.alpaca.expectedAccountId,
  executionEligible: mutationEnabled,
  executionDisabledReason: mutationEnabled ? null : ('BROKER_ACCESS_READ_ONLY' as const),
})

const observeCycle = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    strategy: plan.strategy,
  })

const authorityError = (cause: Effect.Error<ReturnType<typeof resolveRuntimeAuthority>>) =>
  operationalError('config', 'execution-authority', renderRuntimeAuthorityFailure(cause), cause)

const executionProgramError = (
  cause: BrokerMutationError | Result.Result.Failure<ReturnType<typeof makeExecutionProgram>>,
) =>
  cause instanceof BrokerMutationError
    ? operationalError('config', 'broker-mutation', cause.message, cause)
    : operationalError('config', 'execution-program', 'execution program requires validated mutation authority', cause)

const runAutonomousService = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  Effect.gen(function* () {
    const { dependencies, session, liveCapitalGrants } = yield* Effect.all({
      dependencies: applicationDependencies,
      session: BrokerSession,
      liveCapitalGrants: LiveCapitalGrantStore,
    })
    const observedAt = yield* currentUtcInstant
    const authority = yield* resolveRuntimeAuthority(
      {
        policy: plan.config.execution,
        strategy: plan.strategy.provenance.strategy,
        observedAt,
      },
      { liveCapitalGrants },
    ).pipe(Effect.mapError(authorityError))

    if (authority.brokerAccess === BrokerAccess.ReadOnly) {
      return yield* runApplication(plan.config, plan.strategy, dependencies, {
        _tag: 'AutonomousRead',
        broker: runtimeBroker(plan, session.read, false),
        startCycle: observeCycle(plan),
      })
    }

    const executionDependencies = yield* Effect.all({
      intentStore: IntentStore,
      mutationStore: MutationStore,
      writerFence: WriterFence,
      brokerMutation: makeMutation(session, authority),
    })
    const executionProgram = yield* Effect.fromResult(
      makeExecutionProgram(authority, {
        brokerRead: session.read,
        liveCapitalGrants,
        currentUtcInstant,
        ...executionDependencies,
      }),
    ).pipe(Effect.mapError(executionProgramError))
    return yield* runApplication(plan.config, plan.strategy, dependencies, {
      _tag: 'AutonomousMutation',
      broker: runtimeBroker(plan, session.read, true),
      executionProgram,
      startCycle: observeCycle(plan),
    })
  })

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const writeDiscoveryReceipt = (receipt: ExecutionCandidateDiscoveryReceipt) =>
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

const executionCandidateIdentity = (
  plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>,
  riskPolicyHash: string,
) => ({
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

const discoverExecutionCandidate = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>, riskPolicyHash: string) =>
  discoverExecutionCandidatesHistoricalCodec(executionCandidateIdentity(plan, riskPolicyHash)).pipe(
    Effect.mapError((cause) =>
      operationalError(
        'strategy',
        'execution-candidate-discovery',
        renderExecutionCandidateDiscoveryError(cause),
        cause,
      ),
    ),
  )

const runExecutionCandidateDiscovery = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>) =>
  pipe(
    loadObserveRiskPolicy(plan.config.alpaca.expectedAccountId, plan.strategy.parameters.universe),
    Effect.mapError((cause) =>
      operationalError(
        'config',
        'execution-candidate-discovery',
        'source-controlled OBSERVE risk policy is invalid',
        cause,
      ),
    ),
    Effect.flatMap(policyHash),
    Effect.flatMap((riskPolicyHash) => discoverExecutionCandidate(plan, riskPolicyHash)),
    Effect.flatMap(writeDiscoveryReceipt),
  )

export const runApplicationPlan = pipe(
  Match.type<ApplicationPlan>(),
  Match.tag('BrokerlessService', (plan) =>
    runBrokerlessService(plan).pipe(Effect.provide(BrokerlessApplicationResourcesLive(plan))),
  ),
  Match.tag('AutonomousService', (plan) =>
    runAutonomousService(plan).pipe(Effect.provide(AutonomousApplicationResourcesLive(plan))),
  ),
  Match.tag('ExecutionCandidateDiscovery', (plan) =>
    runExecutionCandidateDiscovery(plan).pipe(Effect.provide(ExecutionCandidateDiscoveryResourcesLive(plan))),
  ),
  Match.exhaustive,
)

export const program = loadApplicationPlan.pipe(Effect.flatMap(runApplicationPlan), Effect.scoped)
