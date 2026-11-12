import { Effect } from 'effect'

import { CycleState } from './cycle/model'
import { makeInitialCycle } from './cycle/store/decisions'
import { nativeJevFixture } from './jev/native.test-support'
import { persistenceDocumentFixture } from './system-assessment/decision-persistence.test-support'
import { executionDecisionPlannerInput } from './shadow-decision-contract'
import type { ExecutionDecisionInput } from './shadow-decision'

export const decisionConstructionFixture = Effect.gen(function* () {
  const expected = yield* persistenceDocumentFixture
  const native = nativeJevFixture()
  const plannerInput = executionDecisionPlannerInput(expected)
  const { strategyDecision, riskPolicy, executionSession } = expected
  const riskContext = expected.bindings.riskContext
  if (
    plannerInput === undefined ||
    strategyDecision === undefined ||
    riskPolicy === undefined ||
    executionSession === undefined ||
    riskContext === undefined
  )
    throw new Error('Expected complete decision fixture')
  const input: ExecutionDecisionInput = {
    cycle: { ...makeInitialCycle(native.draft, expected.createdAt), state: CycleState.Active },
    snapshot: {
      snapshotId: expected.bindings.snapshotId,
      contentHash: expected.bindings.snapshotContentHash,
      finalizedAt: expected.bindings.snapshotFinalizedAt,
    },
    compiledDecision: strategyDecision,
    ...(expected.bindings.decisionMarketData === undefined
      ? {}
      : { decisionMarketData: expected.bindings.decisionMarketData }),
    ...(expected.bindings.executionMarketData === undefined
      ? {}
      : { executionMarketData: expected.bindings.executionMarketData }),
    ...(expected.decisionMarketDataRows === undefined
      ? {}
      : { decisionMarketDataRows: expected.decisionMarketDataRows }),
    ...(expected.executionMarketDataRows === undefined
      ? {}
      : { executionMarketDataRows: expected.executionMarketDataRows }),
    plannerInput,
    targetPlan: expected.targetPlan,
    policy: riskPolicy,
    riskInputs: expected.deltaRisk.map((risk) => {
      if (risk.facts === undefined) throw new Error('Expected durable risk facts')
      return {
        symbol: risk.facts.state.marketDataSymbol,
        limitPriceMicros: risk.limitPriceMicros,
        notionalLimitMicros: risk.notionalLimitMicros,
        state: risk.facts.state,
      }
    }),
    authorityGenerationHash: expected.bindings.authorityGenerationHash,
    riskContext,
    executionSession,
  }
  return { input, expected }
})
