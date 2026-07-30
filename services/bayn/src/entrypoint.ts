import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Context, Effect, flow, Layer, Match, pipe, Redacted, Result, Schema, Stdio, Stream } from 'effect'
import { Headers, HttpClient, HttpClientRequest } from 'effect/unstable/http'

import {
  makeApplicationPlan,
  runApplication,
  type ApplicationDependencies,
  type ApplicationIdentity,
  type ApplicationPlan,
  type ApplicationPlanFor,
} from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import {
  BrokerSession,
  alpacaHttpLayer,
  live as AlpacaBrokerLive,
  type BrokerConnection,
  type BrokerReadShape,
} from './broker/alpaca'
import { redactedHeaders } from './broker/alpaca/model'
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
import { makeExecutionProgram, type ExecutionProgram } from './execution/runtime-program'
import { renderRuntimeAuthorityFailure, resolveRuntimeAuthority } from './execution/runtime-authority'
import type { FreshBrokerQuote } from './execution/mutation-authority'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { OperationalError, operationalError } from './errors'
import { canonicalHashV1Result, type CanonicalJsonFailure } from './hash'
import { HttpServerLive } from './http'
import { Journal, JournalLive } from './ledger'
import { MarketData, MarketDataLive } from './market-data'
import {
  loadObserveRiskPolicy,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
} from './observe-composition'
import { sqlResource } from './operations'
import {
  discoverPaperCandidates as discoverExecutionCandidatesHistoricalCodec,
  renderExecutionCandidateDiscoveryError,
  type ExecutionCandidateDiscoveryReceipt,
} from './execution-candidate-discovery'
import {
  authenticateValidatedExecutionPrepare,
  ExecutionPrepareStoreLive,
  prepareValidatedExecution,
  renderExecutionPrepareFailure,
  validateExecutionPrepareInput,
  type ExecutionPrepareFailure,
  type ExecutionPrepareReceipt,
  type PrevalidatedExecutionPrepareInput,
} from './execution-prepare'
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

export const ExecutionPrepareResourcesLive = (plan: ApplicationPlanFor<'ExecutionPrepare'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPrepareStore = ExecutionPrepareStoreLive(plan.config).pipe(Layer.provide(postgres))
  return Layer.mergeAll(
    postgres,
    writerFence,
    executionPrepareStore,
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

const LatestQuoteResponseSchema = Schema.Struct({
  symbol: Schema.String,
  quote: Schema.Struct({
    ap: Schema.Finite,
    bp: Schema.Finite,
    t: Schema.String,
  }),
})

export type LatestQuoteDecodeFailure =
  | { readonly _tag: 'LatestQuoteResponseInvalid'; readonly cause: unknown }
  | { readonly _tag: 'LatestQuoteSymbolMismatch'; readonly expected: string; readonly observed: string }
  | { readonly _tag: 'LatestQuoteAskInvalid'; readonly symbol: string; readonly ask: number }
  | { readonly _tag: 'LatestQuoteBidInvalid'; readonly symbol: string; readonly bid: number }
  | { readonly _tag: 'LatestQuoteSpreadInvalid'; readonly symbol: string; readonly bid: number; readonly ask: number }

export const decodeFreshBrokerPrice = (
  requestedSymbol: string,
  raw: unknown,
  observedAt: string,
): Result.Result<FreshBrokerQuote, LatestQuoteDecodeFailure> => {
  const decoded = Schema.decodeUnknownResult(LatestQuoteResponseSchema, { onExcessProperty: 'ignore' })(raw)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'LatestQuoteResponseInvalid', cause: decoded.failure })
  }
  if (decoded.success.symbol !== requestedSymbol) {
    return Result.fail({
      _tag: 'LatestQuoteSymbolMismatch',
      expected: requestedSymbol,
      observed: decoded.success.symbol,
    })
  }
  const bidMicros = Math.floor(decoded.success.quote.bp * 1_000_000)
  const askMicros = Math.ceil(decoded.success.quote.ap * 1_000_000)
  if (!Number.isFinite(decoded.success.quote.bp) || decoded.success.quote.bp <= 0 || !Number.isSafeInteger(bidMicros)) {
    return Result.fail({
      _tag: 'LatestQuoteBidInvalid',
      symbol: requestedSymbol,
      bid: decoded.success.quote.bp,
    })
  }
  if (!Number.isFinite(decoded.success.quote.ap) || decoded.success.quote.ap <= 0 || !Number.isSafeInteger(askMicros)) {
    return Result.fail({
      _tag: 'LatestQuoteAskInvalid',
      symbol: requestedSymbol,
      ask: decoded.success.quote.ap,
    })
  }
  if (bidMicros > askMicros) {
    return Result.fail({
      _tag: 'LatestQuoteSpreadInvalid',
      symbol: requestedSymbol,
      bid: decoded.success.quote.bp,
      ask: decoded.success.quote.ap,
    })
  }
  return Result.succeed({
    symbol: requestedSymbol,
    bidPriceMicros: bidMicros.toString(),
    askPriceMicros: askMicros.toString(),
    quotedAt: decoded.success.quote.t,
    observedAt,
  })
}

