import { Effect, Result } from 'effect'
import type { AutonomousCycleStartup } from '../app'
import { makeCycleExecutionPolicyFromModel } from '../cycle'
import { AuthorityGenerationStore } from '../db/execution-store'
import { makeStrategyProtocolHash } from '../contracts'
import { OperationalError, operationalError } from '../errors'
import { Authority, type AuthorityState } from '../execution/contracts'
import { strategyApplication } from '../strategy'
import type {
  MutationAutonomousCycleInput,
  ObserveAutonomousCycleInput,
  ObserveStartupPreparation,
  RecoveryFirstCycleDriverInterpreter,
  RecoveryFirstRuntime,
} from './model'
import { loadObserveRiskPolicy } from './decision-builder'
import { validateMutationExecutionProgram } from './execution-cycle'
import { makeRecoveryFirstAutonomousLoop, mutationDecisionBuilder, observeDecisionBuilder } from './recovery-driver'

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const executionModel = strategyApplication(input.strategy).definition.parameters.executionModel
  if (executionModel.schemaVersion !== 'bayn.execution-model.v3') {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'autonomous cycles require the account-neutral v3 execution model',
      }),
    )
  }
  return Result.map(
    Result.mapError(makeCycleExecutionPolicyFromModel(executionModel), (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'autonomous cycle execution policy construction failed',
        cause,
      }),
    ),
    (executionPolicy) => ({
      executionModel,
      executionPolicy,
      strategyProtocolHash: makeStrategyProtocolHash(input.strategy.provenance.strategy),
    }),
  )
}

const validateObserveAuthorityInitialization = (
  authority: AuthorityState,
  input: ObserveAutonomousCycleInput,
): Result.Result<AuthorityState, OperationalError> =>
  authority.generationHash !== input.authorityGenerationHash ||
  authority.maximum !== Authority.Observe ||
  authority.effective !== Authority.Observe
    ? Result.fail(
        operationalError({
          component: 'database',
          operation: 'authority',
          message: 'OBSERVE authority initialization returned incompatible state',
        }),
      )
    : Result.succeed(authority)

const initializeObserveAuthority = (
  input: ObserveAutonomousCycleInput,
): Effect.Effect<AuthorityState, OperationalError, AuthorityGenerationStore> =>
  AuthorityGenerationStore.pipe(
    Effect.flatMap((executionStore) =>
      executionStore.ensureAuthorityGeneration({
        generationHash: input.authorityGenerationHash,
        maximum: Authority.Observe,
      }),
    ),
    Effect.mapError((cause) =>
      operationalError({
        component: 'database',
        operation: 'authority',
        message: 'OBSERVE authority initialization failed',
        cause,
      }),
    ),
    Effect.flatMap((authority) => Effect.fromResult(validateObserveAuthorityInitialization(authority, input))),
  )

export const makeObserveAutonomousCycleStartup =
  (
    input: ObserveAutonomousCycleInput,
    interpretCycleDriver: RecoveryFirstCycleDriverInterpreter,
  ): AutonomousCycleStartup<AuthorityGenerationStore, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyApplication(input.strategy).definition.parameters.universe,
      ).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled execution risk policy is invalid',
            cause,
          }),
        ),
      )
      yield* initializeObserveAuthority(input)
      return yield* Effect.fromResult(
        makeRecoveryFirstAutonomousLoop(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'RecoveryOnly' },
          observeDecisionBuilder(input, preparation, policy),
          'autonomous cycle loop',
          interpretCycleDriver,
        ),
      )
    })

export const makeMutationAutonomousCycleStartup =
  (
    input: MutationAutonomousCycleInput,
    interpretCycleDriver: RecoveryFirstCycleDriverInterpreter,
  ): AutonomousCycleStartup<never, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      yield* Effect.fromResult(validateMutationExecutionProgram(input))
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyApplication(input.strategy).definition.parameters.universe,
      ).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled execution risk policy is invalid',
            cause,
          }),
        ),
      )
      return yield* Effect.fromResult(
        makeRecoveryFirstAutonomousLoop(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'Mutation', executionProgram: input.executionProgram },
          mutationDecisionBuilder(input, preparation, policy),
          'mutation autonomous cycle loop',
          interpretCycleDriver,
        ),
      )
    })
