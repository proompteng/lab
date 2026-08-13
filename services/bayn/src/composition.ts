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
  Schema,
  Semaphore,
  Scope,
  Stdio,
  Stream,
} from 'effect'

import {
  makeApplicationPlan,
  recordAutonomousCyclePass,
  runApplication,
  type ApplicationDependencies,
  type ApplicationIdentity,
  type ApplicationPlan,
  type ApplicationPlanFor,
  type AutonomousCycleStartup,
  type AutonomousCycleStartupInput,
  type AutonomousRuntime,
  type AutonomousRuntimeResolver,
} from './app'
import {
  paperObserveSuccessorGenerationHash,
  recoverTerminalGenerationToObserve,
  recoverRestrictedGenerationBeforeRollover,
  type TerminalGenerationRolloverReceipt,
} from './blocked-generation-recovery'
import { AlpacaBrokerResourcesLive } from './broker/alpaca/composition'
import {
  BrokerRead,
  BrokerSession,
  type BrokerReadShape,
  type BrokerSessionShape,
  type ReadPreflight,
} from './broker/alpaca'
import { AlpacaHttpClient } from './broker/alpaca/http'
import { BrokerMutationError, makeMutation } from './broker/alpaca-mutations'
import { BrokerEnvironment } from './broker/identity'
import type { LoadedRuntimeConfig } from './config'
import { CycleRunnerError } from './cycle/runner'
import { CycleObservability, CycleObservabilityLive, CycleStore, CycleStoreLive } from './cycle/store'
import { LifecycleCommandStore } from './db/lifecycle-command'
import { LifecycleCommandStoreLive } from './db/lifecycle-command-postgres'
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
  type PreparedCapitalGrantActivation,
} from './db/execution-store'
import { LiveCapitalGrantStore, LiveCapitalGrantStoreLive } from './db/live-capital-grant'
import { BrokerAccess, CapitalAuthorityKind, noCapitalAuthority } from './execution/authority'
import {
  Authority,
  KillState,
  type AuthorityState,
  type CapitalGrantGeneration,
  type CapitalGrantProofBinding,
  type ResearchCapitalGrantGeneration,
} from './execution/contracts'
import {
  CapitalAuthoritySelection,
  decodeCapitalActivationConfigurationResult,
  isResearchCapitalActivationRequest,
  isResearchCapitalBuildContinuation,
  researchCapitalGrantProof,
  researchCapitalBuildContinuationIsBound,
  researchCapitalGenerationIsBoundToRequest,
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type CapitalActivationRequest,
  type QualifiedCapitalActivationRequest,
  type ResearchCapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
} from './execution/configuration'
import {
  BlockedCycleIntentStore,
  BlockedCycleIntentStoreLive,
  IntentStore,
  IntentStoreLive,
  type BlockedCycleIntentStoreShape,
} from './execution/intents'
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
  decideExecutionEpisodeAuthority,
  isExecutionEpisodeFailureRestriction,
  capitalGrantFromLegacyGeneration,
  capitalGrantKey,
  validateExecutionEpisodeCloseWindow,
} from './execution/episode'
import {
  loadObserveRiskPolicy,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  executionEpisodeCloseExpiresAt,
  executionEpisodeReceiptFinalizationExpiresAt,
  interpretRecoveryFirstCycleInProcess,
  type LifecycleAdvanceDisposition,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverInterpreter,
  type RecoveryFirstRuntime,
} from './observe-composition'
import { restrictMutationAuthority } from './observe-composition/mutation-interpreter'
import { acquireKubernetesLifecycleCommandAuthenticator } from './lifecycle-command-auth'
import { serveLifecycleCommands } from './lifecycle-command-http'
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
import type { AutonomousCyclePassObservation, RuntimeEvidence, RuntimeState } from './runtime-state'
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
    BlockedCycleIntentStoreLive,
    IntentStoreLive,
    MutationStoreLive,
    LiveCapitalGrantStoreLive,
    PaperCycleClosureStorePostgresLive,
    ForwardPerformanceReceiptStoreLive,
    LifecycleCommandStoreLive,
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

export const QualifiedCapitalActivationStoreLive = (
  config: LoadedRuntimeConfig,
  sql: PgClient.PgClient,
  writerFence: WriterFenceService,
) =>
  ExecutionPrepareStoreLive(config).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(PgClient.PgClient, sql), Layer.succeed(WriterFence, writerFence))),
  )

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

export const runRestateLifecycleWithReconciliationGuardian = <A, E, R, GuardianR>(
  maintainReconciliation: Effect.Effect<void, never, R>,
  intervalMs: number,
  lifecycle: Effect.Effect<A, E, GuardianR>,
): Effect.Effect<A, E, R | GuardianR> =>
  Effect.zipWith(
    Effect.forever(maintainReconciliation.pipe(Effect.andThen(Effect.sleep(Duration.millis(intervalMs))))),
    lifecycle,
    (_guardian, result) => result,
    { concurrent: true },
  )

const lifecycleDriverInterpreter = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  store: import('./db/lifecycle-command').LifecycleCommandStoreShape,
  writerFence: WriterFenceService,
) =>
  plan.config.lifecycleOwner === 'Restate'
    ? (((driver) =>
        Effect.gen(function* () {
          const authenticate = yield* acquireKubernetesLifecycleCommandAuthenticator()
          yield* Effect.logInfo('Bayn Restate reconciliation guardian started').pipe(
            Effect.annotateLogs({
              controllerKey: plan.config.lifecycleControllerKey,
              reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
            }),
          )
          return yield* runRestateLifecycleWithReconciliationGuardian(
            driver.maintainReconciliation,
            driver.nextDelayMs,
            serveLifecycleCommands(
              {
                host: plan.config.host,
                port: plan.config.lifecycleCommandPort,
                controllerKey: plan.config.lifecycleControllerKey,
                sourceRevision: plan.config.build.sourceRevision,
                previousSourceRevision: plan.config.lifecyclePreviousSourceRevision,
                nextDelayMs: driver.nextDelayMs,
              },
              store,
              writerFence,
              authenticate,
              driver.advance,
            ),
          )
        }).pipe(Effect.scoped, Effect.orDie)) satisfies RecoveryFirstCycleDriverInterpreter)
    : undefined

const lifecycleMaintenanceCycle =
  (
    plan: ApplicationPlanFor<'AutonomousService'>,
    store: import('./db/lifecycle-command').LifecycleCommandStoreShape,
    writerFence: WriterFenceService,
    maintainReconciliation: Effect.Effect<void>,
    maintainLifecycle: Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError>,
  ): AutonomousCycleStartup<RecoveryFirstRuntime> =>
  (startup) =>
    Semaphore.make(1).pipe(
      Effect.map((operationPermit) => {
        const nextDelayMs = Math.min(plan.config.cyclePollIntervalMs, plan.config.alpaca.reconciliationIntervalMs)
        const observeSuccess = currentUtcInstant.pipe(
          Effect.flatMap((observedAt) => {
            const observation: AutonomousCyclePassObservation = {
              result: 'SUCCESS',
              observedAt,
              outcome: 'RECOVERED',
            }
            return startup.recordPass(observation).pipe(Effect.as({ observation }))
          }),
        )
        const advance = operationPermit.withPermit(
          maintainLifecycle.pipe(
            Effect.andThen(observeSuccess),
            Effect.catch((error) =>
              currentUtcInstant.pipe(
                Effect.flatMap((observedAt) => {
                  const observation: AutonomousCyclePassObservation = {
                    result: 'FAILURE',
                    observedAt,
                    operation: error.operation,
                    failure: error.failure,
                    message: error.message,
                  }
                  return startup.recordPass(observation).pipe(Effect.andThen(Effect.fail(error)))
                }),
              ),
            ),
          ),
        )
        const driver: RecoveryFirstCycleDriver = {
          advance,
          maintainReconciliation: operationPermit.withPermit(maintainReconciliation),
          nextDelayMs,
          wait: () => Effect.sleep(Duration.millis(nextDelayMs)),
        }
        return (lifecycleDriverInterpreter(plan, store, writerFence) ?? interpretRecoveryFirstCycleInProcess)(driver)
      }),
    )

