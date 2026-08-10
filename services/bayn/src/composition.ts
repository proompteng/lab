import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import {
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  pipe,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stdio,
  Stream,
} from 'effect'

import {
  makeApplicationPlan,
  runApplication,
  type ApplicationDependencies,
  type ApplicationIdentity,
  type ApplicationPlan,
  type ApplicationPlanFor,
  type AutonomousCycleStartupInput,
  type AutonomousRuntime,
  type AutonomousRuntimeResolver,
} from './app'
import { AlpacaBrokerResourcesLive } from './broker/alpaca/composition'
import {
  BrokerRead,
  BrokerSession,
  type BrokerReadShape,
  type BrokerSessionShape,
  type ReadPreflight,
} from './broker/alpaca'
import { AlpacaHttpClient, makeFreshBrokerPriceReader } from './broker/alpaca/http'
import { BrokerMutationError, makeMutation } from './broker/alpaca-mutations'
import { BrokerEnvironment } from './broker/identity'
import type { LoadedRuntimeConfig } from './config'
import { CycleObservability, CycleObservabilityLive } from './db/cycle-observability'
import { CycleStore, CycleStoreLive } from './db/cycle-store'
import {
  ForwardPerformanceReceiptStore,
  type ForwardPerformanceReceiptStoreShape,
  makeForwardPerformanceReceiptEnvelope,
} from './db/forward-performance-receipt'
import { ForwardPerformanceReceiptStoreLive } from './db/forward-performance-receipt-postgres'
import { PaperCycleClosureStore, type PaperCycleClosureStoreShape } from './db/paper-cycle-closure'
import { PaperCycleClosureStoreLive as PaperCycleClosureStorePostgresLive } from './db/paper-cycle-closure-postgres'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from './db/evidence-store'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  CapitalGrantLifecycleStore,
  ExecutionStoreLive,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type CapitalGrantLifecycleStoreShape,
} from './db/execution-store'
import { LiveCapitalGrantStore, LiveCapitalGrantStoreLive } from './db/live-capital-grant'
import { BrokerAccess, CapitalAuthorityKind, noCapitalAuthority } from './execution/authority'
import {
  Authority,
  KillState,
  type AuthorityState,
  type CapitalGrantGeneration,
  type ResearchCapitalGrantGeneration,
} from './execution/contracts'
import {
  CapitalAuthoritySelection,
  decodePaperActivationConfigurationResult,
  isResearchPaperActivationRequest,
  isResearchPaperBuildContinuation,
  researchCapitalGrantProof,
  researchPaperBuildContinuationIsBound,
  researchPaperGenerationIsBoundToRequest,
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type PaperActivationRequest,
  type QualifiedPaperActivationRequest,
  type ResearchPaperActivationRequest,
  type ResearchPaperBuildContinuation,
} from './execution/configuration'
import { IntentStore, IntentStoreLive } from './execution/intents'
import { MutationStore, MutationStoreLive } from './execution/mutations'
import { makeExecutionProgram, type ExecutionProgram } from './execution/runtime-program'
import { resolvePreparedSandboxAuthority } from './execution/runtime-authority'
import { WriterFence, WriterFenceLive, type WriterFenceService } from './execution/writer-fence'
import { operationalError, OperationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { runForwardPerformance } from './forward-performance'
import { HttpServerLive } from './http'
import { Journal, JournalLive } from './ledger'
import { MarketData, MarketDataLive } from './market-data'
import {
  decidePaperEpisodeAuthority,
  paperGrantFromGeneration,
  paperGrantKey,
  validatePaperEpisodeCloseWindow,
} from './paper-episode'
import {
  loadObserveRiskPolicy,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  paperEpisodeCloseExpiresAt,
  paperEpisodeReceiptFinalizationExpiresAt,
} from './observe-composition'
import { restrictMutationAuthority } from './observe-composition/mutation-interpreter'
import { sqlResource } from './operations'
import { runOnce, type ReconciliationPassError } from './reconciler'
import {
  discoverPaperCandidates as discoverExecutionCandidatesHistoricalCodec,
  renderExecutionCandidateDiscoveryError,
  type ExecutionCandidateDiscoveryReceipt,
} from './execution-candidate-discovery'
import {
  authenticateValidatedExecutionPrepare,
  buildExecutionPrepareProofPlanRequest,
  ExecutionPrepareStoreLive,
  prepareValidatedExecutionWithGeneration,
  renderExecutionPrepareFailure,
  validateExecutionPrepareInput,
  type ExecutionPrepareFailure,
  type ExecutionPrepareRequest,
  type ExecutionPrepareOutput,
  type ExecutionPrepareRuntimeBinding,
  type PrevalidatedExecutionPrepareInput,
} from './execution-prepare'
import { currentUtcInstant } from './time'
import type { RuntimeEvidence, RuntimeState } from './runtime-state'
import { scopedAcquisition } from './resource-boundary'
import { strategyApplication } from './strategy'
import { Pipeable } from './pipeable'

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
  AlpacaBrokerResourcesLive(config.alpaca)

export const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const HttpApplicationPlatformLive = (config: LoadedRuntimeConfig) =>
  Layer.merge(HttpServerLive(config), ApplicationPlatformLive)

const SignalMarketDataLive = (plan: ApplicationIdentity) => {
  const clickHouse = sqlResource(ClickHouseClientResourceLive(plan.config))
  return MarketDataResourceLive(plan).pipe(Layer.provide(clickHouse))
}

const PostgresAuthorityLive = (config: LoadedRuntimeConfig) =>
  sqlResource(EvidenceStoreResourceLive(config).pipe(Layer.provideMerge(PostgresClientResourceLive(config))))

export const BrokerlessApplicationResourcesLive = (plan: ApplicationPlanFor<'BrokerlessService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    JournalResourceLive(plan.config),
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousRuntimeResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const journal = JournalResourceLive(plan.config)
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPersistence = Layer.mergeAll(
    ExecutionStoreResourceLive(plan.config),
    IntentStoreLive,
    MutationStoreLive,
    LiveCapitalGrantStoreLive,
    PaperCycleClosureStorePostgresLive,
    ForwardPerformanceReceiptStoreLive,
  ).pipe(Layer.provideMerge(writerFence), Layer.provideMerge(postgres), Layer.provideMerge(journal))
  return Layer.mergeAll(
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

export const ExecutionPrepareValidationResourcesLive = (plan: ApplicationPlanFor<'ExecutionPrepare'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const evidenceStore = EvidenceStoreResourceLive(plan.config).pipe(Layer.provide(postgres))
  return Layer.mergeAll(postgres, evidenceStore).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const ExecutionPrepareExecutionResourcesLive = (plan: ApplicationPlanFor<'ExecutionPrepare'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPrepareStore = ExecutionPrepareStoreLive(plan.config).pipe(
    Layer.provide(writerFence),
    Layer.provide(postgres),
  )
  return Layer.mergeAll(postgres, writerFence, executionPrepareStore, BrokerSessionResourceLive(plan.config)).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )
}

// Kept for the existing entrypoint export; validation uses the separate layer above.
export const ExecutionPrepareResourcesLive = ExecutionPrepareExecutionResourcesLive

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
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
    strategy: plan.strategy,
  })

const mutationCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  executionProgram: ExecutionProgram,
  paperEpisode: PaperActivationRequest,
  paperCycleClosureStore: PaperCycleClosureStoreShape,
  onClosedCycle: (cycleId: string, observedAt: string) => Effect.Effect<void>,
) =>
  makeMutationAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash:
      plan.config.execution.capitalAuthority._tag === CapitalAuthorityKind.Sandbox
        ? plan.config.execution.capitalAuthority.authorityGenerationHash
        : plan.config.alpaca.authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
    strategy: plan.strategy,
    ...(isResearchPaperActivationRequest(paperEpisode) ? { cycleCadence: 'PAPER_BOOTSTRAP' as const } : {}),
    executionProgram,
    paperCycleClosureStore,
    onClosedCycle,
    paperEpisodeCutoffAt: paperEpisode.cutoffAt,
    paperEpisodeCloseSubmitCutoffAt: paperEpisode.expiresAt,
    paperEpisodeExpiresAt: paperEpisodeCloseExpiresAt(paperEpisode.expiresAt),
  })

const executionProgramError = (
  cause: BrokerMutationError | Schema.SchemaError | Result.Result.Failure<ReturnType<typeof makeExecutionProgram>>,
) =>
  cause instanceof BrokerMutationError
    ? operationalError({ component: 'config', operation: 'broker-mutation', message: cause.message, cause })
    : operationalError({
        component: 'config',
        operation: 'execution-program',
        message: 'execution program requires validated mutation authority and risk policy',
        cause,
      })

type ReadOnlyExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.ReadOnly }>

const paperActivationOperationalError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'paper-activation-prepare',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'PaperActivationPreparationRejected' } : cause,
  })

interface ConfiguredPaperActivation {
  readonly request: PaperActivationRequest
  readonly buildContinuation: ResearchPaperBuildContinuation | null
}

const decodeConfiguredPaperActivation = (serialized: string): Result.Result<ConfiguredPaperActivation, string> => {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return Result.fail('configured PAPER activation is not valid JSON')
  }
  const decoded = decodePaperActivationConfigurationResult(value)
  return Result.isFailure(decoded)
    ? Result.fail('configured PAPER activation failed its canonical schema and hash validation')
    : isResearchPaperBuildContinuation(decoded.success)
      ? Result.succeed({ request: decoded.success.request, buildContinuation: decoded.success })
      : Result.succeed({ request: decoded.success, buildContinuation: null })
}

const readOnlyExecutionPolicy = (plan: ApplicationPlanFor<'AutonomousService'>): ReadOnlyExecutionPolicy => ({
  brokerIdentity: plan.config.alpaca.identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
})

const paperActivationRequestIsCurrent = (
  request: PaperActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence | null,
  observedAt: string,
  options: {
    readonly allowCloseRecovery?: boolean
    readonly buildContinuation?: ResearchPaperBuildContinuation | null
  } = {},
): Result.Result<void, string> => {
  if (options.allowCloseRecovery !== true && (request.expiresAt <= observedAt || request.cutoffAt <= observedAt)) {
    return Result.fail('paper activation request is expired or past its immutable cutoff')
  }
  if (request.strategy.protocolHash !== plan.strategyProtocolHash) {
    return Result.fail('paper activation request strategy protocol does not match the current strategy')
  }
  const strategy = plan.strategy.provenance.strategy
  if (
    request.strategy.name !== strategy.name ||
    request.strategy.behaviorHash !== strategy.behaviorHash ||
    request.strategy.parameterHash !== strategy.parameterHash ||
    request.strategy.parameterSchemaVersion !== strategy.parameterSchemaVersion
  ) {
    return Result.fail('paper activation request strategy identity does not match the current strategy')
  }
  const requestBuildIsCurrent =
    request.activation.sourceRevision === plan.config.build.sourceRevision &&
    request.activation.imageRepository === plan.config.build.imageRepository &&
    request.activation.imageDigest === plan.config.build.imageDigest
  const continuationBuildIsCurrent =
    isResearchPaperActivationRequest(request) &&
    options.buildContinuation !== null &&
    options.buildContinuation !== undefined &&
    options.buildContinuation.request.requestHash === request.requestHash &&
    options.buildContinuation.activation.sourceRevision === plan.config.build.sourceRevision &&
    options.buildContinuation.activation.imageRepository === plan.config.build.imageRepository &&
    options.buildContinuation.activation.imageDigest === plan.config.build.imageDigest
  if (!requestBuildIsCurrent && !continuationBuildIsCurrent) {
    return Result.fail('paper activation request is not bound to the current activation build')
  }
  if (isResearchPaperActivationRequest(request)) {
    if (
      request.broker.environment !== BrokerEnvironment.Sandbox ||
      request.broker.accountId !== plan.config.alpaca.expectedAccountId ||
      request.broker.identityHash !== plan.config.alpaca.identity.identityHash
    ) {
      return Result.fail('research PAPER request broker identity does not match the configured sandbox account')
    }
    return Result.succeed(undefined)
  }
  if (evidence === null) return Result.fail('pinned qualification evidence was not published by startup')
  if (
    evidence.evaluation.runId !== request.qualification.runId ||
    evidence.qualification.runId !== request.qualification.runId ||
    evidence.qualification.lockId !== request.qualification.lockId ||
    evidence.qualification.resultHash !== request.qualification.resultHash
  ) {
    return Result.fail('paper activation request does not match the recovered qualification result')
  }
  if (evidence.qualification.verdict !== 'QUALIFIED' || evidence.qualification.evaluationVerdict.status !== 'PASS') {
    return Result.fail('paper activation request requires a qualified economic result')
  }
  if (
    evidence.provenance.sourceRevision !== request.qualification.sourceRevision ||
    evidence.provenance.image.repository !== request.qualification.imageRepository ||
    evidence.provenance.image.digest !== request.qualification.imageDigest
  ) {
    return Result.fail('paper activation request does not match the durable qualification provenance')
  }
  return Result.succeed(undefined)
}

const internalExecutionPlan = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  mode: 'ExecutionCandidateDiscovery' | 'ExecutionPrepare',
  request: QualifiedPaperActivationRequest,
  execution: ReadOnlyExecutionPolicy,
  executionPrepareRequest?: ExecutionPrepareRequest,
) => {
  const config = {
    ...plan.config,
    runtimeMode: mode,
    qualificationRunId: request.qualification.runId,
    execution,
    ...(executionPrepareRequest === undefined ? {} : { executionPrepareRequest }),
  } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: typeof mode }>
  return makeApplicationPlan({
    config,
    protocol: plan.protocol,
    parameterHash: plan.parameterHash,
    strategy: plan.strategy,
    strategyProtocolHash: plan.strategyProtocolHash,
  }) as ApplicationPlan
}

const buildPaperActivationPrepareRequest = (
  request: QualifiedPaperActivationRequest,
  evidence: RuntimeEvidence,
  discoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Result.Result<ExecutionPrepareRequest, string> => {
  if (evidence.qualification.analysis.candidateOrdinal < 0) {
    return Result.fail('recovered qualification candidate ordinal is invalid')
  }
  return Result.succeed({
    schemaVersion: 'bayn.execution-prepare-request.v1',
    qualification: {
      runId: request.qualification.runId,
      lockId: request.qualification.lockId,
      resultHash: request.qualification.resultHash,
      verdict: 'QUALIFIED',
      sourceRevision: request.qualification.sourceRevision,
      imageRepository: request.qualification.imageRepository,
      imageDigest: request.qualification.imageDigest,
      candidateOrdinal: evidence.qualification.analysis.candidateOrdinal,
    },
    discoveryReceipt,
  })
}

const paperGenerationIsBoundToRequest = (
  request: QualifiedPaperActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  generation: CapitalGrantGeneration,
): Result.Result<void, string> => {
  if (generation.maximum !== 'PAPER') return Result.fail('execution PREPARE did not return PAPER generation')
  if (generation.previousGenerationHash !== plan.config.alpaca.authorityGenerationHash) {
    return Result.fail('execution PREPARE did not chain from the configured OBSERVE generation')
  }
  if (
    generation.qualificationRunId !== request.qualification.runId ||
    generation.qualificationLockId !== request.qualification.lockId ||
    generation.qualificationResultHash !== request.qualification.resultHash ||
    generation.qualificationSourceRevision !== request.qualification.sourceRevision ||
    generation.qualificationImageRepository !== request.qualification.imageRepository ||
    generation.qualificationImageDigest !== request.qualification.imageDigest
  ) {
    return Result.fail('prepared generation is not bound to the requested qualification')
  }
  if (
    generation.activationSourceRevision !== request.activation.sourceRevision ||
    generation.activationImageRepository !== request.activation.imageRepository ||
    generation.activationImageDigest !== request.activation.imageDigest ||
    generation.strategyName !== request.strategy.name ||
    generation.strategyBehaviorHash !== request.strategy.behaviorHash ||
    generation.strategyParameterHash !== request.strategy.parameterHash ||
    generation.strategyParameterSchemaVersion !== request.strategy.parameterSchemaVersion ||
    generation.protocolHash !== request.strategy.protocolHash
  ) {
    return Result.fail('prepared generation is not bound to the requested current strategy and build')
  }
  return Result.succeed(undefined)
}

type PaperAuthorityGeneration = CapitalGrantGeneration | ResearchCapitalGrantGeneration

const preparedPaperActivationIsBound = (
  request: QualifiedPaperActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  prepared: ExecutionPrepareOutput,
): Result.Result<void, string> => {
  const { generation, preflight } = prepared
  const binding = paperGenerationIsBoundToRequest(request, plan, generation)
  if (Result.isFailure(binding)) return binding
  if (preflight.environment !== BrokerEnvironment.Sandbox) return Result.fail('paper PREPARE broker is not sandbox')
  if (preflight.accountId !== plan.config.alpaca.expectedAccountId) {
    return Result.fail('paper PREPARE broker account does not match the configured account')
  }
  if (
    preflight.openOrderCount !== request.limits.maxOpenOrders ||
    preflight.positionCount !== request.limits.maxPositions
  ) {
    return Result.fail('paper PREPARE broker preflight is not an empty order book and position set')
  }
  return Result.succeed(undefined)
}

const readBoundPaperActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: PaperActivationRequest,
  buildContinuation: ResearchPaperBuildContinuation | null,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<PaperAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    if (authorityStore.readAuthorityState === undefined) {
      return yield* paperActivationOperationalError(
        'durable PAPER recovery requires authority history read capabilities',
      )
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => paperActivationOperationalError('durable PAPER authority read failed', cause)),
    )
    if (authority.maximum !== Authority.Paper) {
      return yield* paperActivationOperationalError('durable PAPER recovery requires PAPER maximum authority')
    }
    const closeAuthorityIsBound =
      (authority.effective === Authority.Paper && authority.kill === KillState.Clear) ||
      (authority.effective === Authority.Observe && authority.kill === KillState.Active)
    if (!closeAuthorityIsBound) {
      return yield* paperActivationOperationalError(
        'durable PAPER recovery requires clear PAPER or active OBSERVE close authority',
      )
    }
    if (isResearchPaperActivationRequest(request)) {
      if (authorityStore.readResearchAuthorityGeneration === undefined) {
        return yield* paperActivationOperationalError(
          'durable research PAPER recovery requires v3 authority history reads',
        )
      }
      const generation = yield* authorityStore
        .readResearchAuthorityGeneration(authority.generationHash)
        .pipe(
          Effect.mapError((cause) => paperActivationOperationalError('durable PAPER generation read failed', cause)),
        )
      if (generation === undefined) {
        return yield* paperActivationOperationalError('durable research PAPER history is missing')
      }
      const binding =
        buildContinuation === null
          ? researchPaperGenerationIsBoundToRequest(request, plan.config.alpaca.authorityGenerationHash, generation)
          : researchPaperBuildContinuationIsBound(
              buildContinuation,
              plan.config.alpaca.authorityGenerationHash,
              generation,
              plan.config.build,
            )
      yield* Effect.fromResult(binding).pipe(Effect.mapError((message) => paperActivationOperationalError(message)))
      return generation
    }
    if (authorityStore.readAuthorityGeneration === undefined) {
      return yield* paperActivationOperationalError(
        'durable qualified PAPER recovery requires v2 authority history reads',
      )
    }
    const generation = yield* authorityStore
      .readAuthorityGeneration(authority.generationHash)
      .pipe(Effect.mapError((cause) => paperActivationOperationalError('durable PAPER generation read failed', cause)))
    if (generation === undefined) {
      return yield* paperActivationOperationalError('durable qualified PAPER history is missing')
    }
    yield* Effect.fromResult(paperGenerationIsBoundToRequest(request, plan, generation)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    return generation
  })

const recoverPaperActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: PaperActivationRequest,
  buildContinuation: ResearchPaperBuildContinuation | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<PaperAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(
      paperActivationRequestIsCurrent(request, plan, evidence, observedAt, {
        allowCloseRecovery: true,
        buildContinuation,
      }),
    ).pipe(Effect.mapError((message) => paperActivationOperationalError(message)))
    const closeExpiresAt = paperEpisodeCloseExpiresAt(request.expiresAt)
    if (observedAt >= closeExpiresAt) {
      yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence)
      return yield* paperActivationOperationalError('durable PAPER close recovery is outside its immutable close lease')
    }
    if (observedAt < request.cutoffAt) {
      return yield* paperActivationOperationalError('durable PAPER close recovery is outside its immutable close lease')
    }
    return yield* readBoundPaperActivationGeneration(plan, request, buildContinuation, authorityStore)
  })

const recoverPaperReceiptFinalizationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: PaperActivationRequest,
  buildContinuation: ResearchPaperBuildContinuation | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<PaperAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(
      paperActivationRequestIsCurrent(request, plan, evidence, observedAt, {
        allowCloseRecovery: true,
        buildContinuation,
      }),
    ).pipe(Effect.mapError((message) => paperActivationOperationalError(message)))
    if (observedAt < paperEpisodeCloseExpiresAt(request.expiresAt)) {
      return yield* paperActivationOperationalError('durable PAPER receipt finalization is outside its bounded lease')
    }
    yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence)
    return yield* readBoundPaperActivationGeneration(plan, request, buildContinuation, authorityStore)
  })

type PaperActivationStartupResolution =
  | { readonly _tag: 'ReceiptFinalization'; readonly generation: PaperAuthorityGeneration }
  | { readonly _tag: 'Mutation'; readonly generation: PaperAuthorityGeneration }

const preparePaperActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: QualifiedPaperActivationRequest,
): Effect.Effect<ExecutionPrepareOutput, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(paperActivationRequestIsCurrent(request, plan, evidence, observedAt)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    const discoveryConfig = internalExecutionPlan(
      plan,
      'ExecutionCandidateDiscovery',
      request,
      readOnlyExecutionPolicy(plan),
    )
    const riskPolicy = yield* loadObserveRiskPolicy(
      plan.config.alpaca.expectedAccountId,
      plan.strategy.definition.parameters.universe,
    ).pipe(
      Effect.mapError((cause) =>
        paperActivationOperationalError('source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'paper-candidate-policy').pipe(
      Effect.mapError((cause) => paperActivationOperationalError(cause.message, cause)),
    )
    const discoveryReceipt = yield* discoverExecutionCandidate(
      discoveryConfig as ApplicationPlanFor<'ExecutionCandidateDiscovery'>,
      riskPolicyHash,
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic discovery subprogram boundary owns this layer
      Effect.provide(
        ExecutionCandidateDiscoveryResourcesLive(discoveryConfig as ApplicationPlanFor<'ExecutionCandidateDiscovery'>),
      ),
      Effect.mapError((cause) =>
        paperActivationOperationalError('execution candidate discovery resource failed', cause),
      ),
    )
    const prepareRequest = yield* Effect.fromResult(
      buildPaperActivationPrepareRequest(request, evidence, discoveryReceipt),
    ).pipe(Effect.mapError((message) => paperActivationOperationalError(message)))
    const prepareConfig = internalExecutionPlan(
      plan,
      'ExecutionPrepare',
      request,
      readOnlyExecutionPolicy(plan),
      prepareRequest,
    )
    const validated = yield* validateExecutionPreparePlan(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic PREPARE validation boundary owns this layer
      Effect.provide(ExecutionPrepareValidationResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => paperActivationOperationalError('execution PREPARE validation failed', cause)),
    )
    const prepared = yield* prepareExecutionPrepareOutput(validated).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic PREPARE execution boundary owns this layer
      Effect.provide(ExecutionPrepareExecutionResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => paperActivationOperationalError('execution PREPARE resource failed', cause)),
    )
    yield* Effect.fromResult(preparedPaperActivationIsBound(request, plan, prepared)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    return prepared
  })

const validateResearchPaperPreflight = (
  request: ResearchPaperActivationRequest,
  preflight: ReadPreflight,
): Result.Result<void, string> =>
  preflight.environment === BrokerEnvironment.Sandbox &&
  preflight.accountId === request.broker.accountId &&
  preflight.openOrderCount === request.limits.maxOpenOrders &&
  preflight.positionCount === request.limits.maxPositions
    ? Result.succeed(undefined)
    : Result.fail('research PAPER preflight requires the exact empty sandbox account')

const validateResearchPaperRiskPolicy = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchPaperActivationRequest,
): Effect.Effect<void, OperationalError> =>
  loadObserveRiskPolicy(request.broker.accountId, plan.strategy.definition.parameters.universe).pipe(
    Effect.mapError((cause) =>
      paperActivationOperationalError('source-controlled PAPER risk policy is invalid', cause),
    ),
    Effect.flatMap((riskPolicy) => policyHash(riskPolicy, 'paper-candidate-policy')),
    Effect.mapError((cause) => paperActivationOperationalError(cause.message, cause)),
    Effect.flatMap((currentRiskPolicyHash) =>
      currentRiskPolicyHash === request.riskPolicyHash
        ? Effect.void
        : Effect.fail(
            paperActivationOperationalError('research PAPER request is not bound to the current risk policy'),
          ),
    ),
  )

