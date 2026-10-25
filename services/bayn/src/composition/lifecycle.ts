import { Result, Schema } from 'effect'

import type { ApplicationPlan } from '../app'
import type { BrokerReadShape } from '../broker/alpaca/model'
import { BrokerMutationError } from '../broker/alpaca-mutations/model'
import { Authority, type AuthorityState } from '../execution/contracts'
import { operationalError } from '../errors'
import { makeObserveAutonomousCycleStartup } from '../observe-composition/startup'
import type { IntradayMarketDataService } from '../market-data/intraday/model'

export const runtimeBroker = (plan: ApplicationPlan, read: BrokerReadShape, mutationEnabled: boolean) => ({
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
  plan: ApplicationPlan,
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

export const executionProgramError = (cause: BrokerMutationError | Schema.SchemaError) =>
  cause instanceof BrokerMutationError
    ? operationalError({ component: 'config', operation: 'broker-mutation', message: cause.message, cause })
    : operationalError({
        component: 'config',
        operation: 'execution-program',
        message: 'execution program requires validated mutation authority and risk policy',
        cause,
      })