export const observeCycleGenerationHash = (authority: AuthorityState): Result.Result<string, string> =>
  authority.maximum === Authority.Observe && authority.effective === Authority.Observe
    ? Result.succeed(authority.generationHash)
    : Result.fail('OBSERVE cycle startup requires current effective OBSERVE authority')

const observeCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  lifecycleCommandStore: import('./db/lifecycle-command').LifecycleCommandStoreShape,
  writerFence: WriterFenceService,
  authorityGenerationHash: string,
) => {
  const interpretCycleDriver = lifecycleDriverInterpreter(plan, lifecycleCommandStore, writerFence)
  return makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
    strategy: plan.strategy,
    ...(interpretCycleDriver === undefined ? {} : { interpretCycleDriver }),
  })
}

const mutationCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  executionProgram: ExecutionProgram,
  executionEpisode: CapitalActivationRequest,
  paperCycleClosureStore: PaperCycleClosureStoreShape,
  blockedCycleIntentStore: BlockedCycleIntentStoreShape,
  lifecycleCommandStore: import('./db/lifecycle-command').LifecycleCommandStoreShape,
  writerFence: WriterFenceService,
  onClosedCycle: (cycleId: string, observedAt: string) => Effect.Effect<void>,
  beforeLifecycleAdvance?: Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError>,
  interpretCycleDriverOverride?: RecoveryFirstCycleDriverInterpreter,
) => {
  const interpretCycleDriver =
    interpretCycleDriverOverride ?? lifecycleDriverInterpreter(plan, lifecycleCommandStore, writerFence)
  return makeMutationAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash:
      plan.config.execution.capitalAuthority._tag === CapitalAuthorityKind.Granted
        ? plan.config.execution.capitalAuthority.authorityGenerationHash
        : plan.config.alpaca.authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
    strategy: plan.strategy,
    ...(isResearchCapitalActivationRequest(executionEpisode) ? { cycleCadence: 'PAPER_BOOTSTRAP' as const } : {}),
    executionProgram,
    paperCycleClosureStore,
    blockedCycleIntentStore,
    onClosedCycle,
    executionEpisodeCutoffAt: executionEpisode.cutoffAt,
    executionEpisodeCloseSubmitCutoffAt: executionEpisode.expiresAt,
    executionEpisodeExpiresAt: executionEpisodeCloseExpiresAt(executionEpisode.expiresAt),
    ...(beforeLifecycleAdvance === undefined ? {} : { beforeLifecycleAdvance }),
    ...(interpretCycleDriver === undefined ? {} : { interpretCycleDriver }),
  })
}

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

const capitalActivationOperationalError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'capital-activation',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'CapitalActivationPreparationRejected' } : cause,
  })

export const activatePreparedQualifiedCapitalGeneration = (
  lifecycle: Pick<CapitalGrantLifecycleStoreShape, 'activatePreparedCapitalGrant'>,
  proof: CapitalGrantProofBinding,
  prepared: PreparedCapitalGrantActivation,
): Effect.Effect<AuthorityState, OperationalError> =>
  Effect.gen(function* () {
    const activated = yield* lifecycle
      .activatePreparedCapitalGrant(proof, prepared)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('qualified capital generation activation failed', cause),
        ),
      )
    if (
      activated.generationHash !== prepared.generationHash ||
      activated.maximum !== Authority.Paper ||
      (activated.kill === KillState.Clear && activated.effective !== Authority.Paper) ||
      (activated.kill === KillState.Active && activated.effective !== Authority.Observe)
    ) {
      return yield* capitalActivationOperationalError(
        'qualified capital authority does not match the prepared generation',
      )
    }
    return activated
  })

interface ConfiguredCapitalActivation {
  readonly request: CapitalActivationRequest
  readonly buildContinuation: ResearchCapitalBuildContinuation | null
}

const decodeConfiguredCapitalActivation = (serialized: string): Result.Result<ConfiguredCapitalActivation, string> => {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch {
    return Result.fail('configured capital activation is not valid JSON')
  }
  const decoded = decodeCapitalActivationConfigurationResult(value)
  return Result.isFailure(decoded)
    ? Result.fail('configured capital activation failed its canonical schema and hash validation')
    : isResearchCapitalBuildContinuation(decoded.success)
      ? Result.succeed({ request: decoded.success.request, buildContinuation: decoded.success })
      : Result.succeed({ request: decoded.success, buildContinuation: null })
}

const readOnlyExecutionPolicy = (plan: ApplicationPlanFor<'AutonomousService'>): ReadOnlyExecutionPolicy => ({
  brokerIdentity: plan.config.alpaca.identity,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: noCapitalAuthority,
})

const capitalActivationRequestIsCurrent = (
  request: CapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence | null,
  observedAt: string,
  options: {
    readonly allowCloseRecovery?: boolean
    readonly buildContinuation?: ResearchCapitalBuildContinuation | null
  } = {},
): Result.Result<void, string> => {
  if (options.allowCloseRecovery !== true && (request.expiresAt <= observedAt || request.cutoffAt <= observedAt)) {
    return Result.fail('capital activation request is expired or past its immutable cutoff')
  }
  if (request.strategy.protocolHash !== plan.strategyProtocolHash) {
    return Result.fail('capital activation request strategy protocol does not match the current strategy')
  }
  const strategy = plan.strategy.provenance.strategy
  if (
    request.strategy.name !== strategy.name ||
    request.strategy.behaviorHash !== strategy.behaviorHash ||
    request.strategy.parameterHash !== strategy.parameterHash ||
    request.strategy.parameterSchemaVersion !== strategy.parameterSchemaVersion
  ) {
    return Result.fail('capital activation request strategy identity does not match the current strategy')
  }
  const requestBuildIsCurrent =
    request.activation.sourceRevision === plan.config.build.sourceRevision &&
    request.activation.imageRepository === plan.config.build.imageRepository &&
    request.activation.imageDigest === plan.config.build.imageDigest
  const continuationBuildIsCurrent =
    isResearchCapitalActivationRequest(request) &&
    options.buildContinuation !== null &&
    options.buildContinuation !== undefined &&
    options.buildContinuation.request.requestHash === request.requestHash &&
    options.buildContinuation.activation.sourceRevision === plan.config.build.sourceRevision &&
    options.buildContinuation.activation.imageRepository === plan.config.build.imageRepository &&
    options.buildContinuation.activation.imageDigest === plan.config.build.imageDigest
  if (!requestBuildIsCurrent && !continuationBuildIsCurrent) {
    return Result.fail('capital activation request is not bound to the current activation build')
  }
  if (isResearchCapitalActivationRequest(request)) {
    if (
      request.broker.environment !== BrokerEnvironment.Sandbox ||
      request.broker.accountId !== plan.config.alpaca.expectedAccountId ||
      request.broker.identityHash !== plan.config.alpaca.identity.identityHash
    ) {
      return Result.fail('research capital request broker identity does not match the configured sandbox account')
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
    return Result.fail('capital activation request does not match the recovered qualification result')
  }
  if (evidence.qualification.verdict !== 'QUALIFIED' || evidence.qualification.evaluationVerdict.status !== 'PASS') {
    return Result.fail('capital activation request requires a qualified economic result')
  }
  if (
    evidence.provenance.sourceRevision !== request.qualification.sourceRevision ||
    evidence.provenance.image.repository !== request.qualification.imageRepository ||
    evidence.provenance.image.digest !== request.qualification.imageDigest
  ) {
    return Result.fail('capital activation request does not match the durable qualification provenance')
  }
  return Result.succeed(undefined)
}

const internalExecutionPlan = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  mode: 'ExecutionCandidateDiscovery' | 'ExecutionPrepare',
  request: QualifiedCapitalActivationRequest,
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

const buildCapitalActivationPrepareRequest = (
  request: QualifiedCapitalActivationRequest,
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

const capitalGenerationIsBoundToRequest = (
  request: QualifiedCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  generation: CapitalGrantGeneration,
): Result.Result<void, string> => {
  if (generation.maximum !== 'PAPER') return Result.fail('execution PREPARE did not return a mutation generation')
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

type CapitalAuthorityGeneration = CapitalGrantGeneration | ResearchCapitalGrantGeneration

const preparedCapitalActivationIsBound = (
  request: QualifiedCapitalActivationRequest,
  plan: ApplicationPlanFor<'AutonomousService'>,
  prepared: ExecutionPrepareOutput,
): Result.Result<void, string> => {
  const { generation, preflight } = prepared
  const binding = capitalGenerationIsBoundToRequest(request, plan, generation)
  if (Result.isFailure(binding)) return binding
  if (preflight.environment !== BrokerEnvironment.Sandbox) return Result.fail('execution PREPARE broker is not sandbox')
  if (preflight.accountId !== plan.config.alpaca.expectedAccountId) {
    return Result.fail('execution PREPARE broker account does not match the configured account')
  }
  if (
    preflight.openOrderCount !== request.limits.maxOpenOrders ||
    preflight.positionCount !== request.limits.maxPositions
  ) {
    return Result.fail('execution PREPARE broker preflight is not an empty order book and position set')
  }
  return Result.succeed(undefined)
}

const readBoundCapitalActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError(
        'durable capital recovery requires authority history read capabilities',
      )
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('durable capital authority read failed', cause)),
    )
    if (authority.maximum !== Authority.Paper) {
      return yield* capitalActivationOperationalError('durable capital recovery requires mutation-capable authority')
    }
    const closeAuthorityIsBound =
      (authority.effective === Authority.Paper && authority.kill === KillState.Clear) ||
      (authority.effective === Authority.Observe && authority.kill === KillState.Active)
    if (!closeAuthorityIsBound) {
      return yield* capitalActivationOperationalError(
        'durable capital recovery requires clear mutation or active OBSERVE close authority',
      )
    }
    if (isResearchCapitalActivationRequest(request)) {
      if (authorityStore.readResearchAuthorityGeneration === undefined) {
        return yield* capitalActivationOperationalError(
          'durable research capital recovery requires v3 authority history reads',
        )
      }
      const generation = yield* authorityStore
        .readResearchAuthorityGeneration(authority.generationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('durable capital generation read failed', cause),
          ),
        )
      if (generation === undefined) {
        return yield* capitalActivationOperationalError('durable research capital history is missing')
      }
      const binding =
        buildContinuation === null
          ? researchCapitalGenerationIsBoundToRequest(request, generation.previousGenerationHash, generation)
          : researchCapitalBuildContinuationIsBound(
              buildContinuation,
              generation.previousGenerationHash,
              generation,
              plan.config.build,
            )
      yield* Effect.fromResult(binding).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
      return generation
    }
    if (authorityStore.readAuthorityGeneration === undefined) {
      return yield* capitalActivationOperationalError(
        'durable qualified capital recovery requires v2 authority history reads',
      )
    }
    const generation = yield* authorityStore
      .readAuthorityGeneration(authority.generationHash)
      .pipe(
        Effect.mapError((cause) => capitalActivationOperationalError('durable capital generation read failed', cause)),
      )
    if (generation === undefined) {
      return yield* capitalActivationOperationalError('durable qualified capital history is missing')
    }
    yield* Effect.fromResult(capitalGenerationIsBoundToRequest(request, plan, generation)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    return generation
  })