const validateResearchPaperCloseLease = (
  request: ResearchPaperActivationRequest,
  session: BrokerSessionShape,
): Effect.Effect<void, OperationalError> => {
  const requestedRange = { start: request.cutoffAt.slice(0, 10), end: request.expiresAt.slice(0, 10) }
  return session.read.marketCalendar(requestedRange).pipe(
    Effect.mapError((cause) => paperActivationOperationalError('research PAPER close calendar read failed', cause)),
    Effect.flatMap((calendar) =>
      calendar.value.requestedRange.start === requestedRange.start &&
      calendar.value.requestedRange.end === requestedRange.end
        ? Effect.succeed(calendar.value.sessions)
        : Effect.fail(
            paperActivationOperationalError('research PAPER close calendar did not cover the requested lease'),
          ),
    ),
    Effect.flatMap((sessions) =>
      Effect.fromResult(
        validatePaperEpisodeCloseWindow({
          cutoffAt: request.cutoffAt,
          expiresAt: request.expiresAt,
          maximumCloseSessions: request.maximumCloseSessions,
          sessions,
        }),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof OperationalError
        ? cause
        : paperActivationOperationalError(`research PAPER close lease is invalid: ${cause._tag}`, cause),
    ),
    Effect.asVoid,
  )
}

const validateActivatedResearchAuthority = (authority: AuthorityState): Result.Result<void, string> =>
  authority.maximum === Authority.Paper && authority.effective === Authority.Paper && authority.kill === KillState.Clear
    ? Result.succeed(undefined)
    : Result.fail('research PAPER activation did not return clear effective PAPER authority')

const readCurrentResearchPaperGeneration = (
  authority: AuthorityState,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration | undefined, OperationalError> => {
  if (authority.maximum !== Authority.Paper) return Effect.as(Effect.void, undefined)
  if (authorityStore.readResearchAuthorityGeneration === undefined) {
    return Effect.fail(paperActivationOperationalError('research PAPER startup requires v3 authority history reads'))
  }
  return authorityStore.readResearchAuthorityGeneration(authority.generationHash).pipe(
    Effect.mapError((cause) => paperActivationOperationalError('research PAPER generation read failed', cause)),
    Effect.flatMap((generation) =>
      generation === undefined
        ? Effect.fail(paperActivationOperationalError('durable research PAPER history is missing'))
        : Effect.succeed(generation),
    ),
  )
}

const prepareResearchPaperActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchPaperActivationRequest,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(paperActivationRequestIsCurrent(request, plan, null, observedAt)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    yield* Effect.fromResult(validateResearchPaperPreflight(request, session.preflight)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    yield* validateResearchPaperRiskPolicy(plan, request)
    yield* validateResearchPaperCloseLease(request, session)

    const proof = researchCapitalGrantProof(request)
    const authority = yield* lifecycle
      .activateResearchCapitalGrant(proof)
      .pipe(
        Effect.mapError((cause) =>
          paperActivationOperationalError('research PAPER generation activation failed', cause),
        ),
      )
    yield* Effect.fromResult(validateActivatedResearchAuthority(authority)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    return yield* readBoundPaperActivationGeneration(plan, request, null, authorityStore).pipe(
      Effect.flatMap((generation) =>
        generation.schemaVersion === 'bayn.paper-authority-generation.v3'
          ? Effect.succeed(generation)
          : Effect.fail(paperActivationOperationalError('research PAPER activation loaded qualified history')),
      ),
    )
  })

const refreshResearchPaperActivationReconciliationDataFirst = <E, R>(
  reconcile: Effect.Effect<unknown, E, R>,
  operationTimeoutMs: number,
): Effect.Effect<void, OperationalError, R> =>
  reconcile.pipe(
    Effect.timeoutOrElse({
      duration: operationTimeoutMs,
      orElse: () =>
        Effect.fail(paperActivationOperationalError('research PAPER pre-activation reconciliation timed out')),
    }),
    Effect.mapError((cause) =>
      paperActivationOperationalError('research PAPER pre-activation reconciliation failed', cause),
    ),
    Effect.asVoid,
  )

export const refreshResearchPaperActivationReconciliation = Pipeable.generic<
  <E, R>(
    operationTimeoutMs: number,
  ) => (reconcile: Effect.Effect<unknown, E, R>) => Effect.Effect<void, OperationalError, R>,
  typeof refreshResearchPaperActivationReconciliationDataFirst
>(2, refreshResearchPaperActivationReconciliationDataFirst)

const prepareOrRecoverResearchPaperActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchPaperActivationRequest,
  buildContinuation: ResearchPaperBuildContinuation | null,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
  reconcile: Effect.Effect<unknown, ReconciliationPassError | OperationalError>,
  operationTimeoutMs: number,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    if (authorityStore.readAuthorityState === undefined) {
      return yield* paperActivationOperationalError('research PAPER startup requires durable authority state reads')
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => paperActivationOperationalError('research PAPER authority read failed', cause)),
    )
    const currentGeneration = yield* readCurrentResearchPaperGeneration(authority, authorityStore)
    const currentGenerationMatchesRequest =
      currentGeneration !== undefined &&
      Result.isSuccess(
        buildContinuation === null
          ? researchPaperGenerationIsBoundToRequest(
              request,
              plan.config.alpaca.authorityGenerationHash,
              currentGeneration,
            )
          : researchPaperBuildContinuationIsBound(
              buildContinuation,
              plan.config.alpaca.authorityGenerationHash,
              currentGeneration,
              plan.config.build,
            ),
      )
    const decision = yield* Effect.fromResult(
      decidePaperEpisodeAuthority({
        generationHash: authority.generationHash,
        sourceGenerationHash: plan.config.alpaca.authorityGenerationHash,
        currentGenerationMatchesRequest,
        maximum: authority.maximum,
        effective: authority.effective,
        kill: authority.kill,
        ...(authority.reason === undefined ? {} : { reason: authority.reason }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        paperActivationOperationalError('research PAPER durable authority does not match this episode', cause),
      ),
    )
    if (buildContinuation !== null && decision._tag !== 'Resume') {
      return yield* paperActivationOperationalError(
        'research PAPER build continuation requires the exact active generation',
      )
    }
    if (decision._tag === 'Rearm') {
      const rearmed = yield* authorityStore
        .ensureAuthorityGeneration({
          generationHash: plan.config.alpaca.authorityGenerationHash,
          maximum: Authority.Observe,
        })
        .pipe(
          Effect.mapError((cause) =>
            paperActivationOperationalError('research PAPER source authority rearm failed', cause),
          ),
        )
      if (
        rearmed.generationHash !== plan.config.alpaca.authorityGenerationHash ||
        rearmed.maximum !== Authority.Observe ||
        rearmed.effective !== Authority.Observe ||
        rearmed.kill !== KillState.Clear
      ) {
        return yield* paperActivationOperationalError(
          'research PAPER source authority rearm did not return clear OBSERVE',
        )
      }
    }
    if (decision._tag !== 'Resume') {
      yield* refreshResearchPaperActivationReconciliation(reconcile, operationTimeoutMs)
      return yield* prepareResearchPaperActivation(plan, request, session, authorityStore, lifecycle)
    }
    const generation =
      currentGeneration ?? (yield* paperActivationOperationalError('research PAPER recovery lost durable history'))
    if (buildContinuation !== null) {
      yield* Effect.logInfo('Bayn PAPER build continuation resumed the active generation').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          continuationHash: buildContinuation.continuationHash,
          generationHash: generation.generationHash,
          sourceRevision: plan.config.build.sourceRevision,
          imageDigest: plan.config.build.imageDigest,
        }),
      )
    }
    return generation
  })

const pendingPaperActivation = (
  state: Ref.Ref<RuntimeState>,
  request: PaperActivationRequest | null,
  reason: Extract<NonNullable<RuntimeState['paperActivation']>, { readonly _tag: 'Pending' }>['reason'],
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    paperActivation: { _tag: 'Pending' as const, requestHash: request?.requestHash ?? null, reason },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'PAPER_ACTIVATION_NOT_PREPARED',
          },
    error: null,
  }))

const realizedPaperActivation = (
  state: Ref.Ref<RuntimeState>,
  request: PaperActivationRequest,
  generationHash: string,
  grant: 'Qualified' | 'Research',
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    paperActivation: {
      _tag: 'Realized' as const,
      requestHash: request.requestHash,
      generationHash,
      grant,
      cutoffAt: request.cutoffAt,
      expiresAt: request.expiresAt,
      maximumCloseSessions: isResearchPaperActivationRequest(request) ? request.maximumCloseSessions : null,
    },
    broker:
      current.broker === null ? null : { ...current.broker, executionEligible: true, executionDisabledReason: null },
    error: null,
  }))

const completedPaperActivation = (
  state: Ref.Ref<RuntimeState>,
  request: PaperActivationRequest,
  generationHash: string,
  receiptHash: string,
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    paperActivation: {
      _tag: 'Completed' as const,
      requestHash: request.requestHash,
      generationHash,
      grant: isResearchPaperActivationRequest(request) ? ('Research' as const) : ('Qualified' as const),
      receiptHash,
    },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'PAPER_EPISODE_COMPLETED',
          },
    error: null,
  }))

