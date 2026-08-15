import { Duration, Effect, Result, Schema, Semaphore } from 'effect'

import type { ApplicationPlanFor, AutonomousCycleStartup } from '../app'
import type { BrokerReadShape } from '../broker/alpaca'
import { BrokerMutationError } from '../broker/alpaca-mutations'
import { CycleRunnerError } from '../cycle/runner'
import { CapitalAuthorityKind } from '../execution/authority'
import { Authority, type AuthorityState } from '../execution/contracts'
import { isResearchCapitalActivationRequest, type CapitalActivationRequest } from '../execution/configuration'
import { makeExecutionProgram, type ExecutionProgram } from '../execution/runtime-program'
import { operationalError } from '../errors'
import {
  executionEpisodeCloseExpiresAt,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  type LifecycleAdvanceDisposition,
  type LifecycleAdvanceMaintenance,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverInterpreter,
  type RecoveryFirstRuntime,
} from '../observe-composition'
import { notDueReconciliationError } from '../observe-composition/decision-builder'
import type { ReconciliationPassError } from '../reconciler'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'

export const runtimeBroker = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  read: BrokerReadShape,
  mutationEnabled: boolean,
) => ({
  read,
  expectedAccountId: plan.config.alpaca.expectedAccountId,
  executionEligible: mutationEnabled,
  executionDisabledReason: mutationEnabled ? null : ('BROKER_ACCESS_READ_ONLY' as const),
})

export const lifecycleMaintenanceCycle =
  (
    plan: ApplicationPlanFor<'AutonomousService'>,
    maintainReconciliation: Effect.Effect<void, ReconciliationPassError>,
    maintainLifecycle: LifecycleAdvanceMaintenance,
    interpretCycleDriver: RecoveryFirstCycleDriverInterpreter,
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
          runLifecycleMaintenanceAdvance(maintainReconciliation, maintainLifecycle).pipe(
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
          maintainReconciliation: operationPermit.withPermit(
            maintainLifecycle.beforeReconciliation.pipe(
              Effect.andThen(maintainReconciliation.pipe(Effect.mapError(lifecycleReconciliationError))),
              Effect.catch((error) =>
                Effect.logError('Bayn Restate reconciliation guardian failed', error).pipe(
                  Effect.annotateLogs({
                    operation: error.operation,
                    failure: error.failure,
                    reason: error.message,
                  }),
                ),
              ),
            ),
          ),
          nextDelayMs,
          wait: () => Effect.sleep(Duration.millis(nextDelayMs)),
        }
        return interpretCycleDriver(driver)
      }),
    )

const lifecycleReconciliationError = (cause: ReconciliationPassError): CycleRunnerError => {
  const converted = notDueReconciliationError(cause)
  return new CycleRunnerError({
    operation: 'reconcile-not-due',
    failure: converted.failure,
    message: converted.message,
    cause: converted,
  })
}

export const runLifecycleMaintenanceAdvance = (
  maintainReconciliation: Effect.Effect<void, ReconciliationPassError>,
  maintainLifecycle: LifecycleAdvanceMaintenance,
): Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError> =>
  maintainLifecycle.beforeReconciliation.pipe(
    Effect.andThen(maintainReconciliation.pipe(Effect.mapError(lifecycleReconciliationError))),
    Effect.andThen(maintainLifecycle.afterReconciliation),
  )

export const observeCycleGenerationHash = (authority: AuthorityState): Result.Result<string, string> =>
  authority.maximum === Authority.Observe && authority.effective === Authority.Observe
    ? Result.succeed(authority.generationHash)
    : Result.fail('OBSERVE cycle startup requires current effective OBSERVE authority')

export const observeCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  authorityGenerationHash: string,
  interpretCycleDriver: RecoveryFirstCycleDriverInterpreter,
) => {
  return makeObserveAutonomousCycleStartup(
    {
      accountId: plan.config.alpaca.expectedAccountId,
      authorityGenerationHash,
      pollIntervalMs: plan.config.cyclePollIntervalMs,
      reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
      strategy: plan.strategy,
      interpretCycleDriver,
    },
    interpretCycleDriver,
  )
}

export const mutationCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  executionProgram: ExecutionProgram,
  executionEpisode: CapitalActivationRequest,
  executionCycleClosureStore: import('../db/execution-cycle-closure').ExecutionCycleClosureStoreShape,
  blockedCycleIntentStore: import('../execution/intents').BlockedCycleIntentStoreShape,
  onClosedCycle: (cycleId: string, observedAt: string) => Effect.Effect<void>,
  lifecycleMaintenance: LifecycleAdvanceMaintenance | undefined,
  interpretCycleDriver: RecoveryFirstCycleDriverInterpreter,
) => {
  return makeMutationAutonomousCycleStartup(
    {
      accountId: plan.config.alpaca.expectedAccountId,
      authorityGenerationHash:
        plan.config.execution.capitalAuthority._tag === CapitalAuthorityKind.Granted
          ? plan.config.execution.capitalAuthority.authorityGenerationHash
          : plan.config.alpaca.authorityGenerationHash,
      pollIntervalMs: plan.config.cyclePollIntervalMs,
      reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
      strategy: plan.strategy,
      ...(isResearchCapitalActivationRequest(executionEpisode) ? { cycleCadence: 'CAPITAL_BOOTSTRAP' as const } : {}),
      executionProgram,
      executionCycleClosureStore,
      blockedCycleIntentStore,
      onClosedCycle,
      executionEpisodeCutoffAt: executionEpisode.cutoffAt,
      executionEpisodeCloseSubmitCutoffAt: executionEpisode.expiresAt,
      executionEpisodeExpiresAt: executionEpisodeCloseExpiresAt(executionEpisode.expiresAt),
      ...(lifecycleMaintenance === undefined ? {} : { lifecycleMaintenance }),
      interpretCycleDriver,
    },
    interpretCycleDriver,
  )
}

export const executionProgramError = (
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
