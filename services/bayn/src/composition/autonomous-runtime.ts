import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Layer, Option, Ref, Result, Scope } from 'effect'
import {
  makeApplicationPlan,
  recordAutonomousCyclePass,
  type ApplicationPlanFor,
  type AutonomousCycleStartup,
  type AutonomousCycleStartupInput,
  type AutonomousRuntime,
  type AutonomousRuntimeResolver,
} from '../app'
import {
  advanceRestrictedGenerationRecovery,
  recoverTerminalGenerationToObserve,
  type TerminalGenerationRolloverReceipt,
} from '../blocked-generation-recovery'
import { BrokerRead, BrokerSession } from '../broker/alpaca'
import { AlpacaHttpClient } from '../broker/alpaca/http'
import { makeMutation } from '../broker/alpaca-mutations'
import type { LoadedRuntimeConfig } from '../config'
import { CycleStore } from '../cycle/store'
import { ForwardPerformanceReceiptStore } from '../db/forward-performance-receipt'
import { ExecutionCycleClosureStore } from '../db/execution-cycle-closure'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  CapitalGrantLifecycleStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from '../db/execution-store'
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { BrokerAccess } from '../execution/authority'
import { Authority, KillState } from '../execution/contracts'
import {
  capitalActivationRequiresQualificationEvidence,
  isResearchCapitalActivationRequest,
  type CapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
} from '../execution/configuration'
import { BlockedCycleIntentStore, IntentStore } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import { makeExecutionProgram } from '../execution/runtime-program'
import { resolvePreparedExecutionAuthority, resolvePreparedExecutionPolicy } from '../execution/runtime-authority'
import { WriterFence } from '../execution/writer-fence'
import { OperationalError } from '../errors'
import { MarketData } from '../market-data'
import {
  isExecutionEpisodeFailureRestriction,
  capitalGrantFromLegacyGeneration,
  capitalGrantKey,
} from '../execution/episode'
import {
  loadObserveRiskPolicy,
  executionEpisodeCloseExpiresAt,
  type RecoveryFirstCycleDriverInterpreter,
} from '../observe-composition'
import { runOnce } from '../reconciler'
import { currentUtcInstant } from '../time'
import type { RuntimeEvidence } from '../runtime-state'
import { scopedAcquisition } from '../resource-boundary'
import { AutonomousRuntimeResourcesLive, applicationDependencies } from './resources'
import {
  executionProgramError,
  lifecycleMaintenanceCycle,
  mutationCycle,
  observeCycle,
  observeCycleGenerationHash,
  runtimeBroker,
} from './lifecycle'
import {
  capitalActivationOperationalError,
  capitalActivationRequestIsCurrent,
  capitalReceiptFinalizationWindowOpen,
  closedCycleReceiptEmissionAllowed,
  completeExecutionLifecycle,
  completedCapitalActivation,
  decodeConfiguredCapitalActivation,
  finalizeExecutionEpisode,
  makeClosedCycleReceiptEmitter,
  pendingCapitalActivation,
  prepareCapitalActivation,
  prepareOrRecoverQualifiedCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readCompletedExecutionLifecycle,
  readOnlyExecutionPolicy,
  realizedCapitalActivation,
  recoverCapitalActivationGeneration,
  recoverCapitalReceiptFinalizationGeneration,
  refreshResearchCapitalActivationReconciliation,
  runExecutionLifecycleMaintenance,
  type CapitalActivationStartupResolution,
  type ConfiguredCapitalActivation,
} from './capital-activation'

export interface AutonomousServiceRuntimeOptions {
  readonly interpretCycleDriver: RecoveryFirstCycleDriverInterpreter
}