const restrictExpiredPaperActivationDataFirst = (
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<void, OperationalError> =>
  restrictMutationAuthority('PAPER activation lease', 'immutable activation request expired').pipe(
    Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
    Effect.provideService(WriterFence, writerFence),
    Effect.mapError((cause) => paperActivationOperationalError('expired PAPER activation restriction failed', cause)),
  )

export const restrictExpiredPaperActivation = Pipeable.dual(2, restrictExpiredPaperActivationDataFirst)

const restrictPaperAtExpiry = (
  expiresAt: string,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const remainingMs = Date.parse(expiresAt) - Date.parse(observedAt)
    if (remainingMs > 0) yield* Effect.sleep(Duration.millis(remainingMs))
    yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence).pipe(
      Effect.retry({
        times: 4,
        schedule: Schedule.spaced(Duration.seconds(1)),
      }),
      Effect.tapError((cause) =>
        Effect.logError('Bayn PAPER activation expiry restriction exhausted retries').pipe(
          Effect.annotateLogs({ reason: cause instanceof Error ? cause.message : String(cause) }),
        ),
      ),
      Effect.orDie,
    )
  })

const signedMicros = (value: string | null): bigint | undefined =>
  value !== null && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined

const makeClosedCycleReceiptEmitter =
  (
    config: LoadedRuntimeConfig,
    sql: PgClient.PgClient,
    authorityGenerationHash: string,
    receiptStore: ForwardPerformanceReceiptStoreShape,
  ): ((cycleId: string | undefined, observedAt: string) => Effect.Effect<string | undefined>) =>
  (cycleId, observedAt) =>
    Effect.gen(function* () {
      const existing = yield* receiptStore.read(authorityGenerationHash)
      if (Option.isSome(existing)) return existing.value.receiptHash
      const receipt = yield* Effect.scoped(
        runForwardPerformance(config, undefined, { authorityGenerationHash }).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
      )
      const netRealizedPnl = signedMicros(receipt.totals.netRealizedPnlAfterCostsMicros)
      const reconciliationExact =
        receipt.window.reconciliationStatus === 'EXACT' || receipt.window.cashYieldAdjustedExact === true
      const exactClosedEvidence =
        receipt.evidence.status === 'SUFFICIENT' &&
        reconciliationExact &&
        receipt.window.reconciliationId !== null &&
        receipt.window.reconciliationContentHash !== null &&
        receipt.reconciliationProof.accountingReceiptsExact &&
        receipt.reconciliationProof.ledgerExact &&
        receipt.reconciliationProof.missingLedgerAccountCount === 0 &&
        receipt.reconciliationProof.unresolvedMutationCount === 0 &&
        receipt.reconciliationProof.unclosedCycleCount === 0 &&
        receipt.reconciliationProof.openPositionCount === 0 &&
        receipt.executionQuality.status === 'MEASURED' &&
        netRealizedPnl !== undefined
      if (!exactClosedEvidence) {
        yield* Effect.logWarning('Bayn forward-performance receipt withheld: closed exact evidence is incomplete').pipe(
          Effect.annotateLogs({
            service: 'bayn',
            cycleId,
            observedAt,
            evidenceStatus: receipt.evidence.status,
            accountingReceiptsExact: receipt.reconciliationProof.accountingReceiptsExact,
            ledgerExact: receipt.reconciliationProof.ledgerExact,
            unclosedCycleCount: receipt.reconciliationProof.unclosedCycleCount,
            openPositionCount: receipt.reconciliationProof.openPositionCount,
          }),
        )
        return undefined
      }
      if (receipt.profitability === 'PROFITABLE' && netRealizedPnl <= 0n) {
        yield* Effect.logError('Bayn forward-performance receipt rejected an unsupported positive claim').pipe(
          Effect.annotateLogs({ service: 'bayn', cycleId, receiptHash: receipt.receiptHash }),
        )
        return undefined
      }
      const receiptCycleId = cycleId ?? receipt.window.lastCycleId
      if (receiptCycleId === null || receiptCycleId === undefined) {
        yield* Effect.logWarning(
          'Bayn forward-performance receipt withheld: no closed cycle identity was observed',
        ).pipe(Effect.annotateLogs({ service: 'bayn', observedAt }))
        return undefined
      }
      const envelope = yield* Effect.fromResult(
        makeForwardPerformanceReceiptEnvelope({
          schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
          authorityGenerationHash,
          cycleId: receiptCycleId,
          receiptHash: receipt.receiptHash,
          receipt,
          createdAt: observedAt,
        }),
      )
      const stored = yield* receiptStore.bind(envelope)
      yield* Effect.logInfo('Bayn forward-performance receipt emitted').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          cycleId,
          receiptHash: stored.receiptHash,
          evidenceStatus: stored.receipt.evidence.status,
          profitability: stored.receipt.profitability,
          netRealizedPnlAfterCostsMicros: stored.receipt.totals.netRealizedPnlAfterCostsMicros,
        }),
      )
      return stored.receiptHash
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError('Bayn forward-performance receipt emission failed').pipe(
          Effect.annotateLogs({
            service: 'bayn',
            cycleId,
            observedAt,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          Effect.as(undefined),
        ),
      ),
    )

const finalizePaperEpisodeDataFirst = (
  state: Ref.Ref<RuntimeState>,
  request: PaperActivationRequest,
  generationHash: string,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
  emit: (cycleId: string | undefined, observedAt: string) => Effect.Effect<string | undefined>,
  cycleId: string | undefined,
  observedAt: string,
): Effect.Effect<boolean> =>
  emit(cycleId, observedAt).pipe(
    Effect.flatMap((receiptHash) =>
      receiptHash === undefined
        ? Effect.succeed(false)
        : restrictMutationAuthority('PAPER episode', 'flat exact receipt finalized').pipe(
            Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.andThen(completedPaperActivation(state, request, generationHash, receiptHash)),
            Effect.as(true),
          ),
    ),
    Effect.catch((cause) =>
      Effect.logError('Bayn PAPER episode finalization failed').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          cycleId,
          observedAt,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
        Effect.as(false),
      ),
    ),
  )

export const finalizePaperEpisode = Pipeable.dual(8, finalizePaperEpisodeDataFirst)

const retryClosedCycleReceiptsDataFirst = (
  emit: (cycleId: string | undefined, observedAt: string) => Effect.Effect<boolean>,
  cutoffAt: string,
  retryUntilAt: string,
  intervalMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const interval = Math.max(1_000, intervalMs)
    const cutoffMs = Date.parse(cutoffAt)
    const retryUntilMs = Date.parse(retryUntilAt)
    if (!Number.isFinite(cutoffMs) || !Number.isFinite(retryUntilMs) || retryUntilMs < cutoffMs) return
    while (true) {
      const observedAt = yield* currentUtcInstant
      const observedMs = Date.parse(observedAt)
      const untilCutoff = cutoffMs - observedMs
      if (untilCutoff > 0) {
        yield* Effect.sleep(Duration.millis(Math.min(interval, untilCutoff)))
        continue
      }
      if (yield* emit(undefined, observedAt)) return
      if (observedMs >= retryUntilMs) return
      yield* Effect.sleep(Duration.millis(Math.min(interval, retryUntilMs - observedMs)))
    }
  })

export const retryClosedCycleReceipts = Pipeable.dual(4, retryClosedCycleReceiptsDataFirst)

