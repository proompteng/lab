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
import { BrokerRead, BrokerSession, type BrokerReadShape } from './broker/alpaca'
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
  ExecutionStoreLive,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
} from './db/execution-store'
import { LiveCapitalGrantStore, LiveCapitalGrantStoreLive } from './db/live-capital-grant'
import { BrokerAccess, CapitalAuthorityKind, noCapitalAuthority } from './execution/authority'
import { Authority, KillState, type CapitalGrantGeneration } from './execution/contracts'
import {
  CapitalAuthoritySelection,
  decodePaperActivationRequestResult,
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type PaperActivationRequest,
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
  loadObserveRiskPolicy,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  paperEpisodeCloseExpiresAt,
} from './observe-composition'
import { restrictMutationAuthority } from './observe-composition/mutation-interpreter'
import { sqlResource } from './operations'
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
  return Layer.mergeAll(
    HttpServerLive(plan.config),
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
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
  const executionPrepareStore = ExecutionPrepareStoreLive(plan.config).pipe(Layer.provide(postgres))
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
  paperEpisode: Pick<PaperActivationRequest, 'cutoffAt' | 'expiresAt'>,
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
    executionProgram,
    paperCycleClosureStore,
    onClosedCycle,
    paperEpisodeCutoffAt: paperEpisode.cutoffAt,
    paperEpisodeExpiresAt: paperEpisodeCloseExpiresAt(paperEpisode.expiresAt),
  })

const executionProgramError = (
  cause: BrokerMutationError | Result.Result.Failure<ReturnType<typeof makeExecutionProgram>>,
) =>
  cause instanceof BrokerMutationError
    ? operationalError('config', 'broker-mutation', cause.message, cause)
    : operationalError('config', 'execution-program', 'execution program requires validated mutation authority', cause)

type ReadOnlyExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.ReadOnly }>

const paperActivationOperationalError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'paper-activation-prepare',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'PaperActivationPreparationRejected' } : cause,
  })

const decodeConfiguredPaperActivationRequest = (serialized: string): Result.Result<PaperActivationRequest, string> => {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return Result.fail('configured PAPER activation request is not valid JSON')
  }
  const decoded = decodePaperActivationRequestResult(value)
  return Result.isFailure(decoded)
    ? Result.fail('configured PAPER activation request failed its canonical schema and hash validation')
    : Result.succeed(decoded.success)
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
  allowCloseRecovery = false,
): Result.Result<void, string> => {
  if (evidence === null) return Result.fail('pinned qualification evidence was not published by startup')
  if (!allowCloseRecovery && (request.expiresAt <= observedAt || request.cutoffAt <= observedAt)) {
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
  if (
    request.activation.sourceRevision !== plan.config.build.sourceRevision ||
    request.activation.imageRepository !== plan.config.build.imageRepository ||
    request.activation.imageDigest !== plan.config.build.imageDigest
  ) {
    return Result.fail('paper activation request is not bound to the current activation build')
  }
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
  request: PaperActivationRequest,
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
  request: PaperActivationRequest,
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
  request: PaperActivationRequest,
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

const preparedPaperActivationIsBound = (
  request: PaperActivationRequest,
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

const recoverPaperActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: PaperActivationRequest,
  evidence: RuntimeEvidence,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<CapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(paperActivationRequestIsCurrent(request, plan, evidence, observedAt, true)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    const closeExpiresAt = paperEpisodeCloseExpiresAt(request.expiresAt)
    if (observedAt < request.cutoffAt || observedAt >= closeExpiresAt) {
      return yield* Effect.fail(
        paperActivationOperationalError('durable PAPER close recovery is outside its immutable close lease'),
      )
    }
    if (authorityStore.readAuthorityState === undefined || authorityStore.readAuthorityGeneration === undefined) {
      return yield* Effect.fail(
        paperActivationOperationalError('durable PAPER close recovery requires authority history read capabilities'),
      )
    }
    const authority = yield* authorityStore
      .readAuthorityState()
      .pipe(Effect.mapError((cause) => paperActivationOperationalError('durable PAPER authority read failed', cause)))
    if (authority.maximum !== Authority.Paper) {
      return yield* Effect.fail(
        paperActivationOperationalError('durable PAPER close recovery requires PAPER maximum authority'),
      )
    }
    const closeAuthorityIsBound =
      (authority.effective === Authority.Paper && authority.kill === KillState.Clear) ||
      (authority.effective === Authority.Observe && authority.kill === KillState.Active)
    if (!closeAuthorityIsBound) {
      return yield* Effect.fail(
        paperActivationOperationalError(
          'durable PAPER close recovery requires clear PAPER or active OBSERVE close authority',
        ),
      )
    }
    const generation = yield* authorityStore
      .readAuthorityGeneration(authority.generationHash)
      .pipe(Effect.mapError((cause) => paperActivationOperationalError('durable PAPER generation read failed', cause)))
    if (generation === undefined) {
      return yield* Effect.fail(
        paperActivationOperationalError('durable PAPER close recovery generation history is missing'),
      )
    }
    yield* Effect.fromResult(paperGenerationIsBoundToRequest(request, plan, generation)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    return generation
  })

const preparePaperActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: PaperActivationRequest,
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
      Effect.provide(ExecutionPrepareValidationResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => paperActivationOperationalError('execution PREPARE validation failed', cause)),
    )
    const prepared = yield* prepareExecutionPrepareOutput(validated).pipe(
      Effect.provide(ExecutionPrepareExecutionResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => paperActivationOperationalError('execution PREPARE resource failed', cause)),
    )
    yield* Effect.fromResult(preparedPaperActivationIsBound(request, plan, prepared)).pipe(
      Effect.mapError((message) => paperActivationOperationalError(message)),
    )
    return prepared
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
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    paperActivation: { _tag: 'Realized' as const, requestHash: request.requestHash, generationHash },
    broker:
      current.broker === null ? null : { ...current.broker, executionEligible: true, executionDisabledReason: null },
    error: null,
  }))