export const latestQuoteUrl = (symbol: string): URL => {
  const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`, 'https://data.alpaca.markets')
  url.searchParams.set('feed', 'sip')
  return url
}

export const makeFreshBrokerPriceReader = (
  connection: BrokerConnection,
  client: HttpClient.HttpClient,
): ((symbol: string) => Effect.Effect<FreshBrokerQuote, ReturnType<typeof operationalError>>) => {
  const authenticated = client.pipe(HttpClient.retryTransient({ times: connection.retryAttempts }))
  const key = Redacted.value(connection.key)
  const secret = Redacted.value(connection.secret)
  return (symbol) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(latestQuoteUrl(symbol), {
        acceptJson: true,
        headers: {
          'APCA-API-KEY-ID': key,
          'APCA-API-SECRET-KEY': secret,
        },
      })
      const response = yield* authenticated
        .execute(request)
        .pipe(
          Effect.mapError((cause) =>
            operationalError('http', 'alpaca-latest-quote', 'Alpaca latest quote request failed', cause),
          ),
        )
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          operationalError(
            'http',
            'alpaca-latest-quote',
            `Alpaca latest quote returned HTTP ${response.status.toString()}`,
          ),
        )
      }
      const raw = yield* response.json.pipe(
        Effect.mapError((cause) =>
          operationalError('http', 'alpaca-latest-quote', 'Alpaca latest quote body is not valid JSON', cause),
        ),
      )
      const observedAt = yield* currentUtcInstant
      return yield* Effect.fromResult(decodeFreshBrokerPrice(symbol, raw, observedAt)).pipe(
        Effect.mapError((cause) =>
          operationalError('http', 'alpaca-latest-quote', 'Alpaca latest quote violates the price contract', cause),
        ),
      )
    }).pipe(
      Effect.timeoutOrElse({
        duration: connection.operationTimeoutMs,
        orElse: () =>
          Effect.fail(
            operationalError(
              'http',
              'alpaca-latest-quote',
              `Alpaca latest quote timed out after ${connection.operationTimeoutMs.toString()}ms`,
            ),
          ),
      }),
      Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
      Effect.withSpan('broker.latest-quote', {
        attributes: { 'broker.system': 'alpaca', 'broker.symbol': symbol },
      }),
    )
}

const observeCycle = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    strategy: plan.strategy,
  })

const mutationCycle = (plan: ApplicationPlanFor<'AutonomousService'>, executionProgram: ExecutionProgram) =>
  makeMutationAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    strategy: plan.strategy,
    executionProgram,
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

    const alpacaHttpContext = yield* Layer.build(alpacaHttpLayer(session.connection)).pipe(
      Effect.mapError((cause) =>
        operationalError('http', 'alpaca-client', 'Alpaca proxy-backed HTTP client acquisition failed', cause),
      ),
    )
    const alpacaHttpClient = Context.get(alpacaHttpContext, HttpClient.HttpClient)
    const executionDependencies = yield* Effect.all({
      intentStore: IntentStore,
      mutationStore: MutationStore,
      writerFence: WriterFence,
      brokerMutation: makeMutation(session, authority, alpacaHttpClient),
    })
    const executionProgram = yield* Effect.fromResult(
      makeExecutionProgram(authority, {
        brokerRead: session.read,
        liveCapitalGrants,
        freshBrokerPrice: makeFreshBrokerPriceReader(session.connection, alpacaHttpClient),
        currentUtcInstant,
        ...executionDependencies,
      }),
    ).pipe(Effect.mapError(executionProgramError))
    return yield* runApplication(plan.config, plan.strategy, dependencies, {
      _tag: 'AutonomousMutation',
      broker: runtimeBroker(plan, session.read, true),
      executionProgram,
      startCycle: mutationCycle(plan, executionProgram),
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

const writeExecutionPrepareReceipt = (receipt: ExecutionPrepareReceipt) =>
  pipe(
    encodeJson(receipt),
    Effect.mapError((cause) =>
      operationalError('strategy', 'execution-prepare-output', 'EXECUTION_PREPARE receipt encoding failed', cause),
    ),
    Effect.flatMap((output) =>
      pipe(
        Stdio.Stdio,
        Effect.flatMap((stdio) => Stream.run(Stream.make(`${output}\n`), stdio.stdout())),
      ),
    ),
  )

const policyHash = (
  policy: unknown,
  operation: 'paper-candidate-policy' | 'execution-prepare-policy',
): Effect.Effect<string, ReturnType<typeof operationalError>> =>
  pipe(
    canonicalHashV1Result(policy),
    Result.mapError((cause) =>
      operationalError('strategy', operation, 'source-controlled OBSERVE risk policy content hashing failed', cause),
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
    Effect.flatMap((policy) => policyHash(policy, 'paper-candidate-policy')),
    Effect.flatMap((riskPolicyHash) => discoverExecutionCandidate(plan, riskPolicyHash)),
    Effect.flatMap(writeDiscoveryReceipt),
  )

const executionPrepareRuntimeBinding = (plan: ApplicationPlanFor<'ExecutionPrepare'>, riskPolicyHash: string) => ({
  sourceRevision: plan.config.build.sourceRevision,
  imageRepository: plan.config.build.imageRepository,
  imageDigest: plan.config.build.imageDigest,
  strategy: plan.strategy.provenance.strategy,
  strategyProtocolHash: plan.strategyProtocolHash,
  qualificationRunId: plan.config.qualificationRunId,
  accountId: plan.config.alpaca.expectedAccountId,
  brokerIdentityHash: plan.config.alpaca.identity.identityHash,
  brokerProvider: plan.config.alpaca.identity.provider,
  brokerEnvironment: plan.config.alpaca.identity.environment,
  brokerAccess: plan.config.execution.brokerAccess,
  capitalAuthority: plan.config.execution.capitalAuthority._tag,
  authorityGenerationHash: plan.config.alpaca.authorityGenerationHash,
  riskPolicyHash,
})

const executionPrepareCandidateIdentity = (plan: ApplicationPlanFor<'ExecutionPrepare'>, riskPolicyHash: string) => ({
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

const executionPrepareOperationalCause = (cause: ExecutionPrepareFailure) => {
  if (cause._tag !== 'ExecutionPrepareStoreRejected') return { _tag: cause._tag }
  const nested = cause.cause.cause
  return {
    _tag: cause._tag,
    operation: cause.operation,
    failure: cause.failure,
    nested:
      typeof nested === 'object' && nested !== null && '_tag' in nested && typeof nested._tag === 'string'
        ? nested._tag
        : null,
  }
}

const executionPrepareOperationalError = (cause: ExecutionPrepareFailure) =>
  new OperationalError({
    component: 'strategy',
    operation: 'execution-prepare',
    message: renderExecutionPrepareFailure(cause),
    retryable: false,
    cause: executionPrepareOperationalCause(cause),
  })

export const validateExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  Effect.gen(function* () {
    const riskPolicy = yield* loadObserveRiskPolicy(
      plan.config.alpaca.expectedAccountId,
      plan.strategy.parameters.universe,
    ).pipe(
      Effect.mapError((cause) =>
        operationalError('config', 'execution-prepare', 'source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-prepare-policy')
    return yield* Effect.fromResult(
      validateExecutionPrepareInput(
        plan.config.executionPrepareRequest,
        executionPrepareRuntimeBinding(plan, riskPolicyHash),
      ),
    ).pipe(Effect.mapError(executionPrepareOperationalError))
  })

const runExecutionPrepare = (
  plan: ApplicationPlanFor<'ExecutionPrepare'>,
  prevalidated: PrevalidatedExecutionPrepareInput,
) =>
  Effect.gen(function* () {
    yield* BrokerSession
    const trustedReceipt = yield* discoverExecutionCandidatesHistoricalCodec(
      executionPrepareCandidateIdentity(plan, prevalidated.runtime.riskPolicyHash),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OperationalError({
            component: 'strategy',
            operation: 'execution-prepare-discovery',
            message: renderExecutionCandidateDiscoveryError(cause),
            retryable: false,
            cause: { _tag: cause._tag },
          }),
      ),
    )
    const validated = yield* authenticateValidatedExecutionPrepare(prevalidated, trustedReceipt).pipe(
      Effect.mapError(executionPrepareOperationalError),
    )
    const receipt = yield* prepareValidatedExecution(validated).pipe(Effect.mapError(executionPrepareOperationalError))
    yield* writeExecutionPrepareReceipt(receipt)
  })

export const executionPrepareBoundaryError = (cause: unknown): OperationalError =>
  cause instanceof OperationalError
    ? cause
    : new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare-resource',
        message: 'EXECUTION_PREPARE resource acquisition failed closed',
        retryable: false,
        cause:
          typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string'
            ? { _tag: cause._tag }
            : { _tag: 'UnknownResourceFailure' },
      })

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
  Match.tag('ExecutionPrepare', (plan) =>
    validateExecutionPreparePlan(plan).pipe(
      Effect.flatMap((validated) =>
        runExecutionPrepare(plan, validated).pipe(Effect.provide(ExecutionPrepareResourcesLive(plan))),
      ),
      Effect.mapError(executionPrepareBoundaryError),
    ),
  ),
  Match.exhaustive,
)

export const program = loadApplicationPlan.pipe(Effect.flatMap(runApplicationPlan), Effect.scoped)