export const makeAutonomousServiceRuntime = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  options: AutonomousServiceRuntimeOptions,
) =>
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
    const serializedRequest = plan.config.capitalActivationRequestJson
    const decodedActivation: Result.Result<ConfiguredCapitalActivation | null, string> =
      serializedRequest === undefined ? Result.succeed(null) : decodeConfiguredCapitalActivation(serializedRequest)
    const requiresQualificationEvidence =
      Result.isSuccess(decodedActivation) &&
      decodedActivation.success !== null &&
      capitalActivationRequiresQualificationEvidence(decodedActivation.success.request)
    const noCycle = (
      _startup: AutonomousCycleStartupInput,
    ): Effect.Effect<Effect.Effect<void, never, never>, OperationalError, never> => Effect.succeed(Effect.never)
    const pendingRuntime = () => ({
      _tag: 'AutonomousRead' as const,
      requiresQualificationEvidence,
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
        if (request === null) {
          if (plan.config.execution.brokerAccess === BrokerAccess.Mutation) {
            yield* pendingCapitalActivation(state, null, 'REQUEST_INVALID')
            return Result.fail('configured granted capital requires an immutable execution episode request')
          }
          return Result.succeed({ request, buildContinuation, evidence: current.evidence })
        }
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
                      persistedCapitalGrants: PersistedCapitalGrantStore,
                      intentStore: IntentStore,
                      blockedCycleIntentStore: BlockedCycleIntentStore,
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
                      executionCycleClosureStore: ExecutionCycleClosureStore,
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
                          Layer.succeed(ExecutionCycleClosureStore, runtimeServices.executionCycleClosureStore),
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
                              authorityGenerationHash,
                              options.interpretCycleDriver,
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
                          requiresQualificationEvidence: capitalActivationRequiresQualificationEvidence(request),
                          broker: runtimeBroker(observePlan, runtimeServices.session.read, false),
                          ...(request !== null && isResearchCapitalActivationRequest(request)
                            ? { cycleBindingId: null, cycleObservationId: request.grant.planHash }
                            : {}),
                          startCycle: readStartCycle,
                        })
                        const readCurrentObserveRuntime = (): Effect.Effect<
                          AutonomousRuntime<never, never>,
                          OperationalError
                        > => {
                          if (runtimeServices.authorityGenerationStore.readOrInitializeObserveAuthority === undefined) {
                            return Effect.fail(
                              capitalActivationOperationalError(
                                'OBSERVE runtime startup requires durable authority initialization',
                              ),
                            )
                          }
                          return runtimeServices.authorityGenerationStore
                            .readOrInitializeObserveAuthority({
                              generationHash: observePlan.config.alpaca.authorityGenerationHash,
                              maximum: Authority.Observe,
                            })
                            .pipe(
                              Effect.mapError((cause) =>
                                capitalActivationOperationalError(
                                  'OBSERVE runtime authority initialization failed',
                                  cause,
                                ),
                              ),
                              Effect.flatMap((authority) =>
                                Effect.fromResult(observeCycleGenerationHash(authority)).pipe(
                                  Effect.mapError((message) => capitalActivationOperationalError(message)),
                                ),
                              ),
                              Effect.map((cycleBindingId) => ({
                                ...readRuntime(),
                                requiresQualificationEvidence: false,
                                cycleBindingId,
                                cycleObservationId: cycleBindingId,
                              })),
                            )
                        }
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
                        if (request === null) {
                          return recoverBlockedGeneration.pipe(Effect.andThen(readCurrentObserveRuntime()))
                        }
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
                                maintainReconciliation,
                                maintainLifecycle,
                                options.interpretCycleDriver,
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
                                authorityState.maximum === Authority.Execution &&
                                authorityState.effective === Authority.Observe &&
                                authorityState.kill === KillState.Active &&
                                isExecutionEpisodeFailureRestriction(authorityState.reason)
                              if (prepared._tag === 'ReceiptFinalization' && !restricted) {
                                return resolveReceiptFinalization(prepared)
                              }
                              const realizedPolicy = resolvePreparedExecutionPolicy({
                                configured: plan.config.execution,
                                brokerIdentity: plan.config.alpaca.identity,
                                preparedGenerationHash: prepared.generation.generationHash,
                              })
                              if (Result.isFailure(realizedPolicy)) {
                                return Effect.fail(
                                  capitalActivationOperationalError(
                                    'prepared execution policy is invalid',
                                    realizedPolicy.failure,
                                  ),
                                )
                              }
                              const realizedConfig = {
                                ...plan.config,
                                execution: realizedPolicy.success,
                                ...(isResearchCapitalActivationRequest(request)
                                  ? { qualificationRunId: request.grant.planHash }
                                  : {}),
                              } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
                              const realizedPlan = makeApplicationPlan({
                                config: realizedConfig,
                                protocol: plan.protocol,
                                parameterHash: plan.parameterHash,
                                strategy: plan.strategy,
                                strategyProtocolHash: plan.strategyProtocolHash,
                              }) as ApplicationPlanFor<'AutonomousService'>
                              return currentUtcInstant.pipe(
                                Effect.flatMap((observedAt) =>
                                  resolvePreparedExecutionAuthority({
                                    executionPolicy: realizedPolicy.success,
                                    brokerIdentity: realizedPlan.config.alpaca.identity,
                                    strategy: realizedPlan.strategy.provenance.strategy,
                                    observedAt,
                                    readPersistedCapitalGrant: runtimeServices.persistedCapitalGrants.read,
                                  }),
                                ),
                                Effect.mapError((cause) =>
                                  capitalActivationOperationalError('prepared execution authority is invalid', cause),
                                ),
                                Effect.flatMap((authority) => {
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
                                              persistedCapitalGrants: runtimeServices.persistedCapitalGrants,
                                              riskPolicy,
                                              currentUtcInstant,
                                              entrySubmitExpiresAt: request.cutoffAt,
                                              closeSubmitExpiresAt: executionEpisodeCloseExpiresAt(request.expiresAt),
                                              isCloseOnlyIntent: (intentId) =>
                                                runtimeServices.executionCycleClosureStore
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
                                          runtimeServices.executionCycleClosureStore,
                                          runtimeServices.blockedCycleIntentStore,
                                          onClosedCycle,
                                          maintainExecutionLifecycle,
                                          interpretCycleDriver ?? options.interpretCycleDriver,
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
                                        requiresQualificationEvidence:
                                          capitalActivationRequiresQualificationEvidence(request),
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
                                        Deferred.make<void>().pipe(
                                          Effect.flatMap((rolledOver) => {
                                            const externallyOwnedDriver = {
                                              ...driver,
                                              advance: advanceRestrictedGenerationRecovery(
                                                driver.advance,
                                                recoverBlockedGeneration,
                                              ).pipe(
                                                Effect.catch((cause) =>
                                                  cause instanceof OperationalError
                                                    ? Effect.die(cause)
                                                    : Effect.fail(cause),
                                                ),
                                                Effect.tap((step) =>
                                                  step._tag === 'RolledOver'
                                                    ? Deferred.succeed(rolledOver, undefined)
                                                    : Effect.void,
                                                ),
                                                Effect.map((step) => step.advance),
                                              ),
                                            }
                                            return Effect.raceFirst(
                                              options
                                                .interpretCycleDriver(externallyOwnedDriver)
                                                .pipe(Effect.andThen(Effect.never)),
                                              Deferred.await(rolledOver),
                                            )
                                          }),
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
    return {
      dependencies,
      runtime: {
        ...pendingRuntime(),
        resolveAfterStartup,
      },
    }
  })