export interface CompletedExecutionLifecycle {
  readonly authorityGenerationHash: string
  readonly receiptHash: string
}

export const readCompletedExecutionLifecycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  authorityStore: AuthorityGenerationStoreShape,
  readReceiptHash: (authorityGenerationHash: string) => Effect.Effect<Option.Option<string>, OperationalError>,
): Effect.Effect<CompletedExecutionLifecycle | undefined, OperationalError> =>
  Effect.gen(function* () {
    if (
      authorityStore.readAuthorityState === undefined ||
      authorityStore.readAuthorityGenerationLineage === undefined
    ) {
      return undefined
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('completed execution lifecycle authority read failed', cause),
      ),
    )
    if (
      authority.maximum !== Authority.Observe ||
      authority.effective !== Authority.Observe ||
      authority.kill !== KillState.Clear
    ) {
      return undefined
    }
    const lineage = yield* authorityStore
      .readAuthorityGenerationLineage(authority.generationHash)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('completed execution lifecycle lineage read failed', cause),
        ),
      )
    if (
      lineage === undefined ||
      lineage.generationHash !== authority.generationHash ||
      lineage.maximum !== Authority.Observe ||
      lineage.previousGenerationHash === null
    ) {
      return undefined
    }

    const previousGenerationHash = lineage.previousGenerationHash
    let generation: CapitalAuthorityGeneration | undefined
    let binding: Result.Result<void, string>
    if (isResearchCapitalActivationRequest(request)) {
      if (authorityStore.readResearchAuthorityGeneration === undefined) return undefined
      generation = yield* authorityStore
        .readResearchAuthorityGeneration(previousGenerationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('completed research capital generation read failed', cause),
          ),
        )
      if (generation === undefined) return undefined
      binding =
        buildContinuation === null
          ? researchCapitalGenerationIsBoundToRequest(request, generation.previousGenerationHash, generation)
          : researchCapitalBuildContinuationIsBound(
              buildContinuation,
              generation.previousGenerationHash,
              generation,
              plan.config.build,
            )
    } else {
      if (authorityStore.readAuthorityGeneration === undefined) return undefined
      generation = yield* authorityStore
        .readAuthorityGeneration(previousGenerationHash)
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('completed qualified capital generation read failed', cause),
          ),
        )
      if (generation === undefined) return undefined
      binding = capitalGenerationIsBoundToRequest(request, plan, generation)
    }
    if (Result.isFailure(binding)) return undefined

    const expectedSuccessorHash = yield* Effect.fromResult(
      paperObserveSuccessorGenerationHash({ previousPaperGenerationHash: generation.generationHash }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('completed execution lifecycle successor hashing failed', cause),
      ),
    )
    if (expectedSuccessorHash !== authority.generationHash) {
      return yield* capitalActivationOperationalError(
        'completed execution lifecycle OBSERVE successor does not match the terminal capital generation',
      )
    }
    const receiptHash = yield* readReceiptHash(generation.generationHash)
    return Option.match(receiptHash, {
      onNone: () => undefined,
      onSome: (hash) => ({ authorityGenerationHash: generation.generationHash, receiptHash: hash }),
    })
  })

export const recoverCapitalActivationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(
      capitalActivationRequestIsCurrent(request, plan, evidence, observedAt, {
        allowCloseRecovery: true,
        buildContinuation,
      }),
    ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
    const closeExpiresAt = executionEpisodeCloseExpiresAt(request.expiresAt)
    if (observedAt >= closeExpiresAt) {
      yield* restrictExpiredCapitalActivation(authorityRestrictionStore, writerFence)
      return yield* capitalActivationOperationalError(
        'durable capital close recovery is outside its immutable close lease',
      )
    }
    if (observedAt < request.cutoffAt) {
      return yield* capitalActivationOperationalError(
        'durable capital close recovery is outside its immutable close lease',
      )
    }
    return yield* readBoundCapitalActivationGeneration(plan, request, buildContinuation, authorityStore)
  })

const recoverCapitalReceiptFinalizationGeneration = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: CapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  evidence: RuntimeEvidence | null,
  authorityStore: AuthorityGenerationStoreShape,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(
      capitalActivationRequestIsCurrent(request, plan, evidence, observedAt, {
        allowCloseRecovery: true,
        buildContinuation,
      }),
    ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
    if (observedAt < executionEpisodeCloseExpiresAt(request.expiresAt)) {
      return yield* capitalActivationOperationalError(
        'durable capital receipt finalization is outside its bounded lease',
      )
    }
    yield* restrictExpiredCapitalActivation(authorityRestrictionStore, writerFence)
    return yield* readBoundCapitalActivationGeneration(plan, request, buildContinuation, authorityStore)
  })

type CapitalActivationStartupResolution =
  | { readonly _tag: 'ReceiptFinalization'; readonly generation: CapitalAuthorityGeneration }
  | { readonly _tag: 'Mutation'; readonly generation: CapitalAuthorityGeneration }

const prepareCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: QualifiedCapitalActivationRequest,
  runtimeSql: PgClient.PgClient,
  runtimeWriterFence: WriterFenceService,
): Effect.Effect<ExecutionPrepareOutput, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, evidence, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
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
        capitalActivationOperationalError('source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const riskPolicyHash = yield* policyHash(riskPolicy, 'execution-candidate-policy').pipe(
      Effect.mapError((cause) => capitalActivationOperationalError(cause.message, cause)),
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
        capitalActivationOperationalError('execution candidate discovery resource failed', cause),
      ),
    )
    const prepareRequest = yield* Effect.fromResult(
      buildCapitalActivationPrepareRequest(request, evidence, discoveryReceipt),
    ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
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
      Effect.mapError((cause) => capitalActivationOperationalError('execution PREPARE validation failed', cause)),
    )
    const prepared = yield* prepareExecutionPrepareOutput(validated).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic PREPARE execution boundary owns this layer
      Effect.provide(ExecutionPrepareExecutionResourcesLive(prepareConfig as ApplicationPlanFor<'ExecutionPrepare'>)),
      Effect.mapError((cause) => capitalActivationOperationalError('execution PREPARE resource failed', cause)),
    )
    yield* Effect.fromResult(preparedCapitalActivationIsBound(request, plan, prepared)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    const authenticated = yield* authenticateValidatedExecutionPrepare(
      validated,
      validated.request.discoveryReceipt,
    ).pipe(
      Effect.mapError(executionPrepareOperationalError),
      Effect.mapError((cause) =>
        capitalActivationOperationalError('execution activation proof validation failed', cause),
      ),
    )
    const activationPolicy = yield* Effect.fromResult(
      resolveExecutionPolicy({
        brokerIdentity: plan.config.alpaca.identity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: CapitalAuthoritySelection.Sandbox,
        authorityGenerationHash: prepared.generation.generationHash,
        liveCapitalGrantHash: undefined,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('qualified capital activation policy is invalid', cause),
      ),
    )
    const activationConfig = {
      ...prepareConfig.config,
      execution: activationPolicy,
      alpaca: {
        ...prepareConfig.config.alpaca,
        authorityGenerationHash: prepared.generation.generationHash,
      },
    } as LoadedRuntimeConfig
    yield* Effect.flatMap(CapitalGrantLifecycleStore, (lifecycle) =>
      activatePreparedQualifiedCapitalGeneration(lifecycle, authenticated.proof, {
        generationHash: prepared.generation.generationHash,
        sourceGenerationHash: plan.config.alpaca.authorityGenerationHash,
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- dynamic qualified activation boundary owns this layer
      Effect.provide(QualifiedCapitalActivationStoreLive(activationConfig, runtimeSql, runtimeWriterFence)),
      Effect.mapError((cause) =>
        cause instanceof OperationalError
          ? cause
          : capitalActivationOperationalError('qualified capital activation resource failed', cause),
      ),
    )
    return prepared
  })

export const prepareOrRecoverQualifiedCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  evidence: RuntimeEvidence,
  request: QualifiedCapitalActivationRequest,
  authorityStore: AuthorityGenerationStoreShape,
  prepare: Effect.Effect<ExecutionPrepareOutput, OperationalError>,
): Effect.Effect<CapitalAuthorityGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, evidence, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError(
        'qualified capital startup requires durable authority state reads',
      )
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('qualified capital authority read failed', cause)),
    )
    if (authority.maximum === Authority.Paper) {
      return yield* readBoundCapitalActivationGeneration(plan, request, null, authorityStore)
    }
    return (yield* prepare).generation
  })

const validateResearchCapitalPreflight = (
  request: ResearchCapitalActivationRequest,
  preflight: ReadPreflight,
): Result.Result<void, string> =>
  preflight.environment === BrokerEnvironment.Sandbox &&
  preflight.accountId === request.broker.accountId &&
  preflight.openOrderCount === request.limits.maxOpenOrders &&
  preflight.positionCount === request.limits.maxPositions
    ? Result.succeed(undefined)
    : Result.fail('research capital preflight requires the exact empty sandbox account')

const validateResearchCapitalRiskPolicy = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
): Effect.Effect<void, OperationalError> =>
  loadObserveRiskPolicy(request.broker.accountId, plan.strategy.definition.parameters.universe).pipe(
    Effect.mapError((cause) =>
      capitalActivationOperationalError('source-controlled capital risk policy is invalid', cause),
    ),
    Effect.flatMap((riskPolicy) => policyHash(riskPolicy, 'execution-candidate-policy')),
    Effect.mapError((cause) => capitalActivationOperationalError(cause.message, cause)),
    Effect.flatMap((currentRiskPolicyHash) =>
      currentRiskPolicyHash === request.riskPolicyHash
        ? Effect.void
        : Effect.fail(
            capitalActivationOperationalError('research capital request is not bound to the current risk policy'),
          ),
    ),
  )

