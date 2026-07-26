import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, flow, Layer, Match, pipe, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import { autonomousObserveApplication, brokerlessApplication } from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { BrokerRead, live as AlpacaReadLive, scopedReadAdapterLayer, type BrokerReadShape } from './broker/alpaca'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig, type LoadedRuntimeConfig } from './config'
import { makeRuntimeProvenance, makeStrategyProtocolHashResult, type ContractConstructionFailure } from './contracts'
import { CycleObservabilityLive } from './db/cycle-observability'
import { CycleStoreLive } from './db/cycle-store'
import { EvidenceStoreFromPostgres, PostgresClientLive } from './db/evidence-store'
import { PaperStoreLive } from './db/paper-store'
import { WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import { canonicalHashV1Result, type CanonicalJsonFailure } from './hash'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { loadObserveRiskPolicy, makeObserveAutonomousCycleStartup } from './observe-composition'
import { retrySqlLayer } from './operations'
import {
  discoverPaperCandidates,
  renderPaperCandidateDiscoveryError,
  type PaperCandidateDiscoveryReceipt,
} from './paper-candidate-discovery'
import { loadDefaultProtocol, type CausalProtocol } from './protocol'
import { makeStrategy, type Strategy } from './strategy'

type AlpacaBinding = NonNullable<LoadedRuntimeConfig['alpaca']>
type RuntimeMode = LoadedRuntimeConfig['runtimeMode']

type RuntimeIdentity<C extends LoadedRuntimeConfig = LoadedRuntimeConfig> = {
  readonly config: C
  readonly protocol: CausalProtocol
  readonly parameterHash: string
  readonly strategy: Strategy
  readonly strategyProtocolHash: string
}

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

type RuntimePlanFor<M extends RuntimeMode> = RuntimeIdentity<
  Extract<LoadedRuntimeConfig, { readonly runtimeMode: M }>
> & {
  readonly _tag: M
}

type RuntimePlan = { readonly [M in RuntimeMode]: RuntimePlanFor<M> }[RuntimeMode]

const mapLayerError = <A, E, R, E2>(layer: Layer.Layer<A, E, R>, map: (error: E) => E2): Layer.Layer<A, E2, R> =>
  Layer.unwrap(pipe(Layer.build(layer), Effect.mapError(map), Effect.map(Layer.succeedContext)))

type RuntimeSeed = {
  readonly config: LoadedRuntimeConfig
  readonly protocol: CausalProtocol
}

type ParameterizedRuntime = RuntimeSeed & { readonly parameterHash: string }
type ProvenanceRuntime = ParameterizedRuntime & {
  readonly provenance: ReturnType<typeof makeRuntimeProvenance>
}
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
    Result.try({
      try: () =>
        makeRuntimeProvenance({
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
      catch: (cause): RuntimeIdentityFailure => ({
        _tag: 'RuntimeProvenanceFailed',
        cause,
      }),
    }),
    Result.map((provenance) => ({ ...parameterized, provenance })),
  )

const addStrategy = (runtime: ProvenanceRuntime): StrategyRuntime => ({
  ...runtime,
  strategy: makeStrategy(runtime.protocol, runtime.provenance),
})

const addStrategyProtocolHash = (runtime: StrategyRuntime): Result.Result<RuntimeIdentity, RuntimeIdentityFailure> =>
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
  identity: RuntimeIdentity,
): Effect.Effect<RuntimeIdentity, ReturnType<typeof operationalError>> =>
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

const attachRuntimeMode = (identity: RuntimeIdentity): RuntimePlan =>
  pipe(
    Match.value(identity.config),
    Match.when({ runtimeMode: 'BrokerlessService' }, (config) => ({
      ...identity,
      _tag: 'BrokerlessService' as const,
      config,
    })),
    Match.when({ runtimeMode: 'AutonomousObserveService' }, (config) => ({
      ...identity,
      _tag: 'AutonomousObserveService' as const,
      config,
    })),
    Match.when({ runtimeMode: 'PaperCandidateDiscovery' }, (config) => ({
      ...identity,
      _tag: 'PaperCandidateDiscovery' as const,
      config,
    })),
    Match.exhaustive,
  )

const loadRuntimePlan = pipe(
  Effect.all({ config: loadConfig(), protocol: loadDefaultProtocol }),
  Effect.flatMap(flow(makeRuntimeIdentity, Effect.fromResult, Effect.mapError(runtimeIdentityError))),
  Effect.flatMap(verifyRuntimeIdentity),
  Effect.map(attachRuntimeMode),
)

const clickhouseLayer = (config: LoadedRuntimeConfig) =>
  retrySqlLayer(
    pipe(
      ClickhouseClient.layer({
        url: config.clickhouse.url,
        username: config.clickhouse.username,
        password: Redacted.value(config.clickhouse.password),
        database: 'signal',
        application: 'bayn',
        request_timeout: config.operationTimeoutMs,
      }),
      Layer.provide(NodeHttpClient.layerNodeHttp),
    ),
  )

const postgresClientLayer = (config: LoadedRuntimeConfig) =>
  retrySqlLayer(pipe(PostgresClientLive(config), Layer.provide(NodeServices.layer)))

const databaseLayer = (config: LoadedRuntimeConfig) =>
  retrySqlLayer(
    pipe(
      EvidenceStoreFromPostgres(config),
      Layer.provideMerge(pipe(PostgresClientLive(config), Layer.provide(NodeServices.layer))),
    ),
  )

const alpacaReadConfig = (config: LoadedRuntimeConfig, alpaca: AlpacaBinding) => ({
  expectedAccountId: alpaca.accountId,
  key: alpaca.key,
  secret: alpaca.secret,
  proxyUrl: alpaca.proxyUrl,
  operationTimeoutMs: config.operationTimeoutMs,
  retryAttempts: alpaca.retryAttempts,
})

const serviceBrokerReadLayer = (config: LoadedRuntimeConfig, alpaca: AlpacaBinding) =>
  mapLayerError(AlpacaReadLive(alpacaReadConfig(config, alpaca)), (cause) =>
    operationalError('config', 'alpaca', 'Alpaca paper account binding failed', cause),
  )

const discoveryBrokerReadLayer = (config: LoadedRuntimeConfig, alpaca: AlpacaBinding) =>
  mapLayerError(scopedReadAdapterLayer(alpacaReadConfig(config, alpaca)), (cause) =>
    operationalError('config', 'alpaca', 'Alpaca scoped read adapter construction failed', cause),
  )

const serviceCoreLayers = (plan: RuntimeIdentity) => {
  const database = databaseLayer(plan.config)
  const journal = JournalLive(plan.config)
  const marketData = pipe(MarketDataLive(plan.config, plan.protocol), Layer.provide(clickhouseLayer(plan.config)))
  const cycleObservability = pipe(CycleObservabilityLive, Layer.provide(database))
  return {
    database,
    journal,
    core: Layer.mergeAll(marketData, database, journal, cycleObservability),
  }
}

const runBrokerlessService = (plan: RuntimePlanFor<'BrokerlessService'>) =>
  pipe(brokerlessApplication(plan.config, plan.strategy), Effect.provide(serviceCoreLayers(plan).core))

const brokerServiceLayers = (plan: RuntimePlanFor<'AutonomousObserveService'>) => {
  const { database, journal, core } = serviceCoreLayers(plan)
  const storage = Layer.merge(database, journal)
  return Layer.mergeAll(
    core,
    serviceBrokerReadLayer(plan.config, plan.config.alpaca),
    pipe(PaperStoreLive(plan.config), Layer.provide(storage)),
    pipe(WriterFenceLive, Layer.provide(database)),
    pipe(CycleStoreLive, Layer.provide(database)),
  )
}

const observeBroker = (plan: RuntimePlanFor<'AutonomousObserveService'>, read: BrokerReadShape) => ({
  read,
  expectedAccountId: plan.config.alpaca.accountId,
  executionEligible: false,
  executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE' as const,
})

const observeCycle = (plan: RuntimePlanFor<'AutonomousObserveService'>) =>
  makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.accountId,
    authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
    maximumAuthority: plan.config.maximumAuthority,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    strategy: plan.strategy,
  })

