import { Deferred, Effect, Layer, Ref, Result, Scope } from 'effect'
import {
  makeApplicationPlan,
  recordAutonomousCyclePass,
  type ApplicationPlanFor,
  type AutonomousCycleDriverStartup,
  type AutonomousCycleStartup,
  type AutonomousCycleStartupInput,
  type AutonomousRuntime,
  type AutonomousRuntimeResolver,
} from '../app'
import {
  advanceRestrictedGenerationRecovery,
  recognizeRestrictedGenerationRebind,
  recoverTerminalGenerationToObserve,
} from '../blocked-generation-recovery'
import { makeMutation } from '../broker/alpaca-mutations'
import type { LoadedRuntimeConfig } from '../config'
import { readFinalExecutionRiskContext } from '../db/reconciliation'
import { BrokerAccess } from '../execution/authority'
import { Authority, KillState, type ResearchCapitalGrantGeneration } from '../execution/contracts'
import {
  type ResearchCapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
  type ResearchCapitalBuildLineage,
} from '../execution/configuration'
import { makeExecutionProgram } from '../execution/runtime-program'
import { resolvePreparedExecutionAuthority, resolvePreparedExecutionPolicy } from '../execution/runtime-authority'
import { OperationalError } from '../errors'
import {
  capitalGrantFromLegacyGeneration,
  capitalGrantKey,
  isExecutionMandateRecoveryRestriction,
} from '../execution/mandate'
import {
  loadStrategyExecutionRiskPolicy,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
  type RecoveryFirstRuntime,
} from '../observe-composition'
import { runOnce } from '../reconciler'
import { currentUtcInstant } from '../time'
import type { RuntimeState } from '../runtime-state'
import { scopedAcquisition } from '../resource-boundary'
import { autonomousRuntimeServices, makeAutonomousCycleResources } from './autonomous-runtime-resources'
import { AutonomousRuntimeResourcesLive, applicationDependencies } from './resources'
import {
  executionProgramError,
  mutationCycle,
  observeCycle,
  observeCycleGenerationHash,
  runtimeBroker,
} from './lifecycle'
import {
  capitalActivationOperationalError,
  decodeConfiguredCapitalActivation,
  pendingCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readOnlyExecutionPolicy,
  realizedCapitalActivation,
  researchCapitalRecoveryRequestIsCompatible,
  refreshResearchCapitalActivationReconciliation,
  type ConfiguredCapitalActivation,
} from './capital-activation'

export interface AutonomousServiceRuntimeOptions {
  readonly ownCycleDriver: RecoveryFirstCycleDriverOwner
}

export const recoverPendingCapitalActivationToObserve = (
  state: Ref.Ref<RuntimeState>,
  request: ResearchCapitalActivationRequest,
  currentObserveRuntime: Effect.Effect<AutonomousRuntime<never, never>, OperationalError>,
  unavailableRuntime: AutonomousRuntime<never, never>,
): Effect.Effect<AutonomousRuntime<never, never>> =>
  pendingCapitalActivation(state, request, 'PREPARATION_FAILED').pipe(
    Effect.andThen(currentObserveRuntime.pipe(Effect.orElseSucceed(() => unavailableRuntime))),
  )