const validateResearchCapitalCloseLease = (
  request: ResearchCapitalActivationRequest,
  session: BrokerSessionShape,
): Effect.Effect<void, OperationalError> => {
  const requestedRange = { start: request.cutoffAt.slice(0, 10), end: request.expiresAt.slice(0, 10) }
  return session.read.marketCalendar(requestedRange).pipe(
    Effect.mapError((cause) => capitalActivationOperationalError('research capital close calendar read failed', cause)),
    Effect.flatMap((calendar) =>
      calendar.value.requestedRange.start === requestedRange.start &&
      calendar.value.requestedRange.end === requestedRange.end
        ? Effect.succeed(calendar.value.sessions)
        : Effect.fail(
            capitalActivationOperationalError('research capital close calendar did not cover the requested lease'),
          ),
    ),
    Effect.flatMap((sessions) =>
      Effect.fromResult(
        validateExecutionEpisodeCloseWindow({
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
        : capitalActivationOperationalError(`research capital close lease is invalid: ${cause._tag}`, cause),
    ),
    Effect.asVoid,
  )
}

const validateActivatedResearchAuthority = (authority: AuthorityState): Result.Result<void, string> =>
  authority.maximum === Authority.Paper && authority.effective === Authority.Paper && authority.kill === KillState.Clear
    ? Result.succeed(undefined)
    : Result.fail('research capital activation did not return clear effective mutation authority')

const readCurrentResearchCapitalGeneration = (
  authority: AuthorityState,
  authorityStore: AuthorityGenerationStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration | undefined, OperationalError> => {
  if (authority.maximum !== Authority.Paper) return Effect.as(Effect.void, undefined)
  if (authorityStore.readResearchAuthorityGeneration === undefined) {
    return Effect.fail(
      capitalActivationOperationalError('research capital startup requires v3 authority history reads'),
    )
  }
  return authorityStore.readResearchAuthorityGeneration(authority.generationHash).pipe(
    Effect.mapError((cause) => capitalActivationOperationalError('research capital generation read failed', cause)),
    Effect.flatMap((generation) =>
      generation === undefined
        ? Effect.fail(capitalActivationOperationalError('durable research capital history is missing'))
        : Effect.succeed(generation),
    ),
  )
}

const prepareResearchCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
  sourceGenerationHash: string,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    yield* Effect.fromResult(capitalActivationRequestIsCurrent(request, plan, null, observedAt)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    yield* Effect.fromResult(validateResearchCapitalPreflight(request, session.preflight)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    yield* validateResearchCapitalRiskPolicy(plan, request)
    yield* validateResearchCapitalCloseLease(request, session)

    const proof = researchCapitalGrantProof(request)
    const authority = yield* lifecycle
      .activateResearchCapitalGrant(proof, sourceGenerationHash)
      .pipe(
        Effect.mapError((cause) =>
          capitalActivationOperationalError('research capital generation activation failed', cause),
        ),
      )
    yield* Effect.fromResult(validateActivatedResearchAuthority(authority)).pipe(
      Effect.mapError((message) => capitalActivationOperationalError(message)),
    )
    return yield* readBoundCapitalActivationGeneration(plan, request, null, authorityStore).pipe(
      Effect.flatMap((generation) =>
        generation.schemaVersion === 'bayn.paper-authority-generation.v3'
          ? Effect.succeed(generation)
          : Effect.fail(capitalActivationOperationalError('research capital activation loaded qualified history')),
      ),
    )
  })

const refreshResearchCapitalActivationReconciliationDataFirst = <E, R>(
  reconcile: Effect.Effect<unknown, E, R>,
  operationTimeoutMs: number,
): Effect.Effect<void, OperationalError, R> =>
  reconcile.pipe(
    Effect.timeoutOrElse({
      duration: operationTimeoutMs,
      orElse: () =>
        Effect.fail(capitalActivationOperationalError('research capital pre-activation reconciliation timed out')),
    }),
    Effect.mapError((cause) =>
      capitalActivationOperationalError('research capital pre-activation reconciliation failed', cause),
    ),
    Effect.asVoid,
  )

export const refreshResearchCapitalActivationReconciliation = Pipeable.generic<
  <E, R>(
    operationTimeoutMs: number,
  ) => (reconcile: Effect.Effect<unknown, E, R>) => Effect.Effect<void, OperationalError, R>,
  typeof refreshResearchCapitalActivationReconciliationDataFirst
>(2, refreshResearchCapitalActivationReconciliationDataFirst)

export const prepareOrRecoverResearchCapitalActivation = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  request: ResearchCapitalActivationRequest,
  buildContinuation: ResearchCapitalBuildContinuation | null,
  session: BrokerSessionShape,
  authorityStore: AuthorityGenerationStoreShape,
  lifecycle: CapitalGrantLifecycleStoreShape,
  reconcile: Effect.Effect<unknown, ReconciliationPassError | OperationalError>,
  operationTimeoutMs: number,
): Effect.Effect<ResearchCapitalGrantGeneration, OperationalError> =>
  Effect.gen(function* () {
    if (authorityStore.readAuthorityState === undefined) {
      return yield* capitalActivationOperationalError('research capital startup requires durable authority state reads')
    }
    const authority = yield* authorityStore.readAuthorityState.pipe(
      Effect.mapError((cause) => capitalActivationOperationalError('research capital authority read failed', cause)),
    )
    const currentGeneration = yield* readCurrentResearchCapitalGeneration(authority, authorityStore)
    const currentSourceGenerationHash = currentGeneration?.previousGenerationHash ?? authority.generationHash
    if (authority.maximum === Authority.Observe) {
      const replayed = yield* authorityStore
        .ensureAuthorityGeneration({ generationHash: authority.generationHash, maximum: Authority.Observe })
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('research capital current OBSERVE generation validation failed', cause),
          ),
        )
      if (
        replayed.generationHash !== authority.generationHash ||
        replayed.maximum !== authority.maximum ||
        replayed.effective !== authority.effective ||
        replayed.kill !== authority.kill ||
        replayed.version !== authority.version
      ) {
        return yield* capitalActivationOperationalError(
          'research capital current OBSERVE generation changed during validation',
        )
      }
    }
    const currentGenerationMatchesRequest =
      currentGeneration !== undefined &&
      Result.isSuccess(
        buildContinuation === null
          ? researchCapitalGenerationIsBoundToRequest(request, currentSourceGenerationHash, currentGeneration)
          : researchCapitalBuildContinuationIsBound(
              buildContinuation,
              currentSourceGenerationHash,
              currentGeneration,
              plan.config.build,
            ),
      )
    const decision = yield* Effect.fromResult(
      decideExecutionEpisodeAuthority({
        generationHash: authority.generationHash,
        sourceGenerationHash: currentSourceGenerationHash,
        currentGenerationMatchesRequest,
        maximum: authority.maximum,
        effective: authority.effective,
        kill: authority.kill,
        ...(authority.reason === undefined ? {} : { reason: authority.reason }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        capitalActivationOperationalError('research capital authority does not match this episode', cause),
      ),
    )
    if (buildContinuation !== null && decision._tag !== 'Resume' && decision._tag !== 'ResumeRestricted') {
      return yield* capitalActivationOperationalError(
        'research capital build continuation requires the exact active generation',
      )
    }
    const activationRequired = decision._tag === 'Activate' || decision._tag === 'Rearm'
    const activationSourceGenerationHash =
      decision._tag === 'Rearm'
        ? yield* Effect.fromResult(
            paperObserveSuccessorGenerationHash({
              previousPaperGenerationHash: authority.generationHash,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              capitalActivationOperationalError('research capital OBSERVE successor hashing failed', cause),
            ),
          )
        : currentSourceGenerationHash
    if (activationRequired) {
      // PostgreSQL requires broker evidence observed after the previous authority update. It must exist before a
      // completed capital generation is rearmed, and the same observation then binds the new activation.
      yield* refreshResearchCapitalActivationReconciliation(reconcile, operationTimeoutMs)
    }
    if (decision._tag === 'Rearm') {
      const rearmed = yield* authorityStore
        .ensureAuthorityGeneration({
          generationHash: activationSourceGenerationHash,
          maximum: Authority.Observe,
        })
        .pipe(
          Effect.mapError((cause) =>
            capitalActivationOperationalError('research capital source authority rearm failed', cause),
          ),
        )
      if (
        rearmed.generationHash !== activationSourceGenerationHash ||
        rearmed.maximum !== Authority.Observe ||
        rearmed.effective !== Authority.Observe ||
        rearmed.kill !== KillState.Clear
      ) {
        return yield* capitalActivationOperationalError(
          'research capital source authority rearm did not return clear OBSERVE',
        )
      }
    }
    if (activationRequired) {
      return yield* prepareResearchCapitalActivation(
        plan,
        request,
        activationSourceGenerationHash,
        session,
        authorityStore,
        lifecycle,
      )
    }
    const generation =
      currentGeneration ?? (yield* capitalActivationOperationalError('research capital recovery lost durable history'))
    if (buildContinuation !== null) {
      const restricted = decision._tag === 'ResumeRestricted'
      yield* Effect.logInfo(
        restricted
          ? 'Bayn capital build continuation resumed a restricted active generation for recovery'
          : 'Bayn capital build continuation resumed the active generation',
      ).pipe(
        Effect.annotateLogs({
          service: 'bayn',
          activationMode: restricted ? 'RECOVERY_ONLY' : 'ACTIVE',
          continuationHash: buildContinuation.continuationHash,
          generationHash: generation.generationHash,
          sourceRevision: plan.config.build.sourceRevision,
          imageDigest: plan.config.build.imageDigest,
          ...(restricted ? { authorityReason: authority.reason ?? 'unknown' } : {}),
        }),
      )
    }
    return generation
  })

const pendingCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest | null,
  reason: Extract<NonNullable<RuntimeState['capitalActivation']>, { readonly _tag: 'Pending' }>['reason'],
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: { _tag: 'Pending' as const, requestHash: request?.requestHash ?? null, reason },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'CAPITAL_ACTIVATION_NOT_PREPARED',
          },
    error: null,
  }))

const realizedCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest,
  generationHash: string,
  grant: 'Qualified' | 'Research',
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Realized' as const,
      requestHash: request.requestHash,
      generationHash,
      grant,
      cutoffAt: request.cutoffAt,
      expiresAt: request.expiresAt,
      maximumCloseSessions: isResearchCapitalActivationRequest(request) ? request.maximumCloseSessions : null,
    },
    broker:
      current.broker === null ? null : { ...current.broker, executionEligible: true, executionDisabledReason: null },
    error: null,
  }))

const completedCapitalActivation = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest,
  generationHash: string,
  receiptHash: string,
): Effect.Effect<void> =>
  Ref.update(state, (current) => ({
    ...current,
    capitalActivation: {
      _tag: 'Completed' as const,
      requestHash: request.requestHash,
      generationHash,
      grant: isResearchCapitalActivationRequest(request) ? ('Research' as const) : ('Qualified' as const),
      receiptHash,
    },
    broker:
      current.broker === null
        ? null
        : {
            ...current.broker,
            executionEligible: false,
            executionDisabledReason: 'EXECUTION_EPISODE_COMPLETED',
          },
    error: null,
  }))