const closedCycleReceiptEmissionAllowedDataFirst = (cutoffAt: string, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(cutoffAt)

export const closedCycleReceiptEmissionAllowed = Pipeable.dual(2, closedCycleReceiptEmissionAllowedDataFirst)

const paperReceiptFinalizationWindowOpenDataFirst = (authorityExpiresAt: string, observedAt: string): boolean => {
  const observedMs = Date.parse(observedAt)
  const closeExpiresMs = Date.parse(paperEpisodeCloseExpiresAt(authorityExpiresAt))
  const finalizationExpiresMs = Date.parse(paperEpisodeReceiptFinalizationExpiresAt(authorityExpiresAt))
  return Number.isFinite(observedMs) && observedMs >= closeExpiresMs && observedMs < finalizationExpiresMs
}

export const paperReceiptFinalizationWindowOpen = Pipeable.dual(2, paperReceiptFinalizationWindowOpenDataFirst)

const runAutonomousService = (plan: ApplicationPlanFor<'AutonomousService'>) =>
  Effect.gen(function* () {
    const dependencies = yield* applicationDependencies
    const observeConfig = {
      ...plan.config,
      execution: readOnlyExecutionPolicy(plan),
    } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
    const observePlan = makeApplicationPlan({
      config: observeConfig,
      protocol: plan.protocol,
      parameterHash: plan.parameterHash,
      strategy: plan.strategy,
      strategyProtocolHash: plan.strategyProtocolHash,
    }) as ApplicationPlanFor<'AutonomousService'>
    const serializedRequest = observePlan.config.paperActivationRequestJson
    const decodedActivation: Result.Result<ConfiguredPaperActivation | null, string> =
      serializedRequest === undefined ? Result.succeed(null) : decodeConfiguredPaperActivation(serializedRequest)
    const startupEvidenceMode =
      Result.isSuccess(decodedActivation) &&
      decodedActivation.success !== null &&
      isResearchPaperActivationRequest(decodedActivation.success.request)
        ? ('Research' as const)
        : ('Qualification' as const)
    const noCycle = (
      _startup: AutonomousCycleStartupInput,
    ): Effect.Effect<Effect.Effect<void, never, never>, OperationalError, never> => Effect.succeed(Effect.never)
    const pendingRuntime = () => ({
      _tag: 'AutonomousRead' as const,
      startupEvidenceMode,
      cycleBindingId: null,
      brokerConfiguration: {
        expectedAccountId: observePlan.config.alpaca.expectedAccountId,
        executionEligible: false,
        executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
      },
      startCycle: noCycle,
    })
    const resolveAfterStartup: AutonomousRuntimeResolver<never, never> = (state) => {
      const validateStaticRequest: Effect.Effect<
        Result.Result<
          {
            readonly request: PaperActivationRequest | null
            readonly buildContinuation: ResearchPaperBuildContinuation | null
            readonly evidence: RuntimeEvidence | null
          },
          string
        >,
        OperationalError
      > = Effect.gen(function* () {
        if (Result.isFailure(decodedActivation)) {
          yield* pendingPaperActivation(state, null, 'REQUEST_INVALID')
          return Result.fail('request-invalid')
        }
        const configured = decodedActivation.success
        const request = configured?.request ?? null
        const buildContinuation = configured?.buildContinuation ?? null
        const current = yield* Ref.get(state)
        if (request === null) return Result.succeed({ request, buildContinuation, evidence: current.evidence })
        const observedAt = yield* currentUtcInstant
        const validation = paperActivationRequestIsCurrent(request, observePlan, current.evidence, observedAt, {
          allowCloseRecovery: true,
          buildContinuation,
        })
        if (Result.isFailure(validation)) {
          yield* pendingPaperActivation(state, request, 'PREPARATION_FAILED')
          return Result.fail(validation.failure)
        }
        return Result.succeed({ request, buildContinuation, evidence: current.evidence })
      })
      return validateStaticRequest.pipe(
        Effect.flatMap((validated): Effect.Effect<AutonomousRuntime<never, never>, never, Scope.Scope> => {
          if (Result.isFailure(validated)) return Effect.succeed(pendingRuntime())
          const request = validated.success.request
          const buildContinuation = validated.success.buildContinuation
          return Effect.flatMap(Scope.Scope, (scope) =>
            scopedAcquisition(
              (attemptScope) =>
                Layer.buildWithMemoMap(
                  Layer.fresh(AutonomousRuntimeResourcesLive(observePlan)),
                  Layer.makeMemoMapUnsafe(),
                  attemptScope,
                ).pipe(
                  Effect.flatMap((runtimeContext) =>
                    Effect.all({
                      pgClient: PgClient.PgClient,
                      session: BrokerSession,
                      alpacaHttpClient: AlpacaHttpClient,
                      liveCapitalGrants: LiveCapitalGrantStore,
                      intentStore: IntentStore,
                      mutationStore: MutationStore,
                      writerFence: WriterFence,
                      cycleStore: CycleStore,
                      brokerEventStore: BrokerEventStore,
                      fillAccountingStore: FillAccountingStore,
                      valuationStore: ValuationStore,
                      reconciliationStore: ReconciliationStore,
                      authorityGenerationStore: AuthorityGenerationStore,
                      capitalGrantLifecycleStore: CapitalGrantLifecycleStore,
                      authorityRestrictionStore: AuthorityRestrictionStore,
                      paperCycleClosureStore: PaperCycleClosureStore,
                      forwardPerformanceReceiptStore: ForwardPerformanceReceiptStore,
                    }).pipe(
                      Effect.flatMap((runtimeServices) => {
                        const cycleResources = Layer.mergeAll(
                          Layer.succeed(BrokerRead, runtimeServices.session.read),
                          Layer.succeed(MarketData, dependencies.marketData),
                          Layer.succeed(CycleStore, runtimeServices.cycleStore),
                          Layer.succeed(BrokerEventStore, runtimeServices.brokerEventStore),
                          Layer.succeed(FillAccountingStore, runtimeServices.fillAccountingStore),
                          Layer.succeed(ValuationStore, runtimeServices.valuationStore),
                          Layer.succeed(ReconciliationStore, runtimeServices.reconciliationStore),
                          Layer.succeed(AuthorityGenerationStore, runtimeServices.authorityGenerationStore),
                          Layer.succeed(AuthorityRestrictionStore, runtimeServices.authorityRestrictionStore),
                          Layer.succeed(WriterFence, runtimeServices.writerFence),
                          Layer.succeed(IntentStore, runtimeServices.intentStore),
                          Layer.succeed(MutationStore, runtimeServices.mutationStore),
                          Layer.succeed(PaperCycleClosureStore, runtimeServices.paperCycleClosureStore),
                        )
                        const readStartCycle = (startup: AutonomousCycleStartupInput) =>
                          observeCycle(observePlan)(startup).pipe(
                            // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                            Effect.provide(cycleResources),
                            Effect.map((loop) =>
                              loop.pipe(
                                // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                Effect.provide(cycleResources),
                              ),
                            ),
                          )
                        const readRuntime = () => ({
                          _tag: 'AutonomousRead' as const,
                          startupEvidenceMode:
                            request !== null && isResearchPaperActivationRequest(request)
                              ? ('Research' as const)
                              : ('Qualification' as const),
                          broker: runtimeBroker(observePlan, runtimeServices.session.read, false),
                          ...(request !== null && isResearchPaperActivationRequest(request)
                            ? { cycleBindingId: null, cycleObservationId: request.grant.planHash }
                            : {}),
                          startCycle: readStartCycle,
                        })
                        if (request === null) return Effect.succeed(readRuntime())
                        const evidence = validated.success.evidence
                        if (evidence === null && !isResearchPaperActivationRequest(request)) {
                          return pendingPaperActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE').pipe(
                            Effect.as(readRuntime()),
                          )
                        }
                        const prepareOrRecover: Effect.Effect<PaperActivationStartupResolution, OperationalError> =
                          currentUtcInstant.pipe(
                            Effect.flatMap(
                              (observedAt): Effect.Effect<PaperActivationStartupResolution, OperationalError> =>
                                observedAt >= paperEpisodeCloseExpiresAt(request.expiresAt)
                                  ? recoverPaperReceiptFinalizationGeneration(
                                      observePlan,
                                      request,
                                      buildContinuation,
                                      evidence,
                                      runtimeServices.authorityGenerationStore,
                                      runtimeServices.authorityRestrictionStore,
                                      runtimeServices.writerFence,
                                    ).pipe(
                                      Effect.map((generation) => ({
                                        _tag: 'ReceiptFinalization' as const,
                                        generation,
                                      })),
                                    )
                                  : observedAt >= request.cutoffAt
                                    ? recoverPaperActivationGeneration(
                                        observePlan,
                                        request,
                                        buildContinuation,
                                        evidence,
                                        runtimeServices.authorityGenerationStore,
                                        runtimeServices.authorityRestrictionStore,
                                        runtimeServices.writerFence,
                                      ).pipe(Effect.map((generation) => ({ _tag: 'Mutation' as const, generation })))
                                    : isResearchPaperActivationRequest(request)
                                      ? prepareOrRecoverResearchPaperActivation(
                                          observePlan,
                                          request,
                                          buildContinuation,
                                          runtimeServices.session,
                                          runtimeServices.authorityGenerationStore,
                                          runtimeServices.capitalGrantLifecycleStore,
                                          runOnce.pipe(
                                            // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                            Effect.provide(cycleResources),
                                          ),
                                          observePlan.config.operationTimeoutMs,
                                        ).pipe(Effect.map((generation) => ({ _tag: 'Mutation' as const, generation })))
                                      : evidence === null
                                        ? Effect.fail(
                                            paperActivationOperationalError(
                                              'qualified PAPER activation evidence is unavailable',
                                            ),
                                          )
                                        : preparePaperActivation(observePlan, evidence, request).pipe(
                                            Effect.map(({ generation }) => ({ _tag: 'Mutation' as const, generation })),
                                          ),
                            ),
                          )
                        return prepareOrRecover.pipe(
                          Effect.flatMap(
                            (
                              prepared,
                            ): Effect.Effect<AutonomousRuntime<never, never>, OperationalError, Scope.Scope> => {
                              if (prepared._tag === 'ReceiptFinalization') {
                                const emitClosedCycleReceipt = makeClosedCycleReceiptEmitter(
                                  observePlan.config,
                                  runtimeServices.pgClient,
                                  prepared.generation.generationHash,
                                  runtimeServices.forwardPerformanceReceiptStore,
                                )
                                const finalizeClosedCycleReceipt = (cycleId: string | undefined, observedAt: string) =>
                                  finalizePaperEpisode(
                                    state,
                                    request,
                                    prepared.generation.generationHash,
                                    runtimeServices.authorityRestrictionStore,
                                    runtimeServices.writerFence,
                                    emitClosedCycleReceipt,
                                    cycleId,
                                    observedAt,
                                  )
                                return Effect.gen(function* () {
                                  yield* pendingPaperActivation(state, request, 'REQUEST_EXPIRED')
                                  const observedAt = yield* currentUtcInstant
                                  if (!paperReceiptFinalizationWindowOpen(request.expiresAt, observedAt)) {
                                    const existing = yield* runtimeServices.forwardPerformanceReceiptStore
                                      .read(prepared.generation.generationHash)
                                      .pipe(
                                        Effect.mapError((cause) =>
                                          paperActivationOperationalError(
                                            'durable PAPER receipt recovery read failed',
                                            cause,
                                          ),
                                        ),
                                      )
                                    if (Option.isSome(existing)) {
                                      yield* finalizePaperEpisode(
                                        state,
                                        request,
                                        prepared.generation.generationHash,
                                        runtimeServices.authorityRestrictionStore,
                                        runtimeServices.writerFence,
                                        () => Effect.succeed(existing.value.receiptHash),
                                        existing.value.cycleId,
                                        observedAt,
                                      )
                                    }
                                    return readRuntime()
                                  }
                                  yield* Effect.forkScoped(
                                    retryClosedCycleReceipts(
                                      finalizeClosedCycleReceipt,
                                      request.cutoffAt,
                                      paperEpisodeReceiptFinalizationExpiresAt(request.expiresAt),
                                      observePlan.config.alpaca.reconciliationIntervalMs,
                                    ),
                                  )
                                  return readRuntime()
                                })
                              }
                              if (observePlan.config.alpaca.identity.environment !== BrokerEnvironment.Sandbox) {
                                return Effect.fail(
                                  paperActivationOperationalError('paper activation requires a sandbox broker'),
                                )
                              }
                              return currentUtcInstant.pipe(
                                Effect.flatMap((observedAt) =>
                                  resolvePreparedSandboxAuthority({
                                    brokerIdentity: observePlan.config.alpaca.identity as Extract<
                                      typeof observePlan.config.alpaca.identity,
                                      { readonly environment: BrokerEnvironment.Sandbox }
                                    >,
                                    strategy: observePlan.strategy.provenance.strategy,
                                    generationHash: prepared.generation.generationHash,
                                    observedAt,
                                  }),
                                ),
                                Effect.mapError((cause) =>
                                  paperActivationOperationalError(
                                    'prepared sandbox execution authority is invalid',
                                    cause,
                                  ),
                                ),
                                Effect.flatMap((authority) => {
                                  const realizedPolicy = resolveExecutionPolicy({
                                    brokerIdentity: observePlan.config.alpaca.identity,
                                    brokerAccess: BrokerAccess.Mutation,
                                    capitalAuthority: CapitalAuthoritySelection.Sandbox,
                                    authorityGenerationHash: prepared.generation.generationHash,
                                    liveCapitalGrantHash: undefined,
                                  })
                                  if (Result.isFailure(realizedPolicy)) {
                                    return Effect.fail(
                                      paperActivationOperationalError(
                                        'prepared sandbox execution policy is invalid',
                                        realizedPolicy.failure,
                                      ),
                                    )
                                  }
                                  const realizedConfig = {
                                    ...observePlan.config,
                                    execution: realizedPolicy.success,
                                    ...(isResearchPaperActivationRequest(request)
                                      ? { qualificationRunId: request.grant.planHash }
                                      : {}),
                                  } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
                                  const realizedPlan = makeApplicationPlan({
                                    config: realizedConfig,
                                    protocol: observePlan.protocol,
                                    parameterHash: observePlan.parameterHash,
                                    strategy: observePlan.strategy,
                                    strategyProtocolHash: observePlan.strategyProtocolHash,
                                  }) as ApplicationPlanFor<'AutonomousService'>
                                  const paperGrant = paperGrantFromGeneration(prepared.generation)
                                  const cycleBindingId = paperGrantKey(paperGrant)
                                  const emitClosedCycleReceipt = makeClosedCycleReceiptEmitter(
                                    realizedPlan.config,
                                    runtimeServices.pgClient,
                                    prepared.generation.generationHash,
                                    runtimeServices.forwardPerformanceReceiptStore,
                                  )
                                  const finalizeClosedCycleReceipt = (
                                    cycleId: string | undefined,
                                    observedAt: string,
                                  ) =>
                                    finalizePaperEpisode(
                                      state,
                                      request,
                                      prepared.generation.generationHash,
                                      runtimeServices.authorityRestrictionStore,
                                      runtimeServices.writerFence,
                                      emitClosedCycleReceipt,
                                      cycleId,
                                      observedAt,
                                    )
                                  const onClosedCycle = (cycleId: string, observedAt: string) =>
                                    closedCycleReceiptEmissionAllowed(request.cutoffAt, observedAt)
                                      ? finalizeClosedCycleReceipt(cycleId, observedAt).pipe(Effect.asVoid)
                                      : Effect.void
                                  return makeMutation(
                                    runtimeServices.session,
                                    authority,
                                    runtimeServices.alpacaHttpClient,
                                  ).pipe(
                                    Effect.flatMap((brokerMutation) =>
                                      loadObserveRiskPolicy(
                                        realizedPlan.config.alpaca.expectedAccountId,
                                        realizedPlan.strategy.definition.parameters.universe,
                                      ).pipe(
                                        Effect.flatMap((riskPolicy) =>
                                          Effect.fromResult(
                                            makeExecutionProgram(authority, {
                                              brokerRead: runtimeServices.session.read,
                                              liveCapitalGrants: runtimeServices.liveCapitalGrants,
                                              riskPolicy,
                                              freshBrokerPrice: makeFreshBrokerPriceReader(
                                                runtimeServices.session.connection,
                                                runtimeServices.alpacaHttpClient,
                                              ),
                                              currentUtcInstant,
                                              entrySubmitExpiresAt: request.cutoffAt,
                                              closeSubmitExpiresAt: paperEpisodeCloseExpiresAt(request.expiresAt),
                                              isCloseOnlyIntent: (intentId) =>
                                                runtimeServices.paperCycleClosureStore
                                                  .containsIntent(intentId)
                                                  .pipe(Effect.orElseSucceed(() => false)),
                                              intentStore: runtimeServices.intentStore,
                                              mutationStore: runtimeServices.mutationStore,
                                              writerFence: runtimeServices.writerFence,
                                              brokerMutation,
                                            }),
                                          ),
                                        ),
                                      ),
                                    ),
                                    Effect.mapError(executionProgramError),
                                    Effect.tap(() =>
                                      realizedPaperActivation(
                                        state,
                                        request,
                                        prepared.generation.generationHash,
                                        paperGrant._tag,
                                      ),
                                    ),
                                    Effect.tap(() =>
                                      Effect.forkScoped(
                                        retryClosedCycleReceipts(
                                          finalizeClosedCycleReceipt,
                                          request.cutoffAt,
                                          paperEpisodeReceiptFinalizationExpiresAt(request.expiresAt),
                                          realizedPlan.config.alpaca.reconciliationIntervalMs,
                                        ),
                                      ).pipe(Effect.asVoid),
                                    ),
                                    Effect.tap(() =>
                                      Effect.forkScoped(
                                        restrictPaperAtExpiry(
                                          paperEpisodeCloseExpiresAt(request.expiresAt),
                                          runtimeServices.authorityRestrictionStore,
                                          runtimeServices.writerFence,
                                        ),
                                      ).pipe(Effect.asVoid),
                                    ),
                                    Effect.map((executionProgram) => ({
                                      _tag: 'AutonomousMutation' as const,
                                      startupEvidenceMode: isResearchPaperActivationRequest(request)
                                        ? ('Research' as const)
                                        : ('Qualification' as const),
                                      broker: runtimeBroker(realizedPlan, runtimeServices.session.read, true),
                                      cycleBindingId,
                                      cycleObservationId: cycleBindingId,
                                      executionProgram,
                                      startCycle: (startup: AutonomousCycleStartupInput) =>
                                        mutationCycle(
                                          realizedPlan,
                                          executionProgram,
                                          request,
                                          runtimeServices.paperCycleClosureStore,
                                          onClosedCycle,
                                        )(startup).pipe(
                                          // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                          Effect.provide(cycleResources),
                                          Effect.map((loop) =>
                                            loop.pipe(
                                              // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                              Effect.provide(cycleResources),
                                            ),
                                          ),
                                        ),
                                    })),
                                  )
                                }),
                              )
                            },
                          ),
                          Effect.catch((cause) =>
                            Effect.logWarning('Bayn PAPER activation remains in OBSERVE').pipe(
                              Effect.annotateLogs({
                                service: 'bayn',
                                activation: 'PENDING',
                                reason: cause instanceof Error ? cause.message : String(cause),
                              }),
                              Effect.andThen(
                                pendingPaperActivation(state, request, 'PREPARATION_FAILED').pipe(
                                  Effect.as(readRuntime()),
                                ),
                              ),
                            ),
                          ),
                        )
                      }),
                      Effect.provide(runtimeContext),
                    ),
                  ),
                ),
              scope,
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning('Bayn PAPER activation remains in OBSERVE').pipe(
                Effect.annotateLogs({
                  service: 'bayn',
                  activation: 'PENDING',
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
                Effect.andThen(
                  request === null
                    ? Effect.succeed(pendingRuntime())
                    : pendingPaperActivation(state, request, 'PREPARATION_FAILED').pipe(Effect.as(pendingRuntime())),
                ),
              ),
            ),
          )
        }),
        Effect.catch((cause) =>
          Effect.logWarning('Bayn PAPER activation remains in OBSERVE').pipe(
            Effect.annotateLogs({
              service: 'bayn',
              activation: 'PENDING',
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
            Effect.andThen(pendingPaperActivation(state, null, 'PREPARATION_FAILED').pipe(Effect.as(pendingRuntime()))),
          ),
        ),
      )
    }
    return yield* runApplication(observePlan.config, observePlan.strategy, dependencies, {
      ...pendingRuntime(),
      resolveAfterStartup,
    })
  })

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const writeDiscoveryReceipt = (receipt: ExecutionCandidateDiscoveryReceipt) =>
  pipe(
    encodeJson(receipt),
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'paper-candidate-output',
        message: 'paper candidate receipt encoding failed',
        cause,
      }),
    ),
    Effect.flatMap((output) =>
      pipe(
        Stdio.Stdio,
        Effect.flatMap((stdio) => Stream.run(Stream.make(`${output}\n`), stdio.stdout())),
      ),
    ),
  )

const writeExecutionPrepareOutput = (output: ExecutionPrepareOutput) =>
  pipe(
    encodeJson(output),
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'execution-prepare-output',
        message: 'EXECUTION_PREPARE output encoding failed',
        cause,
      }),
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
      operationalError({
        component: 'strategy',
        operation,
        message: 'source-controlled OBSERVE risk policy content hashing failed',
        cause,
      }),
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
      operationalError({
        component: 'strategy',
        operation: 'execution-candidate-discovery',
        message: renderExecutionCandidateDiscoveryError(cause),
        cause,
      }),
    ),
  )

