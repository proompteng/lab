import { Effect } from 'effect'

import type { ExecutionCycleClosureStoreShape } from '../db/execution-cycle-closure'
import { operationalError } from '../errors'
import type { ExecutionAuthority } from '../execution/authority'
import type { BlockedCycleIntentStoreShape } from '../execution/intents'
import { makeExecutionProgram, type ExecutionProgramDependencies } from '../execution/runtime-program'
import type { IntradayMarketDataService } from '../market-data'
import type { MutationCycleExecutionMode, ObserveAutonomousCycleInput } from '../observe-composition/model'
import { loadStrategyExecutionRiskPolicy, makeMutationAutonomousCycleStartup } from '../observe-composition/startup'
import { currentUtcInstant } from '../time'

export interface TradingEngineInput {
  readonly authority: ExecutionAuthority
  readonly cycle: ObserveAutonomousCycleInput & {
    readonly intradayMarketData: IntradayMarketDataService
    readonly executionCycleClosureStore: ExecutionCycleClosureStoreShape
    readonly blockedCycleIntentStore: BlockedCycleIntentStoreShape
  }
  readonly execution: Omit<ExecutionProgramDependencies, 'riskPolicy' | 'currentUtcInstant' | 'isCloseOnlyIntent'>
  readonly executionMode: MutationCycleExecutionMode
}

export const makeTradingEngine = (input: TradingEngineInput) =>
  Effect.gen(function* () {
    if (input.cycle.accountId !== input.authority.brokerIdentity.accountId)
      return yield* operationalError({
        component: 'config',
        operation: 'trading-engine',
        message: 'Trading engine cycle and broker authority must use the same account',
      })
    const riskPolicy = yield* loadStrategyExecutionRiskPolicy(input.cycle.accountId, input.cycle.strategy)
    const executionProgram = yield* Effect.fromResult(
      makeExecutionProgram(input.authority, {
        ...input.execution,
        riskPolicy,
        currentUtcInstant,
        isCloseOnlyIntent: (intentId) => input.cycle.executionCycleClosureStore.containsIntent(intentId),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        operationalError({
          component: 'config',
          operation: 'execution-program',
          message: 'Execution program requires validated mutation authority and risk policy',
          cause,
        }),
      ),
    )
    return {
      executionProgram,
      startCycle: makeMutationAutonomousCycleStartup({ ...input.cycle, executionProgram }, input.executionMode),
    }
  })