const restrictExpiredCapitalActivationDataFirst = (
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
): Effect.Effect<void, OperationalError> =>
  restrictMutationAuthority('PAPER activation lease', 'immutable activation request expired').pipe(
    Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
    Effect.provideService(WriterFence, writerFence),
    Effect.mapError((cause) => capitalActivationOperationalError('expired capital restriction failed', cause)),
  )

export const restrictExpiredCapitalActivation = Pipeable.dual(2, restrictExpiredCapitalActivationDataFirst)

export type ExecutionLifecycleMaintenanceDecision = {
  readonly restrictExpiredAuthority: boolean
  readonly attemptReceiptFinalization: boolean
}

export const decideExecutionLifecycleMaintenance = (input: {
  readonly cutoffAt: string
  readonly closeExpiresAt: string
  readonly finalizationExpiresAt: string
  readonly observedAt: string
}): ExecutionLifecycleMaintenanceDecision => {
  const observedMs = Date.parse(input.observedAt)
  const cutoffMs = Date.parse(input.cutoffAt)
  const closeExpiresMs = Date.parse(input.closeExpiresAt)
  const finalizationExpiresMs = Date.parse(input.finalizationExpiresAt)
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(cutoffMs) ||
    !Number.isFinite(closeExpiresMs) ||
    !Number.isFinite(finalizationExpiresMs)
  ) {
    return { restrictExpiredAuthority: true, attemptReceiptFinalization: false }
  }
  return {
    restrictExpiredAuthority: observedMs >= closeExpiresMs,
    attemptReceiptFinalization: observedMs >= cutoffMs && observedMs <= finalizationExpiresMs,
  }
}

export const runExecutionLifecycleMaintenance = (
  request: CapitalActivationRequest,
  authorityRestrictionStore: AuthorityRestrictionStoreShape,
  writerFence: WriterFenceService,
  finalizeReceipt: (cycleId: string | undefined, observedAt: string) => Effect.Effect<boolean, CycleRunnerError>,
): Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError> =>
  currentUtcInstant.pipe(
    Effect.flatMap((observedAt) => {
      const decision = decideExecutionLifecycleMaintenance({
        cutoffAt: request.cutoffAt,
        closeExpiresAt: executionEpisodeCloseExpiresAt(request.expiresAt),
        finalizationExpiresAt: executionEpisodeReceiptFinalizationExpiresAt(request.expiresAt),
        observedAt,
      })
      const restrict = decision.restrictExpiredAuthority
        ? restrictMutationAuthority('PAPER activation lease', 'immutable activation request expired').pipe(
            Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
            Effect.provideService(WriterFence, writerFence),
          )
        : Effect.void
      return restrict.pipe(
        Effect.andThen(
          decision.attemptReceiptFinalization
            ? finalizeReceipt(undefined, observedAt).pipe(
                Effect.map((completed) => (completed ? ('COMPLETED' as const) : ('CONTINUE' as const))),
              )
            : Effect.succeed('CONTINUE' as const),
        ),
      )
    }),
  )