const runAutonomousObserveService = (plan: RuntimePlanFor<'AutonomousObserveService'>) =>
  pipe(
    BrokerRead,
    Effect.flatMap((read) =>
      autonomousObserveApplication(plan.config, plan.strategy, observeBroker(plan, read), observeCycle(plan)),
    ),
    Effect.provide(brokerServiceLayers(plan)),
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

const discoveryLayers = (plan: RuntimePlanFor<'PaperCandidateDiscovery'>) => {
  const postgres = postgresClientLayer(plan.config)
  return Layer.mergeAll(
    postgres,
    pipe(CycleObservabilityLive, Layer.provide(postgres)),
    pipe(CycleStoreLive, Layer.provide(postgres)),
    discoveryBrokerReadLayer(plan.config, plan.config.alpaca),
  )
}

const paperCandidateIdentity = (plan: RuntimePlanFor<'PaperCandidateDiscovery'>, riskPolicyHash: string) => ({
  sourceRevision: plan.config.build.sourceRevision,
  image: {
    repository: plan.config.build.imageRepository,
    digest: plan.config.build.imageDigest,
  },
  strategy: plan.strategy.provenance.strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  qualificationRunId: plan.config.qualificationRunId,
  accountId: plan.config.alpaca.accountId,
  authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  policyHash: riskPolicyHash,
})

const discoverPaperCandidate = (plan: RuntimePlanFor<'PaperCandidateDiscovery'>, riskPolicyHash: string) =>
  pipe(
    discoverPaperCandidates(paperCandidateIdentity(plan, riskPolicyHash)),
    Effect.mapError((cause) =>
      operationalError('strategy', 'paper-candidate-discovery', renderPaperCandidateDiscoveryError(cause), cause),
    ),
    Effect.provide(discoveryLayers(plan)),
  )

const runPaperCandidateDiscovery = (plan: RuntimePlanFor<'PaperCandidateDiscovery'>) =>
  pipe(
    loadObserveRiskPolicy(plan.config.alpaca.accountId, plan.strategy.parameters.universe),
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

const interpretRuntimePlan = pipe(
  Match.type<RuntimePlan>(),
  Match.tag('BrokerlessService', runBrokerlessService),
  Match.tag('AutonomousObserveService', runAutonomousObserveService),
  Match.tag('PaperCandidateDiscovery', runPaperCandidateDiscovery),
  Match.exhaustive,
)

export const program = pipe(loadRuntimePlan, Effect.flatMap(interpretRuntimePlan), Effect.scoped)