const ownCycleDriverStartup =
  <StartupR, DriverR>(
    startup: AutonomousCycleDriverStartup<RecoveryFirstCycleDriver, StartupR, DriverR>,
    owner: RecoveryFirstCycleDriverOwner,
  ): AutonomousCycleStartup<StartupR, DriverR | RecoveryFirstRuntime> =>
  (input) =>
    startup(input).pipe(Effect.map((driver) => driver.pipe(Effect.flatMap(owner))))

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
      parameterHash: plan.parameterHash,
      strategy: plan.strategy,
      strategyProtocolHash: plan.strategyProtocolHash,
    }) as ApplicationPlanFor<'AutonomousService'>
    const serializedRequest = plan.config.capitalActivationRequestJson
    const decodedActivation: Result.Result<ConfiguredCapitalActivation | null, string> =
      serializedRequest === undefined
        ? Result.succeed(null)
        : decodeConfiguredCapitalActivation(serializedRequest, plan.config.researchCapitalBuildLineageJson)
    const noCycle = (
      _startup: AutonomousCycleStartupInput,
    ): Effect.Effect<Effect.Effect<void, never, never>, OperationalError, never> => Effect.succeed(Effect.never)
    const pendingRuntime = () => ({
      _tag: 'AutonomousRead' as const,
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
            readonly request: ResearchCapitalActivationRequest | null
            readonly buildContinuation: ResearchCapitalBuildContinuation | null
            readonly buildLineage: ResearchCapitalBuildLineage | null
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
        const buildLineage = configured?.buildLineage ?? null
        if (request === null) {
          if (plan.config.execution.brokerAccess === BrokerAccess.Mutation) {
            yield* pendingCapitalActivation(state, null, 'REQUEST_INVALID')
            return Result.fail('configured granted capital requires an immutable execution mandate request')
          }
          return Result.succeed({ request, buildContinuation, buildLineage })
        }
        const validation = researchCapitalRecoveryRequestIsCompatible(request, observePlan)
        if (Result.isFailure(validation)) {
          yield* pendingCapitalActivation(state, request, 'PREPARATION_FAILED')
          return Result.fail(validation.failure)
        }
        return Result.succeed({ request, buildContinuation, buildLineage })
      })
      return validateStaticRequest.pipe(
        Effect.flatMap((validated): Effect.Effect<AutonomousRuntime<never, never>, never, Scope.Scope> => {
          if (Result.isFailure(validated)) return Effect.succeed(pendingRuntime())
          const request = validated.success.request
          const buildContinuation = validated.success.buildContinuation
          const buildLineage = validated.success.buildLineage
          return Effect.flatMap(Scope.Scope, (scope) =>
            scopedAcquisition(
              (attemptScope) =>
                Layer.buildWithMemoMap(
                  Layer.fresh(AutonomousRuntimeResourcesLive(observePlan)),
                  Layer.makeMemoMapUnsafe(),
                  attemptScope,
                ).pipe(
                  Effect.flatMap((runtimeContext) =>
                    autonomousRuntimeServices.pipe(
                      Effect.flatMap((runtimeServices) => {
                        const cycleResources = makeAutonomousCycleResources(runtimeServices, dependencies.marketData)
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
                            return yield* ownCycleDriverStartup(
                              observeCycle(observePlan, authorityGenerationHash, dependencies.intradayMarketData),
                              options.ownCycleDriver,
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
                        const readRuntime = (): AutonomousRuntime<never, never> => ({
                          _tag: 'AutonomousRead' as const,
                          broker: runtimeBroker(observePlan, runtimeServices.session.read, false),
                          ...(request === null ? {} : { cycleBindingId: null }),
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
                                cycleBindingId,
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
                        if (request === null) {
                          return recoverBlockedGeneration.pipe(Effect.andThen(readCurrentObserveRuntime()))
                        }
                        const prepareOrRecover = prepareOrRecoverResearchCapitalActivation(
                          observePlan,
                          request,
                          buildContinuation,
                          buildLineage,
                          runtimeServices.session,
                          runtimeServices.authorityGenerationStore,
                          runtimeServices.capitalGrantLifecycleStore,
                          runOnce.pipe(
                            // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                            Effect.provide(cycleResources),
                          ),
                          observePlan.config.operationTimeoutMs,
                        )
                        const resolvePrepared = (
                          generation: ResearchCapitalGrantGeneration,
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
                                authorityState.generationHash === generation.generationHash &&
                                authorityState.maximum === Authority.Execution &&
                                authorityState.effective === Authority.Observe &&
                                authorityState.kill === KillState.Active &&
                                isExecutionMandateRecoveryRestriction(authorityState.reason)
                              const realizedPolicy = resolvePreparedExecutionPolicy({
                                configured: plan.config.execution,
                                brokerIdentity: plan.config.alpaca.identity,
                                preparedGenerationHash: generation.generationHash,
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
                              } as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>
                              const realizedPlan = makeApplicationPlan({
                                config: realizedConfig,
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
                                  const capitalGrant = capitalGrantFromLegacyGeneration(generation)
                                  const cycleBindingId = capitalGrantKey(capitalGrant)
                                  return makeMutation(
                                    runtimeServices.session,
                                    authority,
                                    runtimeServices.alpacaHttpClient,
                                  ).pipe(
                                    Effect.mapError(executionProgramError),
                                    Effect.flatMap((brokerMutation) =>
                                      loadStrategyExecutionRiskPolicy(
                                        realizedPlan.config.alpaca.expectedAccountId,
                                        realizedPlan.strategy,
                                      ).pipe(
                                        Effect.mapError((cause) =>
                                          capitalActivationOperationalError(
                                            'source-controlled execution risk policy is invalid',
                                            cause,
                                          ),
                                        ),
                                        Effect.flatMap((riskPolicy) =>
                                          Effect.fromResult(
                                            makeExecutionProgram(authority, {
                                              brokerRead: runtimeServices.session.read,
                                              persistedCapitalGrants: runtimeServices.persistedCapitalGrants,
                                              riskPolicy,
                                              readFinalExecutionRiskContext: (observedAt) =>
                                                readFinalExecutionRiskContext(
                                                  runtimeServices.pgClient,
                                                  realizedPlan.config.alpaca.expectedAccountId,
                                                  observedAt,
                                                ),
                                              currentUtcInstant,
                                              isCloseOnlyIntent: (intentId) =>
                                                runtimeServices.executionCycleClosureStore.containsIntent(intentId),
                                              intentStore: runtimeServices.intentStore,
                                              mutationStore: runtimeServices.mutationStore,
                                              writerFence: runtimeServices.writerFence,
                                              brokerMutation,
                                            }),
                                          ).pipe(Effect.mapError(executionProgramError)),
                                        ),
                                      ),
                                    ),
                                    Effect.flatMap((executionProgram) => {
                                      const startCycle = (
                                        startup: AutonomousCycleStartupInput,
                                        owner: RecoveryFirstCycleDriverOwner = options.ownCycleDriver,
                                      ) =>
                                        ownCycleDriverStartup(
                                          mutationCycle(
                                            realizedPlan,
                                            executionProgram,
                                            runtimeServices.executionCycleClosureStore,
                                            runtimeServices.blockedCycleIntentStore,
                                            dependencies.intradayMarketData,
                                            restricted ? 'RecoveryOnly' : 'Mutation',
                                          ),
                                          owner,
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
                                        broker: runtimeBroker(realizedPlan, runtimeServices.session.read, true),
                                        cycleBindingId,
                                        executionProgram,
                                        startCycle,
                                      }
                                      const activate = realizedCapitalActivation(
                                        state,
                                        request,
                                        generation.generationHash,
                                      ).pipe(Effect.as(runtime))
                                      if (!restricted) return activate

                                      const recover: RecoveryFirstCycleDriverOwner = (driver) =>
                                        Deferred.make<void>().pipe(
                                          Effect.flatMap((rolledOver) => {
                                            const externallyOwnedDriver = {
                                              ...driver,
                                              advance: advanceRestrictedGenerationRecovery(
                                                driver.advance,
                                                recoverBlockedGeneration,
                                              ).pipe(
                                                Effect.flatMap((step) => {
                                                  if (step._tag !== 'Waiting') return Effect.succeed(step)
                                                  if (
                                                    runtimeServices.authorityGenerationStore.readAuthorityState ===
                                                    undefined
                                                  ) {
                                                    return Effect.fail(
                                                      capitalActivationOperationalError(
                                                        'restricted generation rebind requires durable authority state reads',
                                                      ),
                                                    )
                                                  }
                                                  return runtimeServices.authorityGenerationStore.readAuthorityState.pipe(
                                                    Effect.mapError((cause) =>
                                                      capitalActivationOperationalError(
                                                        'restricted generation rebind authority read failed',
                                                        cause,
                                                      ),
                                                    ),
                                                    Effect.map((authority) =>
                                                      recognizeRestrictedGenerationRebind(
                                                        step,
                                                        generation.generationHash,
                                                        authority.generationHash,
                                                      ),
                                                    ),
                                                  )
                                                }),
                                                Effect.catch((cause) =>
                                                  cause instanceof OperationalError
                                                    ? Effect.die(cause)
                                                    : Effect.fail(cause),
                                                ),
                                                Effect.tap((step) =>
                                                  step._tag !== 'Waiting'
                                                    ? Deferred.succeed(rolledOver, undefined)
                                                    : Effect.void,
                                                ),
                                                Effect.map((step) => step.advance),
                                              ),
                                            }
                                            return Effect.raceFirst(
                                              options
                                                .ownCycleDriver(externallyOwnedDriver)
                                                .pipe(Effect.andThen(Effect.never)),
                                              Deferred.await(rolledOver),
                                            )
                                          }),
                                        )
                                      return startCycle(
                                        {
                                          cycleBindingId,
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
                        return prepareOrRecover.pipe(
                          Effect.flatMap(resolvePrepared),
                          Effect.catch((cause) =>
                            Effect.logWarning('Bayn capital activation remains in OBSERVE').pipe(
                              Effect.annotateLogs({
                                service: 'bayn',
                                activation: 'PENDING',
                                reason: cause instanceof Error ? cause.message : String(cause),
                              }),
                              Effect.andThen(
                                recoverPendingCapitalActivationToObserve(
                                  state,
                                  request,
                                  readCurrentObserveRuntime(),
                                  readRuntime(),
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
