import { Result, Schema } from 'effect'

import { Authority, AuthorityStateSchema, KillState, ReconciliationSchema } from '../execution/contracts'
import { accountEntryProtectionReasons, PolicySchema } from '../risk'
import { IsoDateSchema, NonNegativeIntegerSchema, SignedMicrosSchema, UtcInstantSchema } from '../schemas'
import { accountTradingDate, utcInstantFromEpochMillis } from '../time'
import { decodeJevPortfolio, JevPortfolioSchema, JevPurpose } from './portfolio'
import type { ReconciledBrokerState } from '../simulation-reconciliation/broker-model'

/** The same retained inputs reproduce the admission decision in the runtime and the offline assessment. */
export const AccountProtectionInputsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.account-protection-inputs.v1'),
  observedAt: UtcInstantSchema,
  portfolio: JevPortfolioSchema.check(
    Schema.makeFilter((portfolio) => portfolio.purpose === JevPurpose.Entry, {
      expected: 'a reconciled flat portfolio with settled orders',
    }),
  ),
  policy: PolicySchema,
  authority: AuthorityStateSchema,
  authorityObservedAt: UtcInstantSchema,
  reconciliation: ReconciliationSchema,
  accountingExact: Schema.Boolean,
  tradingDate: IsoDateSchema,
  unknownMutationCount: NonNegativeIntegerSchema,
  dayStartEquityMicros: SignedMicrosSchema,
  peakEquityMicros: SignedMicrosSchema,
})

export type AccountProtectionInputs = typeof AccountProtectionInputsSchema.Type

export type AccountProtectionFacts = Omit<AccountProtectionInputs, 'portfolio'> & {
  readonly portfolio: { readonly purpose: JevPurpose; readonly brokerState: ReconciledBrokerState }
}

export const decideAccountProtection = (inputs: AccountProtectionFacts, authorityGenerationHash: string) => {
  const { portfolio, policy, authority, reconciliation, observedAt } = inputs
  const { brokerState } = portfolio
  const nowMs = Date.parse(observedAt)
  if (
    !Number.isSafeInteger(nowMs) ||
    portfolio.purpose !== JevPurpose.Entry ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Execution ||
    authority.effective !== Authority.Execution ||
    authority.kill !== KillState.Clear ||
    brokerState.account.accountId !== policy.accountId ||
    inputs.tradingDate !== accountTradingDate(observedAt) ||
    inputs.unknownMutationCount !== 0 ||
    !inputs.accountingExact ||
    reconciliation.status !== brokerState.reconciliation.status ||
    reconciliation.reconciliationId !== brokerState.reconciliation.reconciliationId
  )
    return undefined
  const reasons = accountEntryProtectionReasons(
    {
      accountEquityMicros: BigInt(brokerState.account.equityMicros),
      dayStartEquityMicros: BigInt(inputs.dayStartEquityMicros),
      peakEquityMicros: BigInt(inputs.peakEquityMicros),
    },
    policy,
  )
  if (reasons.length === 0) return undefined
  const timestamps = [
    brokerState.account.observedAt,
    brokerState.positionsObservedAt,
    brokerState.ordersObservedAt,
    reconciliation.reconciledAt,
    inputs.authorityObservedAt,
  ].map(Date.parse)
  if (timestamps.some((at) => !Number.isSafeInteger(at) || at > nowMs)) return undefined
  if (Date.parse(authority.updatedAt) > Date.parse(inputs.authorityObservedAt)) return undefined
  const validUntilMs = Math.min(...timestamps) + policy.maxBrokerStateAgeMs
  if (!Number.isSafeInteger(validUntilMs) || nowMs >= validUntilMs) return undefined
  const verifiedPortfolio = decodeJevPortfolio({ purpose: JevPurpose.Entry, brokerState })
  if (Result.isFailure(verifiedPortfolio)) return undefined
  return {
    reasons,
    inputs: { ...inputs, portfolio: verifiedPortfolio.success },
    protection: {
      authorityGenerationHash,
      authorityUpdatedAt: authority.updatedAt,
      reconciliationId: reconciliation.reconciliationId,
      tradingDate: inputs.tradingDate,
      validUntil: utcInstantFromEpochMillis(validUntilMs),
    },
  }
}
