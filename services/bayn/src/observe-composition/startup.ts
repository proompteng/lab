import { Effect, Result, Schema } from 'effect'
import type { AutonomousCycleDriverStartup } from '../app'
import { makeCycleExecutionPolicyFromModel } from '../cycle'
import { AuthorityGenerationStore } from '../db/execution-store'
import { makeStrategyProtocolHashResult } from '../contracts'
import { OperationalError, operationalError } from '../errors'
import { Authority, type AuthorityState } from '../execution/contracts'
import { CycleExecutionModelSchema } from '../execution-model-contract'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { strategyDefinition, type StrategyRuntime } from '../strategy'
import type {
  MutationAutonomousCycleInput,
  ObserveAutonomousCycleInput,
  ObserveStartupPreparation,
  RecoveryFirstCycleDriver,
  RecoveryFirstRuntime,
} from './model'
import { loadObserveRiskPolicy } from './decision-builder'
import { validateMutationExecutionProgram } from './execution-cycle'
import { makeRecoveryFirstCycleDriver, mutationDecisionBuilder, observeDecisionBuilder } from './recovery-driver'

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const definition = strategyDefinition(input.strategy)
  const parameterHash = canonicalHashV1Result(definition.parameters)
  if (Result.isFailure(parameterHash)) {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'strategy definition parameters are not canonically hashable',
        cause: parameterHash.failure,
      }),
    )
  }
  const parameterSchemaVersion = (definition.parameters as { readonly schemaVersion?: unknown }).schemaVersion
  if (
    definition.name !== input.strategy.provenance.strategy.name ||
    parameterSchemaVersion !== input.strategy.provenance.strategy.parameterSchemaVersion ||
    parameterHash.success !== input.strategy.provenance.strategy.parameterHash
  ) {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'strategy definition does not match its runtime provenance',
      }),
    )
  }
  const decodedExecutionModel = decodeStrategyExecutionModel(input.strategy)
  if (Result.isFailure(decodedExecutionModel)) return Result.fail(decodedExecutionModel.failure)
  const executionModel = decodedExecutionModel.success
  if (
    executionModel.schemaVersion !== 'bayn.execution-model.v3' &&
    executionModel.schemaVersion !== 'bayn.execution-model.v4'
  ) {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'autonomous cycles require an account-neutral v3 or v4 execution model',
      }),
    )
  }
  return Result.flatMap(
    Result.mapError(makeCycleExecutionPolicyFromModel(executionModel), (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'autonomous cycle execution policy construction failed',
        cause,
      }),
    ),
    (executionPolicy) =>
      Result.mapError(makeStrategyProtocolHashResult(input.strategy.provenance.strategy), (cause) =>
        operationalError({
          component: 'strategy',
          operation: 'cycle-policy',
          message: 'strategy protocol hash construction failed',
          cause,
        }),
      ).pipe(
        Result.map((strategyProtocolHash) => ({
          executionModel,
          executionPolicy,
          strategyProtocolHash,
        })),
      ),
  )
}

export const decodeStrategyExecutionModel = (strategy: StrategyRuntime) =>
  Result.mapError(
    Schema.decodeUnknownResult(
      CycleExecutionModelSchema,
      strictParseOptions,
    )((strategyDefinition(strategy).parameters as { readonly executionModel?: unknown }).executionModel),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'strategy execution model is invalid',
        cause,
      }),
  )

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
  ): AutonomousCycleDriverStartup<RecoveryFirstCycleDriver, AuthorityGenerationStore, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyDefinition(input.strategy).parameters.universe,
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
        makeRecoveryFirstCycleDriver(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'RecoveryOnly' },
          observeDecisionBuilder(input, preparation, policy),
          'autonomous cycle loop',
        ),
      )
    })

export const makeMutationAutonomousCycleStartup =
  (
    input: MutationAutonomousCycleInput,
  ): AutonomousCycleDriverStartup<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      yield* Effect.fromResult(validateMutationExecutionProgram(input))
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyDefinition(input.strategy).parameters.universe,
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
        makeRecoveryFirstCycleDriver(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'Mutation', executionProgram: input.executionProgram },
          mutationDecisionBuilder(input, preparation, policy),
          'mutation autonomous cycle loop',
        ),
      )
    })
