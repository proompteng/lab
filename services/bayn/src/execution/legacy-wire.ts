/**
 * Immutable execution wire values minted before the core became account-environment neutral.
 *
 * These strings are persistence/hash compatibility only. New internal APIs must use execution-domain names and import
 * these constants only at codecs, durable SQL boundaries, or canonical hash construction sites.
 */
export const legacyObserveAuthorityToken = 'OBSERVE' as const
export const legacyExecutionAuthorityToken = 'PAPER' as const

export const legacyOrderV2SchemaVersion = 'bayn.order.v3' as const
export const legacyFillSchemaVersion = 'bayn.fill.v2' as const
export const legacyBrokerEventSchemaVersion = 'bayn.paper-broker-event.v1' as const
export const legacyRiskInputSchemaVersion = 'bayn.paper-risk-input.v1' as const
export const legacyRiskDecisionSchemaVersion = 'bayn.paper-risk-decision.v1' as const
export const legacyRiskEvaluationInputV2SchemaVersion = 'bayn.paper-risk-evaluation-input.v2' as const
export const legacyRiskEvaluationInputV3SchemaVersion = 'bayn.paper-risk-evaluation-input.v3' as const
export const legacyAccountingReceiptSchemaVersion = 'bayn.paper-accounting-receipt.v1' as const
export const legacyAccountingTransactionSchemaVersion = 'bayn.accounting-transaction.v2' as const
export const legacyAccountingTransactionIdSchemaVersion = 'bayn.paper-accounting-transaction-id.v1' as const
export const legacyValuationSchemaVersion = 'bayn.paper-valuation.v1' as const
export const legacyReconciliationSchemaVersion = 'bayn.paper-reconciliation.v1' as const
export const legacyReconciliationIdSchemaVersion = 'bayn.paper-reconciliation-id.v1' as const
export const legacyAuthorityProofBindingSchemaVersion = 'bayn.paper-authority-proof-binding.v1' as const
export const legacyResearchGrantProofSchemaVersion = 'bayn.research-paper-grant-proof.v1' as const
export const legacyAuthorityGenerationV2SchemaVersion = 'bayn.paper-authority-generation.v2' as const
export const legacyAuthorityGenerationV3SchemaVersion = 'bayn.paper-authority-generation.v3' as const
export const legacyAuthorityStateSchemaVersion = 'bayn.paper-authority.v1' as const
export const legacyMutationIdentitySchemaVersion = 'bayn.paper-mutation.v1' as const
export const legacyMutationEventSchemaVersion = 'bayn.paper-mutation-event.v1' as const
export const legacyCycleClosureSchemaVersion = 'bayn.paper-cycle-closure.v1' as const
export const legacyRiskStateSchemaVersion = 'bayn.paper-risk-state.v2' as const
export const legacyReferenceTargetPlanSchemaVersion = 'bayn.paper-reference-target-plan.v1' as const
export const legacySubmitDryRunSchemaVersion = 'bayn.paper-submit-dry-run.v1' as const
export const legacyObserveSuccessorGenerationSchemaVersion = 'bayn.paper-observe-successor-generation.v1' as const