const runExecutionCandidateDiscovery = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>) =>
  pipe(
    loadObserveRiskPolicy(plan.config.alpaca.expectedAccountId, plan.strategy.definition.parameters.universe),
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'execution-candidate-discovery',
        message: 'source-controlled OBSERVE risk policy is invalid',
        cause,
      }),
    ),
    Effect.flatMap((policy) => policyHash(policy, 'paper-candidate-policy')),
    Effect.flatMap((riskPolicyHash) => discoverExecutionCandidate(plan, riskPolicyHash)),
    Effect.flatMap(writeDiscoveryReceipt),
  )

const executionPrepareRuntimeBinding = (
  plan: ApplicationPlanFor<'ExecutionPrepare'>,
  riskPolicyHash: string,
  strategy: ExecutionPrepareRuntimeBinding['strategy'],
): ExecutionPrepareRuntimeBinding => ({
  sourceRevision: plan.config.build.sourceRevision,
  imageRepository: plan.config.build.imageRepository,
  imageDigest: plan.config.build.imageDigest,
  strategy,
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
      plan.strategy.definition.parameters.universe,
    ).pipe(
      Effect.mapError((cause) =>
        operationalError({
          component: 'config',
          operation: 'execution-prepare',
          message: 'source-controlled OBSERVE risk policy is invalid',
          cause,
        }),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-prepare-policy')
    const configuredStrategy = plan.strategy.provenance.strategy
    const application = strategyApplication(plan.strategy)
    if (
      configuredStrategy.name !== application.definition.name ||
      configuredStrategy.parameterSchemaVersion !== application.definition.parameters.schemaVersion
    ) {
      return yield* new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare',
        message: 'EXECUTION_PREPARE strategy identity does not match the composed application',
        retryable: false,
        cause: { _tag: 'StrategyProtocolVersionMismatch' },
      })
    }
    const strategy: ExecutionPrepareRuntimeBinding['strategy'] = {
      name: configuredStrategy.name,
      behaviorHash: configuredStrategy.behaviorHash,
      parameterHash: configuredStrategy.parameterHash,
      parameterSchemaVersion: configuredStrategy.parameterSchemaVersion,
    }
    const evidenceStore = yield* EvidenceStore
    const qualification = yield* evidenceStore.readQualification(
      plan.config.executionPrepareRequest.qualification.runId,
    )
    if (Option.isNone(qualification)) {
      return yield* new OperationalError({
        component: 'strategy',
        operation: 'execution-prepare',
        message: 'EXECUTION_PREPARE qualification evidence is unavailable',
        retryable: false,
        cause: { _tag: 'QualificationEvidenceUnavailable' },
      })
    }
    const runtime = executionPrepareRuntimeBinding(plan, riskPolicyHash, strategy)
    const proofPlanRequest = yield* Effect.fromResult(
      buildExecutionPrepareProofPlanRequest({
        request: plan.config.executionPrepareRequest,
        qualification: qualification.value,
        runtime,
      }),
    ).pipe(Effect.mapError(executionPrepareOperationalError))
    return yield* Effect.fromResult(validateExecutionPrepareInput(proofPlanRequest, runtime)).pipe(
      Effect.mapError(executionPrepareOperationalError),
    )
  })

