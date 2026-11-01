import { Effect, Result, Schema } from 'effect'
import { entryAblationBehaviorHash, makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { jevBehaviorHash } from '../jev/protocol'
import { makeRepeatedMomentumPolicy, repeatedMomentumBehaviorHash } from '../strategy/repeated-momentum/policy'
import { BrokerEnvironment } from '../broker/identity'
import type { AutonomousCycleDriverStartup } from '../app'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { AuthorityGenerationStore } from '../db/execution-store'
import { makeStrategyProtocolHashResult } from '../contracts'
import { OperationalError, operationalError } from '../errors'
import { Authority, type AuthorityState } from '../execution/contracts'
import { CycleExecutionModelSchema } from '../execution-model-contract'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import {
  loadActiveStrategyProtocol,
  loadStrategyTradingProtocol,
  strategyDefinition,
  type StrategyRuntime,
} from '../strategy'
import type {
  MutationAutonomousCycleInput,
  MutationCycleExecutionMode,
  ObserveAutonomousCycleInput,
  ObserveStartupPreparation,
  RecoveryFirstCycleDriver,
  RecoveryFirstRuntime,
} from './model'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { validateMutationExecutionProgram } from './execution-cycle'
import { makeRecoveryFirstCycleDriver, mutationDecisionBuilder, observeDecisionBuilder } from './recovery-driver'

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const definition = strategyDefinition(input.strategy)
  if (definition.name !== 'jev' || definition.holdingPeriod !== 'INTRADAY') {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'autonomous execution requires the active Jev strategy',
      }),
    )
  }
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
  const parameterSchemaVersion = definition.parameters.schemaVersion
  const ablation = parameterSchemaVersion === 'bayn.entry-ablation-policy.v1'
  const momentum = parameterSchemaVersion === 'bayn.repeated-momentum-policy.v1'
  if (
    definition.name !== input.strategy.provenance.strategy.name ||
    input.strategy.provenance.strategy.behaviorHash !==
      (momentum ? repeatedMomentumBehaviorHash : ablation ? entryAblationBehaviorHash : jevBehaviorHash) ||
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
  const sourceProtocolHash = loadActiveStrategyProtocol().pipe(
    Result.flatMap((protocol) =>
      canonicalHashV1Result(
        momentum ? makeRepeatedMomentumPolicy(protocol) : ablation ? makeEntryAblationPolicy(protocol) : protocol,
      ),
    ),
  )
  if (Result.isFailure(sourceProtocolHash) || sourceProtocolHash.success !== parameterHash.success) {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'Jev autonomous execution requires the source-controlled protocol',
        ...(Result.isFailure(sourceProtocolHash) ? { cause: sourceProtocolHash.failure } : {}),
      }),
    )
  }
  const decodedExecutionModel = decodeStrategyExecutionModel(input.strategy)
  if (Result.isFailure(decodedExecutionModel)) return Result.fail(decodedExecutionModel.failure)
  const executionModel = decodedExecutionModel.success
  if (executionModel.schemaVersion !== 'bayn.execution-model.v6') {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'autonomous intraday cycles require the quote-bound v5 execution model',
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
      executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3'
        ? Result.fail(
            operationalError({
              component: 'strategy',
              operation: 'cycle-policy',
              message: 'intraday execution requires the session-relative v3 cycle policy',
            }),
          )
        : Result.mapError(makeStrategyProtocolHashResult(input.strategy.provenance.strategy), (cause) =>
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
    loadStrategyTradingProtocol(strategy).pipe(
      Result.flatMap((protocol) =>
        Schema.decodeUnknownResult(CycleExecutionModelSchema, strictParseOptions)(protocol.executionModel),
      ),
    ),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'strategy execution model is invalid',
        cause,
      }),
  )

export const loadStrategyExecutionRiskPolicy = (
  accountId: string,
  strategy: StrategyRuntime,
  brokerEnvironment: BrokerEnvironment = BrokerEnvironment.Live,
  riskPolicyHash?: string,
) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(decodeStrategyExecutionModel(strategy))
    const symbols = (yield* Effect.fromResult(loadStrategyTradingProtocol(strategy))).universe
    const retainedPolicy = yield* Effect.fromResult(makeExecutionRiskPolicy(accountId, symbols))
    if (
      riskPolicyHash === undefined ||
      riskPolicyHash === (yield* Effect.fromResult(canonicalHashV1Result(retainedPolicy)))
    )
      return retainedPolicy
    if (brokerEnvironment === BrokerEnvironment.Sandbox) {
      const paperPolicy = yield* Effect.fromResult(
        makeExecutionRiskPolicy(accountId, symbols, BrokerEnvironment.Sandbox),
      )
      if (riskPolicyHash === (yield* Effect.fromResult(canonicalHashV1Result(paperPolicy)))) return paperPolicy
    }
    return yield* operationalError({
      component: 'strategy',
      operation: 'risk-policy',
      message: 'bound execution risk policy is not approved for this broker environment',
    })
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OperationalError
        ? cause
        : operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled execution risk policy is invalid',
            cause,
          }),
    ),
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
      const policy = yield* loadStrategyExecutionRiskPolicy(
        input.accountId,
        input.strategy,
        input.brokerEnvironment,
        input.riskPolicyHash,
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
    executionMode: MutationCycleExecutionMode = 'Mutation',
  ): AutonomousCycleDriverStartup<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      yield* Effect.fromResult(validateMutationExecutionProgram(input))
      const policy = yield* loadStrategyExecutionRiskPolicy(
        input.accountId,
        input.strategy,
        input.brokerEnvironment,
        input.riskPolicyHash,
      )
      return yield* Effect.fromResult(
        makeRecoveryFirstCycleDriver(
          input,
          startup,
          preparation,
          policy,
          executionMode === 'RecoveryOnly'
            ? { _tag: 'RecoveryOnly' }
            : { _tag: executionMode, executionProgram: input.executionProgram },
          mutationDecisionBuilder(input, preparation, policy),
          'mutation autonomous cycle loop',
        ),
      )
    })