const completeExecutionLifecycle = <A, E, R, RolloverR>(
  finalization: Effect.Effect<boolean, E, R>,
  rollover: Effect.Effect<A, OperationalError, RolloverR>,
): Effect.Effect<boolean, E | CycleRunnerError, R | RolloverR> =>
  finalization.pipe(
    Effect.flatMap((finalized) =>
      finalized
        ? rollover.pipe(
            Effect.mapError(
              (cause) =>
                new CycleRunnerError({
                  operation: 'recover-cycle',
                  failure: 'operational',
                  message: 'terminal execution generation rollover failed',
                  cause,
                }),
            ),
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
  )

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

const finalizeExecutionEpisodeDataFirst = (
  state: Ref.Ref<RuntimeState>,
  request: CapitalActivationRequest,
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
            Effect.andThen(completedCapitalActivation(state, request, generationHash, receiptHash)),
            Effect.as(true),
          ),
    ),
    Effect.catch((cause) =>
      Effect.logError('Bayn execution episode finalization failed').pipe(
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

export const finalizeExecutionEpisode = Pipeable.dual(8, finalizeExecutionEpisodeDataFirst)

const closedCycleReceiptEmissionAllowedDataFirst = (cutoffAt: string, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(cutoffAt)

export const closedCycleReceiptEmissionAllowed = Pipeable.dual(2, closedCycleReceiptEmissionAllowedDataFirst)

const capitalReceiptFinalizationWindowOpenDataFirst = (authorityExpiresAt: string, observedAt: string): boolean => {
  const observedMs = Date.parse(observedAt)
  const closeExpiresMs = Date.parse(executionEpisodeCloseExpiresAt(authorityExpiresAt))
  const finalizationExpiresMs = Date.parse(executionEpisodeReceiptFinalizationExpiresAt(authorityExpiresAt))
  return Number.isFinite(observedMs) && observedMs >= closeExpiresMs && observedMs < finalizationExpiresMs
}

export const capitalReceiptFinalizationWindowOpen = Pipeable.dual(2, capitalReceiptFinalizationWindowOpenDataFirst)

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
    const serializedRequest = observePlan.config.capitalActivationRequestJson
    const decodedActivation: Result.Result<ConfiguredCapitalActivation | null, string> =
      serializedRequest === undefined ? Result.succeed(null) : decodeConfiguredCapitalActivation(serializedRequest)
    const startupEvidenceMode =
      Result.isSuccess(decodedActivation) &&
      decodedActivation.success !== null &&
      isResearchCapitalActivationRequest(decodedActivation.success.request)
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
            readonly request: CapitalActivationRequest | null
            readonly buildContinuation: ResearchCapitalBuildContinuation | null
            readonly evidence: RuntimeEvidence | null
          },
          string
        >,
        OperationalError
      > = Effect.gen(function* () {
        if (Result.isFailure(decodedActivation)) {
          yield* pendingCapitalActivation(state, null, 'REQUEST_INVALID')
          return Result.fail('request-invalid')
        }
        const configured = decodedActivation.success
        const request = configured?.request ?? null
        const buildContinuation = configured?.buildContinuation ?? null
        const current = yield* Ref.get(state)
        if (request === null) return Result.succeed({ request, buildContinuation, evidence: current.evidence })
        const observedAt = yield* currentUtcInstant
        const validation = capitalActivationRequestIsCurrent(request, observePlan, current.evidence, observedAt, {
          allowCloseRecovery: true,
          buildContinuation,
        })
        if (Result.isFailure(validation)) {
          yield* pendingCapitalActivation(state, request, 'PREPARATION_FAILED')
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
                      blockedCycleIntentStore: BlockedCycleIntentStore,
                      lifecycleCommandStore: LifecycleCommandStore,
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
                          Effect.gen(function* () {
                            if (runtimeServices.authorityGenerationStore.readAuthorityState === undefined) {
                              return yield* capitalActivationOperationalError(
                                'OBSERVE cycle startup requires durable authority state reads',
                              )
                            }
                            const authority = yield* runtimeServices.authorityGenerationStore.readAuthorityState.pipe(
                              Effect.mapError((cause) =>
                                capitalActivationOperationalError('OBSERVE cycle startup authority read failed', cause),
                              ),
                            )
                            const authorityGenerationHash = yield* Effect.fromResult(
                              observeCycleGenerationHash(authority),
                            ).pipe(Effect.mapError((message) => capitalActivationOperationalError(message)))
                            return yield* observeCycle(
                              observePlan,
                              runtimeServices.lifecycleCommandStore,
                              runtimeServices.writerFence,
                              authorityGenerationHash,
                            )(startup)
                          }).pipe(
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
                            request !== null && isResearchCapitalActivationRequest(request)
                              ? ('Research' as const)
                              : ('Qualification' as const),
                          broker: runtimeBroker(observePlan, runtimeServices.session.read, false),
                          ...(request !== null && isResearchCapitalActivationRequest(request)
                            ? { cycleBindingId: null, cycleObservationId: request.grant.planHash }
                            : {}),
                          startCycle: readStartCycle,
                        })
                        const recoverBlockedGeneration = recoverTerminalGenerationToObserve({
                          accountId: observePlan.config.alpaca.expectedAccountId,
                          blockedIntents: runtimeServices.blockedCycleIntentStore,
                          authorityStore: runtimeServices.authorityGenerationStore,
                          writerFence: runtimeServices.writerFence,
                          reconcileAfterSettlement: refreshResearchCapitalActivationReconciliation(
                            runOnce.pipe(
                              // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                              Effect.provide(cycleResources),
                            ),
                            observePlan.config.operationTimeoutMs,
                          ),
                        })
                        const recoverTerminalExecutionGeneration: Effect.Effect<
                          TerminalGenerationRolloverReceipt,
                          OperationalError
                        > = recoverBlockedGeneration.pipe(
                          Effect.flatMap(
                            (receipt): Effect.Effect<TerminalGenerationRolloverReceipt, OperationalError> => {
                              if (receipt._tag === 'RolledOver') return Effect.succeed(receipt)
                              if (runtimeServices.authorityGenerationStore.readAuthorityState === undefined) {
                                return Effect.fail(
                                  capitalActivationOperationalError(
                                    'terminal execution rollover requires durable authority state reads',
                                  ),
                                )
                              }
                              return runtimeServices.authorityGenerationStore.readAuthorityState.pipe(
                                Effect.mapError((cause) =>
                                  capitalActivationOperationalError(
                                    'terminal execution rollover authority read failed',
                                    cause,
                                  ),
                                ),
                                Effect.flatMap((authority) =>
                                  authority.maximum === Authority.Observe &&
                                  authority.effective === Authority.Observe &&
                                  authority.kill === KillState.Clear
                                    ? Effect.succeed(receipt)
                                    : Effect.fail(
                                        capitalActivationOperationalError(
                                          'terminal execution rollover did not reach clear OBSERVE authority',
                                        ),
                                      ),
                                ),
                              )
                            },
                          ),
                        )
                        if (request === null) return recoverBlockedGeneration.pipe(Effect.as(readRuntime()))
                        const completedLifecycle = readCompletedExecutionLifecycle(
                          observePlan,
                          request,
                          buildContinuation,
                          runtimeServices.authorityGenerationStore,
                          (authorityGenerationHash) =>
                            runtimeServices.forwardPerformanceReceiptStore.read(authorityGenerationHash).pipe(
                              Effect.mapError((cause) =>
                                capitalActivationOperationalError(
                                  'completed execution lifecycle receipt read failed',
                                  cause,
                                ),
                              ),
                              Effect.map(Option.map((receipt) => receipt.receiptHash)),
                            ),
                        )
                        const evidence = validated.success.evidence
                        if (evidence === null && !isResearchCapitalActivationRequest(request)) {
                          return recoverBlockedGeneration.pipe(
                            Effect.andThen(pendingCapitalActivation(state, request, 'STARTUP_EVIDENCE_UNAVAILABLE')),
                            Effect.as(readRuntime()),
                          )
                        }
                        const prepareOrRecover: Effect.Effect<CapitalActivationStartupResolution, OperationalError> =
                          currentUtcInstant.pipe(
                            Effect.flatMap(
                              (observedAt): Effect.Effect<CapitalActivationStartupResolution, OperationalError> =>
                                observedAt >= executionEpisodeCloseExpiresAt(request.expiresAt)
                                  ? recoverCapitalReceiptFinalizationGeneration(
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
                                    ? recoverCapitalActivationGeneration(
                                        observePlan,
                                        request,
                                        buildContinuation,
                                        evidence,
                                        runtimeServices.authorityGenerationStore,
                                        runtimeServices.authorityRestrictionStore,
                                        runtimeServices.writerFence,
                                      ).pipe(Effect.map((generation) => ({ _tag: 'Mutation' as const, generation })))
                                    : isResearchCapitalActivationRequest(request)
                                      ? prepareOrRecoverResearchCapitalActivation(
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
                                            capitalActivationOperationalError(
                                              'qualified capital activation evidence is unavailable',
                                            ),
                                          )
                                        : prepareOrRecoverQualifiedCapitalActivation(
                                            observePlan,
                                            evidence,
                                            request,
                                            runtimeServices.authorityGenerationStore,
                                            prepareCapitalActivation(
                                              observePlan,
                                              evidence,
                                              request,
                                              runtimeServices.pgClient,
                                              runtimeServices.writerFence,
                                            ),
                                          ).pipe(
                                            Effect.map((generation) => ({ _tag: 'Mutation' as const, generation })),
                                          ),
                            ),
                          )
                        const resolveReceiptFinalization = (
                          prepared: Extract<
                            CapitalActivationStartupResolution,
                            { readonly _tag: 'ReceiptFinalization' }
                          >,
                        ): Effect.Effect<AutonomousRuntime<never, never>, OperationalError, Scope.Scope> => {
                          const emitClosedCycleReceipt = makeClosedCycleReceiptEmitter(
                            observePlan.config,
                            runtimeServices.pgClient,
                            prepared.generation.generationHash,
                            runtimeServices.forwardPerformanceReceiptStore,
                          )
                          const finalizeClosedCycleReceipt = (cycleId: string | undefined, observedAt: string) =>
                            finalizeExecutionEpisode(
                              state,
                              request,
                              prepared.generation.generationHash,
                              runtimeServices.authorityRestrictionStore,
                              runtimeServices.writerFence,
                              emitClosedCycleReceipt,
                              cycleId,
                              observedAt,
                            )
                          const finalizeExecutionLifecycleReceipt = (cycleId: string | undefined, observedAt: string) =>
                            completeExecutionLifecycle(
                              finalizeClosedCycleReceipt(cycleId, observedAt),
                              recoverTerminalExecutionGeneration,
                            )
                          return Effect.gen(function* () {
                            yield* pendingCapitalActivation(state, request, 'REQUEST_EXPIRED')
                            const observedAt = yield* currentUtcInstant
                            if (!capitalReceiptFinalizationWindowOpen(request.expiresAt, observedAt)) {
                              const existing = yield* runtimeServices.forwardPerformanceReceiptStore
                                .read(prepared.generation.generationHash)
                                .pipe(
                                  Effect.mapError((cause) =>
                                    capitalActivationOperationalError(
                                      'durable capital receipt recovery read failed',
                                      cause,
                                    ),
                                  ),
                                )
                              if (Option.isSome(existing)) {
                                yield* completeExecutionLifecycle(
                                  finalizeExecutionEpisode(
                                    state,
                                    request,
                                    prepared.generation.generationHash,
                                    runtimeServices.authorityRestrictionStore,
                                    runtimeServices.writerFence,
                                    () => Effect.succeed(existing.value.receiptHash),
                                    existing.value.cycleId,
                                    observedAt,
                                  ),
                                  recoverTerminalExecutionGeneration,
                                ).pipe(
                                  Effect.mapError((cause) =>
                                    capitalActivationOperationalError(
                                      'durable capital receipt terminal rollover failed',
                                      cause,
                                    ),
                                  ),
                                )
                              }
                              return readRuntime()
                            }
                            const maintainReconciliation = runOnce.pipe(
                              // @effect-diagnostics-next-line strictEffectProvide:off -- value-only reconciliation services have no resource lifetime
                              Effect.provide(cycleResources),
                              Effect.asVoid,
                              Effect.catch((cause) =>
                                Effect.logError('Bayn receipt-finalization reconciliation guardian failed', cause),
                              ),
                            )
                            const maintainLifecycle = runExecutionLifecycleMaintenance(
                              request,
                              runtimeServices.authorityRestrictionStore,
                              runtimeServices.writerFence,
                              finalizeExecutionLifecycleReceipt,
                            )
                            const startCycle: AutonomousCycleStartup = (startup) =>
                              lifecycleMaintenanceCycle(
                                observePlan,
                                runtimeServices.lifecycleCommandStore,
                                runtimeServices.writerFence,
                                maintainReconciliation,
                                maintainLifecycle,
                              )(startup).pipe(
                                // @effect-diagnostics-next-line strictEffectProvide:off -- value-only lifecycle services have no resource lifetime
                                Effect.provide(cycleResources),
                                Effect.map((loop) =>
                                  loop.pipe(
                                    // @effect-diagnostics-next-line strictEffectProvide:off -- value-only lifecycle services have no resource lifetime
                                    Effect.provide(cycleResources),
                                  ),
                                ),
                              )
                            return {
                              ...readRuntime(),
                              cycleBindingId: prepared.generation.generationHash,
                              cycleObservationId: prepared.generation.generationHash,
                              startCycle,
                            }
                          })
                        }
                        const resolvePrepared = (
                          prepared: CapitalActivationStartupResolution,
                        ): Effect.Effect<AutonomousRuntime<never, never>, OperationalError, Scope.Scope> => {
                          if (runtimeServices.authorityGenerationStore.readAuthorityState === undefined) {
                            return Effect.fail(
                              capitalActivationOperationalError(
                                'capital startup recovery requires durable authority state reads',
                              ),
                            )
                          }
                          return runtimeServices.authorityGenerationStore.readAuthorityState.pipe(
                            Effect.mapError((cause) =>
                              capitalActivationOperationalError(
                                'capital startup recovery authority read failed',
                                cause,
                              ),
                            ),
                            Effect.flatMap((authorityState) => {
                              const restricted =
                                authorityState.generationHash === prepared.generation.generationHash &&
                                authorityState.maximum === Authority.Paper &&
                                authorityState.effective === Authority.Observe &&
                                authorityState.kill === KillState.Active &&
                                isExecutionEpisodeFailureRestriction(authorityState.reason)
                              if (prepared._tag === 'ReceiptFinalization' && !restricted) {
                                return resolveReceiptFinalization(prepared)
                              }
                              if (observePlan.config.alpaca.identity.environment !== BrokerEnvironment.Sandbox) {
                                return Effect.fail(
                                  capitalActivationOperationalError(
                                    'research capital activation requires a sandbox broker',
                                  ),
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
                                  capitalActivationOperationalError(
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
                                      capitalActivationOperationalError(
                                        'prepared sandbox execution policy is invalid',
                                        realizedPolicy.failure,
                                      ),
                                    )
                                  }
                                  const realizedConfig = {
                                    ...observePlan.config,
                                    execution: realizedPolicy.success,
                                    ...(isResearchCapitalActivationRequest(request)
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
                                  const capitalGrant = capitalGrantFromLegacyGeneration(prepared.generation)
                                  const cycleBindingId = capitalGrantKey(capitalGrant)
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
                                    finalizeExecutionEpisode(
                                      state,
                                      request,
                                      prepared.generation.generationHash,
                                      runtimeServices.authorityRestrictionStore,
                                      runtimeServices.writerFence,
                                      emitClosedCycleReceipt,
                                      cycleId,
                                      observedAt,
                                    )
                                  const finalizeExecutionLifecycleReceipt = (
                                    cycleId: string | undefined,
                                    observedAt: string,
                                  ) =>
                                    completeExecutionLifecycle(
                                      finalizeClosedCycleReceipt(cycleId, observedAt),
                                      recoverTerminalExecutionGeneration,
                                    )
                                  const onClosedCycle = (cycleId: string, observedAt: string) =>
                                    closedCycleReceiptEmissionAllowed(request.cutoffAt, observedAt)
                                      ? finalizeClosedCycleReceipt(cycleId, observedAt).pipe(Effect.asVoid)
                                      : Effect.void
                                  const maintainExecutionLifecycle = runExecutionLifecycleMaintenance(
                                    request,
                                    runtimeServices.authorityRestrictionStore,
                                    runtimeServices.writerFence,
                                    finalizeExecutionLifecycleReceipt,
                                  )
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
                                              currentUtcInstant,
                                              entrySubmitExpiresAt: request.cutoffAt,
                                              closeSubmitExpiresAt: executionEpisodeCloseExpiresAt(request.expiresAt),
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
                                    Effect.flatMap((executionProgram) => {
                                      const startCycle = (
                                        startup: AutonomousCycleStartupInput,
                                        interpretCycleDriver?: RecoveryFirstCycleDriverInterpreter,
                                      ) =>
                                        mutationCycle(
                                          realizedPlan,
                                          executionProgram,
                                          request,
                                          runtimeServices.paperCycleClosureStore,
                                          runtimeServices.blockedCycleIntentStore,
                                          runtimeServices.lifecycleCommandStore,
                                          runtimeServices.writerFence,
                                          onClosedCycle,
                                          maintainExecutionLifecycle,
                                          interpretCycleDriver,
                                        )(startup).pipe(
                                          // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                          Effect.provide(cycleResources),
                                          Effect.map((loop) =>
                                            loop.pipe(
                                              // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                              Effect.provide(cycleResources),
                                            ),
                                          ),
                                        )
                                      const runtime = {
                                        _tag: 'AutonomousMutation' as const,
                                        startupEvidenceMode: isResearchCapitalActivationRequest(request)
                                          ? ('Research' as const)
                                          : ('Qualification' as const),
                                        broker: runtimeBroker(realizedPlan, runtimeServices.session.read, true),
                                        cycleBindingId,
                                        cycleObservationId: cycleBindingId,
                                        executionProgram,
                                        startCycle,
                                      }
                                      const activate = realizedCapitalActivation(
                                        state,
                                        request,
                                        prepared.generation.generationHash,
                                        capitalGrant._tag,
                                      ).pipe(Effect.as(runtime))
                                      if (!restricted) return activate

                                      const recover: RecoveryFirstCycleDriverInterpreter = (driver) =>
                                        recoverRestrictedGenerationBeforeRollover({
                                          advance: driver.advance,
                                          wait: driver.wait,
                                          settle: recoverBlockedGeneration,
                                        }).pipe(
                                          Effect.asVoid,
                                          Effect.catch((cause) => Effect.die(cause)),
                                        )
                                      return startCycle(
                                        {
                                          qualificationRunId: cycleBindingId,
                                          recordPass: (observation) => recordAutonomousCyclePass(state, observation),
                                        },
                                        recover,
                                      ).pipe(
                                        Effect.flatMap((loop) => loop),
                                        Effect.andThen(prepareOrRecover),
                                        Effect.flatMap(resolvePrepared),
                                      )
                                    }),
                                  )
                                }),
                              )
                            }),
                          )
                        }
                        return completedLifecycle.pipe(
                          Effect.flatMap(
                            (
                              completed,
                            ): Effect.Effect<AutonomousRuntime<never, never>, OperationalError, Scope.Scope> => {
                              if (completed === undefined) {
                                return prepareOrRecover.pipe(Effect.flatMap(resolvePrepared))
                              }
                              return completedCapitalActivation(
                                state,
                                request,
                                completed.authorityGenerationHash,
                                completed.receiptHash,
                              ).pipe(Effect.as(readRuntime()))
                            },
                          ),
                          Effect.catch((cause) =>
                            Effect.logWarning('Bayn capital activation remains in OBSERVE').pipe(
                              Effect.annotateLogs({
                                service: 'bayn',
                                activation: 'PENDING',
                                reason: cause instanceof Error ? cause.message : String(cause),
                              }),
                              Effect.andThen(
                                pendingCapitalActivation(state, request, 'PREPARATION_FAILED').pipe(
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
              Effect.logWarning('Bayn capital activation remains in OBSERVE').pipe(
                Effect.annotateLogs({
                  service: 'bayn',
                  activation: 'PENDING',
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
                Effect.andThen(
                  request === null
                    ? Effect.succeed(pendingRuntime())
                    : pendingCapitalActivation(state, request, 'PREPARATION_FAILED').pipe(Effect.as(pendingRuntime())),
                ),
              ),
            ),
          )
        }),
        Effect.catch((cause) =>
          Effect.logWarning('Bayn capital activation remains in OBSERVE').pipe(
            Effect.annotateLogs({
              service: 'bayn',
              activation: 'PENDING',
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
            Effect.andThen(
              pendingCapitalActivation(state, null, 'PREPARATION_FAILED').pipe(Effect.as(pendingRuntime())),
            ),
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
        operation: 'execution-candidate-output',
        message: 'execution candidate receipt encoding failed',
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
  operation: 'execution-candidate-policy' | 'execution-prepare-policy',
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
    Effect.flatMap((policy) => policyHash(policy, 'execution-candidate-policy')),
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
