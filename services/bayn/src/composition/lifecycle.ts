import { Result, Schema } from 'effect'

import type { ApplicationPlanFor } from '../app'
import type { BrokerReadShape } from '../broker/alpaca'
import { BrokerMutationError } from '../broker/alpaca-mutations'
import { CapitalAuthorityKind } from '../execution/authority'
import { Authority, type AuthorityState } from '../execution/contracts'
import { makeExecutionProgram, type ExecutionProgram } from '../execution/runtime-program'
import { operationalError } from '../errors'
import {
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  type MutationCycleExecutionMode,
} from '../observe-composition'
import type { IntradayMarketDataService } from '../market-data'

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

export const observeCycleGenerationHash = (authority: AuthorityState): Result.Result<string, string> =>
  authority.maximum === Authority.Observe && authority.effective === Authority.Observe
    ? Result.succeed(authority.generationHash)
    : Result.fail('OBSERVE cycle startup requires current effective OBSERVE authority')

export const observeCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  authorityGenerationHash: string,
  intradayMarketData: IntradayMarketDataService,
) => {
  return makeObserveAutonomousCycleStartup({
    accountId: plan.config.alpaca.expectedAccountId,
    authorityGenerationHash,
    pollIntervalMs: plan.config.cyclePollIntervalMs,
    reconciliationIntervalMs: plan.config.alpaca.reconciliationIntervalMs,
    reconciliationPassTimeoutMs: plan.config.operationTimeoutMs,
    strategy: plan.strategy,
    intradayMarketData,
  })
}

export const mutationCycle = (
  plan: ApplicationPlanFor<'AutonomousService'>,
  executionProgram: ExecutionProgram,
  executionCycleClosureStore: import('../db/execution-cycle-closure').ExecutionCycleClosureStoreShape,
  blockedCycleIntentStore: import('../execution/intents').BlockedCycleIntentStoreShape,
  intradayMarketData: IntradayMarketDataService,
  executionMode: MutationCycleExecutionMode = 'Mutation',
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
      intradayMarketData,
      executionProgram,
      executionCycleClosureStore,
      blockedCycleIntentStore,
    },
    executionMode,
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