const prepareExecutionPrepareOutput = (prevalidated: PrevalidatedExecutionPrepareInput) =>
  Effect.gen(function* () {
    const session = yield* BrokerSession
    const validated = yield* authenticateValidatedExecutionPrepare(
      prevalidated,
      prevalidated.request.discoveryReceipt,
    ).pipe(Effect.mapError(executionPrepareOperationalError))
    const prepared = yield* prepareValidatedExecutionWithGeneration(validated).pipe(
      Effect.mapError(executionPrepareOperationalError),
    )
    return { ...prepared, preflight: session.preflight }
  })

export const prepareExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  validateExecutionPreparePlan(plan).pipe(
    Effect.flatMap((prevalidated) => prepareExecutionPrepareOutput(prevalidated)),
    Effect.mapError(executionPrepareBoundaryError),
  )

export const runExecutionPreparePlan = (plan: ApplicationPlanFor<'ExecutionPrepare'>) =>
  validateExecutionPreparePlan(plan).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns validation resources
    Effect.provide(ExecutionPrepareValidationResourcesLive(plan)),
    Effect.flatMap((prevalidated) =>
      prepareExecutionPrepareOutput(prevalidated).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns execution resources
        Effect.provide(ExecutionPrepareExecutionResourcesLive(plan)),
        Effect.flatMap(writeExecutionPrepareOutput),
        // @effect-diagnostics-next-line strictEffectProvide:off -- ExecutionPrepare plan boundary owns platform resources
        Effect.provide(ApplicationPlatformLive),
      ),
    ),
    Effect.mapError(executionPrepareBoundaryError),
  )

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
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runBrokerlessService(plan).pipe(Effect.provide(BrokerlessApplicationResourcesLive(plan))),
  ),
  Match.tag('AutonomousService', (plan) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runAutonomousService(plan).pipe(Effect.provide(AutonomousApplicationResourcesLive(plan))),
  ),
  Match.tag('ExecutionCandidateDiscovery', (plan) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runExecutionCandidateDiscovery(plan).pipe(Effect.provide(ExecutionCandidateDiscoveryResourcesLive(plan))),
  ),
  Match.tag('ExecutionPrepare', runExecutionPreparePlan),
  Match.exhaustive,
)