const restrictPaperAtExpiry = (
  expiresAt: string,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const remainingMs = Date.parse(expiresAt) - Date.parse(observedAt)
    if (remainingMs > 0) yield* Effect.sleep(Duration.millis(remainingMs))
    yield* restrictMutationAuthority('PAPER activation lease', 'immutable activation request expired').pipe(
      Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
      Effect.provideService(WriterFence, writerFence),
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
  ): ((cycleId: string | undefined, observedAt: string) => Effect.Effect<boolean>) =>
  (cycleId, observedAt) =>
    Effect.gen(function* () {
      const existing = yield* receiptStore.read(authorityGenerationHash)
      if (Option.isSome(existing)) return true
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
        return false
      }
      if (receipt.profitability === 'PROFITABLE' && netRealizedPnl <= 0n) {
        yield* Effect.logError('Bayn forward-performance receipt rejected an unsupported positive claim').pipe(
          Effect.annotateLogs({ service: 'bayn', cycleId, receiptHash: receipt.receiptHash }),
        )
        return false
      }
      const receiptCycleId = cycleId ?? receipt.window.lastCycleId
      if (receiptCycleId === null || receiptCycleId === undefined) {
        yield* Effect.logWarning(
          'Bayn forward-performance receipt withheld: no closed cycle identity was observed',
        ).pipe(Effect.annotateLogs({ service: 'bayn', observedAt }))
        return false
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
      return true
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError('Bayn forward-performance receipt emission failed')
          .pipe(
            Effect.annotateLogs({
              service: 'bayn',
              cycleId,
              observedAt,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
          )
          .pipe(Effect.as(false)),
      ),
    )

export const retryClosedCycleReceipts = (
  emit: (cycleId: string | undefined, observedAt: string) => Effect.Effect<boolean>,
  cutoffAt: string,
  closeExpiresAt: string,
  intervalMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const interval = Math.max(1_000, intervalMs)
    let attempts = 0
    while (true) {
      const observedAt = yield* currentUtcInstant
      const untilCutoff = Date.parse(cutoffAt) - Date.parse(observedAt)
      if (untilCutoff > 0) {
        yield* Effect.sleep(Duration.millis(Math.min(interval, untilCutoff)))
        continue
      }
      const untilCloseExpiry = Date.parse(closeExpiresAt) - Date.parse(observedAt)
      if (untilCloseExpiry <= 0) break
      attempts += 1
      if (yield* emit(undefined, observedAt)) return
      if (untilCloseExpiry > 0) yield* Effect.sleep(Duration.millis(Math.min(interval, untilCloseExpiry)))
    }
    yield* Effect.logWarning('Bayn forward-performance receipt retry window exhausted').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        authorityGenerationCutoffAt: cutoffAt,
        authorityGenerationCloseExpiresAt: closeExpiresAt,
        attempts,
      }),
    )
  })

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
    const noCycle = (
      _startup: AutonomousCycleStartupInput,
    ): Effect.Effect<Effect.Effect<void, never, never>, OperationalError, never> => Effect.succeed(Effect.never)
    const pendingRuntime = () => ({
      _tag: 'AutonomousRead' as const,
      brokerConfiguration: {
        expectedAccountId: observePlan.config.alpaca.expectedAccountId,
        executionEligible: false,
        executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
      },
      startCycle: noCycle,
    })
    const resolveAfterStartup: AutonomousRuntimeResolver<never, never> = (state) => {
      const decodedRequest: Result.Result<PaperActivationRequest | null, string> =
        serializedRequest === undefined
          ? Result.succeed(null)
          : decodeConfiguredPaperActivationRequest(serializedRequest)
      const validateStaticRequest: Effect.Effect<
        Result.Result<
          { readonly request: PaperActivationRequest | null; readonly evidence: RuntimeEvidence | null },
          string
        >,
        OperationalError
      > = Effect.gen(function* () {
        if (Result.isFailure(decodedRequest)) {
          yield* pendingPaperActivation(state, null, 'REQUEST_INVALID')
          return Result.fail('request-invalid')
        }
        const request = decodedRequest.success
        const current = yield* Ref.get(state)
        if (request === null) return Result.succeed({ request, evidence: current.evidence })
        const observedAt = yield* currentUtcInstant
        const validation = paperActivationRequestIsCurrent(request, observePlan, current.evidence, observedAt, true)
        if (Result.isFailure(validation)) {
          yield* pendingPaperActivation(state, request, 'PREPARATION_FAILED')
          return Result.fail(validation.failure)
        }
        return Result.succeed({ request, evidence: current.evidence })
      })
      return validateStaticRequest.pipe(
        Effect.flatMap((validated): Effect.Effect<AutonomousRuntime<never, never>, never, Scope.Scope> => {
          if (Result.isFailure(validated)) return Effect.succeed(pendingRuntime())
          const request = validated.success.request
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
                            Effect.provide(cycleResources),
                            Effect.map((loop) => loop.pipe(Effect.provide(cycleResources))),
                          )
                        const readRuntime = () => ({
                          _tag: 'AutonomousRead' as const,
                          broker: runtimeBroker(observePlan, runtimeServices.session.read, false),
                          startCycle: readStartCycle,
                        })
                        if (request === null) return Effect.succeed(readRuntime())
                        const evidence = validated.success.evidence
                        if (evidence === null) {
                          return pendingPaperActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE').pipe(
                            Effect.as(readRuntime()),
                          )
                        }
                        const prepareOrRecover = currentUtcInstant.pipe(
                          Effect.flatMap((observedAt) =>
                            observedAt >= request.cutoffAt
                              ? recoverPaperActivationGeneration(
                                  observePlan,
                                  request,
                                  evidence,
                                  runtimeServices.authorityGenerationStore,
                                ).pipe(Effect.map((generation) => ({ generation })))
                              : preparePaperActivation(observePlan, evidence, request),
                          ),
                        )
                        return prepareOrRecover.pipe(
                          Effect.flatMap((prepared) => {
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
                                } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
                                const realizedPlan = makeApplicationPlan({
                                  config: realizedConfig,
                                  protocol: observePlan.protocol,
                                  parameterHash: observePlan.parameterHash,
                                  strategy: observePlan.strategy,
                                  strategyProtocolHash: observePlan.strategyProtocolHash,
                                }) as ApplicationPlanFor<'AutonomousService'>
                                const emitClosedCycleReceipt = makeClosedCycleReceiptEmitter(
                                  realizedPlan.config,
                                  runtimeServices.pgClient,
                                  prepared.generation.generationHash,
                                  runtimeServices.forwardPerformanceReceiptStore,
                                )
                                const onClosedCycle = (cycleId: string, observedAt: string) =>
                                  emitClosedCycleReceipt(cycleId, observedAt).pipe(Effect.asVoid)
                                return makeMutation(
                                  runtimeServices.session,
                                  authority,
                                  runtimeServices.alpacaHttpClient,
                                ).pipe(
                                  Effect.flatMap((brokerMutation) =>
                                    Effect.fromResult(
                                      makeExecutionProgram(authority, {
                                        brokerRead: runtimeServices.session.read,
                                        liveCapitalGrants: runtimeServices.liveCapitalGrants,
                                        freshBrokerPrice: makeFreshBrokerPriceReader(
                                          runtimeServices.session.connection,
                                          runtimeServices.alpacaHttpClient,
                                        ),
                                        currentUtcInstant,
                                        paperEpisodeEntryExpiresAt: request.cutoffAt,
                                        paperEpisodeCloseExpiresAt: paperEpisodeCloseExpiresAt(request.expiresAt),
                                        isPaperEpisodeCloseIntent: (intentId) =>
                                          runtimeServices.paperCycleClosureStore
                                            .containsIntent(intentId)
                                            .pipe(Effect.catch(() => Effect.succeed(false))),
                                        intentStore: runtimeServices.intentStore,
                                        mutationStore: runtimeServices.mutationStore,
                                        writerFence: runtimeServices.writerFence,
                                        brokerMutation,
                                      }),
                                    ),
                                  ),
                                  Effect.mapError(executionProgramError),
                                  Effect.tap(() =>
                                    realizedPaperActivation(state, request, prepared.generation.generationHash),
                                  ),
                                  Effect.tap(() =>
                                    Effect.forkScoped(
                                      retryClosedCycleReceipts(
                                        emitClosedCycleReceipt,
                                        request.cutoffAt,
                                        paperEpisodeCloseExpiresAt(request.expiresAt),
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
                                    broker: runtimeBroker(realizedPlan, runtimeServices.session.read, true),
                                    executionProgram,
                                    startCycle: (startup: AutonomousCycleStartupInput) =>
                                      mutationCycle(
                                        realizedPlan,
                                        executionProgram,
                                        request,
                                        runtimeServices.paperCycleClosureStore,
                                        onClosedCycle,
                                      )(startup).pipe(
                                        Effect.provide(cycleResources),
                                        Effect.map((loop) => loop.pipe(Effect.provide(cycleResources))),
                                      ),
                                  })),
                                )
                              }),
                            )
                          }),
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
      operationalError('strategy', 'paper-candidate-output', 'paper candidate receipt encoding failed', cause),
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
      operationalError('strategy', 'execution-prepare-output', 'EXECUTION_PREPARE output encoding failed', cause),
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
    loadObserveRiskPolicy(plan.config.alpaca.expectedAccountId, plan.strategy.definition.parameters.universe),
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
        operationalError('config', 'execution-prepare', 'source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-prepare-policy')
    const configuredStrategy = plan.strategy.provenance.strategy
    const application = strategyApplication(plan.strategy)
    if (
      configuredStrategy.name !== application.definition.name ||
      configuredStrategy.parameterSchemaVersion !== application.definition.parameters.schemaVersion
    ) {
      return yield* Effect.fail(
        new OperationalError({
          component: 'strategy',
          operation: 'execution-prepare',
          message: 'EXECUTION_PREPARE strategy identity does not match the composed application',
          retryable: false,
          cause: { _tag: 'StrategyProtocolVersionMismatch' },
        }),
      )
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
      return yield* Effect.fail(
        new OperationalError({
          component: 'strategy',
          operation: 'execution-prepare',
          message: 'EXECUTION_PREPARE qualification evidence is unavailable',
          retryable: false,
          cause: { _tag: 'QualificationEvidenceUnavailable' },
        }),
      )
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
    Effect.provide(ExecutionPrepareValidationResourcesLive(plan)),
    Effect.flatMap((prevalidated) =>
      prepareExecutionPrepareOutput(prevalidated).pipe(
        Effect.provide(ExecutionPrepareExecutionResourcesLive(plan)),
        Effect.flatMap(writeExecutionPrepareOutput),
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
    runBrokerlessService(plan).pipe(Effect.provide(BrokerlessApplicationResourcesLive(plan))),
  ),
  Match.tag('AutonomousService', (plan) =>
    runAutonomousService(plan).pipe(Effect.provide(AutonomousApplicationResourcesLive(plan))),
  ),
  Match.tag('ExecutionCandidateDiscovery', (plan) =>
    runExecutionCandidateDiscovery(plan).pipe(Effect.provide(ExecutionCandidateDiscoveryResourcesLive(plan))),
  ),
  Match.tag('ExecutionPrepare', runExecutionPreparePlan),
  Match.exhaustive,
)
