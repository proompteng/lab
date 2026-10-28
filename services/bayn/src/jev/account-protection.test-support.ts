import { Effect, Schema } from 'effect'

import { Authority, KillState } from '../execution/contracts'
import { legacyAuthorityStateSchemaVersion } from '../execution/legacy-wire'
import { protectedAccountAdmission } from '../observe-composition/account-admission'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import type { ReconciliationPassResult } from '../reconciler'
import { accountTradingDate } from '../time'
import { IsoDateSchema } from '../schemas'
import { nativeJevFixture } from './native.test-support'

export const accountProtectionFixture = async () => {
  const native = nativeJevFixture()
  const brokerState = native.portfolio.brokerState
  const observedAt = native.observation.payload.observedAt
  const policy = await Effect.runPromise(
    Effect.fromResult(makeExecutionRiskPolicy(brokerState.account.accountId, native.protocol.universe)),
  )
  const preflight: ReconciliationPassResult = {
    brokerState,
    report: {
      reconciliation: brokerState.reconciliation,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    riskContext: {
      authority: {
        schemaVersion: legacyAuthorityStateSchemaVersion,
        generationHash: native.input.authorityGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      tradingDate: Schema.decodeUnknownSync(IsoDateSchema)(accountTradingDate(observedAt)),
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: brokerState.account.equityMicros,
      peakEquityMicros: (BigInt(brokerState.account.equityMicros) + BigInt(policy.maxDrawdownMicros) + 1n).toString(),
    },
  }
  const decision = protectedAccountAdmission(preflight, policy, native.input.authorityGenerationHash, observedAt)
  if (decision?.admissionProtection.inputs === undefined)
    throw new Error('Fixture must reproduce a protected admission')
  return { native, preflight, policy, decision, inputs: decision.admissionProtection.inputs }
}
