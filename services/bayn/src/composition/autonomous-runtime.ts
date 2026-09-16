import { Effect, Layer, Ref, Result, Scope } from 'effect'
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
import { recoverTerminalGenerationToObserve } from '../blocked-generation-recovery'
import { makeMutation } from '../broker/alpaca-mutations'
import type { LoadedRuntimeConfig } from '../config'
import { readFinalExecutionRiskContext } from '../db/reconciliation'
import { BrokerAccess } from '../execution/authority'
import { Authority, type ResearchCapitalGrantGeneration } from '../execution/contracts'
import {
  type ResearchCapitalActivationRequest,
  type ResearchCapitalBuildContinuation,
  type ResearchCapitalBuildLineage,
} from '../execution/configuration'
import { resolvePreparedExecutionAuthority, resolvePreparedExecutionPolicy } from '../execution/runtime-authority'
import { OperationalError } from '../errors'
import { capitalGrantFromLegacyGeneration, capitalGrantKey } from '../execution/mandate'
import {
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
  type RecoveryFirstRuntime,
} from '../observe-composition'
import { runOnce } from '../reconciler'
import { boundedReconciliationPass } from '../observe-composition/decision-builder'
import { currentUtcInstant } from '../time'
import type { RuntimeState } from '../runtime-state'
import { scopedAcquisition } from '../resource-boundary'
import { autonomousRuntimeServices, makeAutonomousCycleResources } from './autonomous-runtime-resources'
import { AutonomousRuntimeResourcesLive, applicationDependencies } from './resources'
import { executionProgramError, observeCycle, observeCycleGenerationHash, runtimeBroker } from './lifecycle'
import { makeTradingEngine } from './trading-engine'
import { executionGenerationNeedsRecovery, ownGenerationCycleDriver, withGenerationRebinding } from './generation-cycle'
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
                        const marketData = dependencies.intradayMarketData
                        const cycleResources = makeAutonomousCycleResources(runtimeServices, marketData)
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
                              observeCycle(observePlan, authorityGenerationHash, marketData),
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
                          const readAuthority = runtimeServices.authorityGenerationStore.readAuthorityState
                          if (readAuthority === undefined) {
                            return Effect.fail(
                              capitalActivationOperationalError(
                                'capital startup recovery requires durable authority state reads',
                              ),
                            )
                          }
                          return readAuthority.pipe(
                            Effect.mapError((cause) =>
                              capitalActivationOperationalError(
                                'capital startup recovery authority read failed',
                                cause,
                              ),
                            ),
                            Effect.flatMap((authorityState) => {
                              const restricted =
                                authorityState.generationHash === generation.generationHash &&
                                executionGenerationNeedsRecovery(authorityState)
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
                                      makeTradingEngine({
                                        authority,
                                        cycle: {
                                          accountId: realizedPlan.config.alpaca.expectedAccountId,
                                          authorityGenerationHash: generation.generationHash,
                                          strategy: realizedPlan.strategy,
                                          intradayMarketData: marketData,
                                          executionCycleClosureStore: runtimeServices.executionCycleClosureStore,
                                          blockedCycleIntentStore: runtimeServices.blockedCycleIntentStore,
                                          pollIntervalMs: realizedPlan.config.cyclePollIntervalMs,
                                          reconciliationIntervalMs: realizedPlan.config.alpaca.reconciliationIntervalMs,
                                          reconciliationPassTimeoutMs: realizedPlan.config.operationTimeoutMs,
                                        },
                                        executionMode: restricted ? 'CloseOnly' : 'Mutation',
                                        execution: {
                                          brokerRead: runtimeServices.session.read,
                                          brokerMutation,
                                          persistedCapitalGrants: runtimeServices.persistedCapitalGrants,
                                          readFinalExecutionRiskContext: (observedAt) =>
                                            readFinalExecutionRiskContext(
                                              runtimeServices.pgClient,
                                              realizedPlan.config.alpaca.expectedAccountId,
                                              observedAt,
                                            ),
                                          intentStore: runtimeServices.intentStore,
                                          mutationStore: runtimeServices.mutationStore,
                                          writerFence: runtimeServices.writerFence,
                                        },
                                      }),
                                    ),
                                    Effect.flatMap((engine) => {
                                      const recover = ownGenerationCycleDriver({
                                        generationHash: generation.generationHash,
                                        mode: restricted ? 'CloseOnly' : 'Mutation',
                                        readAuthority: readAuthority.pipe(
                                          Effect.mapError((cause) =>
                                            capitalActivationOperationalError(
                                              'generation recovery authority read failed',
                                              cause,
                                            ),
                                          ),
                                        ),
                                        reconcileWhenHeld: boundedReconciliationPass(
                                          plan.config.operationTimeoutMs,
                                        ).pipe(
                                          // @effect-diagnostics-next-line strictEffectProvide:off -- value-only cycle services have no resource lifetime
                                          Effect.provide(cycleResources),
                                          Effect.asVoid,
                                          Effect.mapError((cause) =>
                                            capitalActivationOperationalError(
                                              'restricted authority reconciliation failed',
                                              cause,
                                            ),
                                          ),
                                        ),
                                        settle: recoverBlockedGeneration,
                                        owner: options.ownCycleDriver,
                                      })
                                      const startCycle = (startup: AutonomousCycleStartupInput) =>
                                        ownCycleDriverStartup(
                                          engine.startCycle,
                                          recover,
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
                                      const runtime: AutonomousRuntime<never, never> = {
                                        _tag: 'AutonomousMutation' as const,
                                        broker: runtimeBroker(realizedPlan, runtimeServices.session.read, true),
                                        cycleBindingId,
                                        executionProgram: engine.executionProgram,
                                        startCycle: withGenerationRebinding(
                                          startCycle,
                                          prepareOrRecover.pipe(Effect.flatMap(resolvePrepared)),
                                        ),
                                      }
                                      const activate = realizedCapitalActivation(
                                        state,
                                        request,
                                        generation.generationHash,
                                      ).pipe(Effect.as(runtime))
                                      if (!restricted) return activate
                                      return startCycle({
                                        cycleBindingId,
                                        recordPass: (observation) => recordAutonomousCyclePass(state, observation),
                                      }).pipe(
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
