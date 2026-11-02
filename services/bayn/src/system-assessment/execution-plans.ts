import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import {
  IntentPlanSchema,
  makeExecutionIntentFromDecodedPlan,
  validateCommitIdentity,
} from '../execution/intents/domain'
import {
  OrderSide,
  OrderType,
  ReconciliationSchema,
  ReconciliationStatus,
  RiskDecisionSchema,
  RiskOutcome,
  TimeInForce,
} from '../execution/contracts'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { legacyReconciliationIdSchemaVersion } from '../execution/legacy-wire'
import { Sha256Schema, StrictNonEmptyStringSchema } from '../schemas'
import { isProtectedEntryTarget } from '../strategy/runtime-decision'
import { SystemAssessmentError } from './economics'

export const ProtectionIntentEvidenceSchema = Schema.Struct({
  plan: IntentPlanSchema,
  authorityGenerationHash: Sha256Schema,
  intentId: Sha256Schema,
  clientOrderId: StrictNonEmptyStringSchema,
  riskDecision: RiskDecisionSchema,
  reconciliation: ReconciliationSchema,
  sourceHash: Sha256Schema,
})
export type ProtectionIntentEvidence = typeof ProtectionIntentEvidenceSchema.Type

type Target = ExecutionDecisionDocument['targetPlan']['intentTargets'][number]
type Risk = ExecutionDecisionDocument['deltaRisk'][number]
export interface ExecutionOrderPlan {
  readonly intentId: string
  readonly decisionId: string
  readonly document: ExecutionDecisionDocument
  readonly target: Pick<Target, 'symbol' | 'side' | 'orderType' | 'timeInForce' | 'quantityAtoms'>
  readonly risk: Pick<Risk, 'limitPriceMicros' | 'protection'>
  readonly createdAt: string
  readonly submissionDeadlineAt: string
  readonly positionOwnerDecisionId: string
  readonly protectionIntent: ProtectionIntentEvidence | null
}

export const orderedExecutionPlan = (document: ExecutionDecisionDocument, index: number) =>
  Result.gen(function* () {
    const target = document.targetPlan.intentTargets[index]
    const risk = document.deltaRisk[index]
    const intentId = document.orderedIntentIds[index]
    if (target === undefined || risk === undefined || intentId === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Native order has no sealed target or risk terms' }),
      )
    return {
      intentId,
      decisionId: document.contentHash,
      document,
      target,
      risk,
      createdAt: document.createdAt,
      submissionDeadlineAt:
        [document.submissionCutoffAt, document.expiresAt, risk.evaluation.decision.expiresAt].toSorted()[0] ??
        document.submissionCutoffAt,
      positionOwnerDecisionId:
        document.strategyDecision !== undefined && 'entryDecisionHash' in document.strategyDecision
          ? document.strategyDecision.entryDecisionHash
          : document.contentHash,
      protectionIntent: null,
    } satisfies ExecutionOrderPlan
  })

/** Reproduce independent protection intents from immutable entry prices and committed risk material. */
export const executionOrderPlans = (
  decisions: readonly { readonly document: ExecutionDecisionDocument }[],
  protectionIntents: readonly ProtectionIntentEvidence[],
) =>
  Result.gen(function* () {
    const plans = new Map<string, ExecutionOrderPlan>()
    const documents = new Map(decisions.map(({ document }) => [document.contentHash, document]))
    for (const { document } of decisions)
      for (const [index, intentId] of document.orderedIntentIds.entries()) {
        if (plans.has(intentId))
          return yield* Result.fail(new SystemAssessmentError({ message: 'Ambiguous execution intent ownership' }))
        plans.set(intentId, yield* orderedExecutionPlan(document, index))
      }
    for (const evidence of protectionIntents) {
      const { sourceHash, ...material } = evidence
      const { plan, riskDecision: risk, reconciliation } = evidence
      const terms = plan.protection
      const document =
        terms !== undefined && terms._tag !== 'Bracket' ? documents.get(terms.entryDecisionHash) : undefined
      const entryPlan =
        document !== undefined && isProtectedEntryTarget(document.strategyDecision)
          ? document.strategyDecision.exitPolicy.plans[plan.symbol]
          : undefined
      const { contentHash, reconciliationId, ...reconciliationMaterial } = reconciliation
      const reconciliationValid =
        contentHash === (yield* canonicalHashV1Result({ ...reconciliationMaterial, reconciliationId })) &&
        reconciliationId ===
          (yield* canonicalHashV1Result({
            schemaVersion: legacyReconciliationIdSchemaVersion,
            material: reconciliationMaterial,
          }))
      const intent = yield* Result.mapError(
        makeExecutionIntentFromDecodedPlan(plan, evidence.authorityGenerationHash),
        () => new SystemAssessmentError({ message: 'Protection intent cannot reproduce its immutable identity' }),
      )
      yield* Result.mapError(
        validateCommitIdentity(intent, risk),
        () =>
          new SystemAssessmentError({ message: 'Protection risk approval cannot reproduce its immutable identity' }),
      )
      if (
        document === undefined ||
        entryPlan === undefined ||
        !document.dispatchable ||
        terms === undefined ||
        terms._tag === 'Bracket' ||
        sourceHash !== (yield* canonicalHashV1Result(material)) ||
        plans.has(evidence.intentId) ||
        intent.intentId !== evidence.intentId ||
        intent.clientOrderId !== evidence.clientOrderId ||
        risk.outcome !== RiskOutcome.Approved ||
        evidence.authorityGenerationHash !== document.bindings.authorityGenerationHash ||
        plan.accountId !== document.bindings.accountId ||
        plan.cycleId !== document.bindings.cycleId ||
        plan.decisionHash !== document.bindings.strategyDecisionHash ||
        plan.policyHash !== document.bindings.policyHash ||
        plan.strategyName !== document.bindings.strategyName ||
        plan.side !== OrderSide.Sell ||
        plan.createdAt < document.createdAt ||
        risk.decidedAt < plan.createdAt ||
        risk.expiresAt <= risk.decidedAt ||
        BigInt(plan.quantityAtoms) > BigInt(entryPlan.maximumQuantityAtoms) ||
        terms.stopPriceMicros !== entryPlan.levels.stopPriceMicros ||
        !reconciliationValid ||
        document.riskPolicy === undefined ||
        Date.parse(risk.decidedAt) - Date.parse(reconciliation.reconciledAt) >=
          (document.riskPolicy?.maxBrokerStateAgeMs ?? 0) ||
        Date.parse(risk.expiresAt) - Date.parse(risk.decidedAt) > (document.riskPolicy?.decisionTtlMs ?? 0) ||
        reconciliation.accountId !== plan.accountId ||
        reconciliation.status !== ReconciliationStatus.Exact ||
        reconciliation.reconciledAt > plan.createdAt ||
        plan.replanGenerationHash !==
          (yield* canonicalHashV1Result({
            entryDecisionHash: document.contentHash,
            reconciliationId: reconciliation.reconciliationId,
            protection: terms,
          })) ||
        (terms._tag === 'Oco'
          ? plan.orderType !== OrderType.Limit ||
            plan.timeInForce !== TimeInForce.Day ||
            BigInt(plan.quantityAtoms) % 1000000000n !== 0n ||
            plan.symbol.includes('/') ||
            plan.limitPriceMicros !== entryPlan.levels.profitLimitPriceMicros ||
            terms.stopLimitPriceMicros !== entryPlan.levels.stopLimitPriceMicros ||
            terms.profitLimitPriceMicros !== entryPlan.levels.profitLimitPriceMicros
          : plan.orderType !== OrderType.StopLimit ||
            plan.timeInForce !== (plan.symbol.includes('/') ? TimeInForce.GoodUntilCanceled : TimeInForce.Day) ||
            plan.limitPriceMicros !== entryPlan.levels.stopLimitPriceMicros)
      )
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'Protection intent differs from its owned entry plan, risk approval or reconciliation',
          }),
        )
      plans.set(evidence.intentId, {
        intentId: evidence.intentId,
        decisionId: evidence.intentId,
        document,
        target: plan,
        risk: { limitPriceMicros: plan.limitPriceMicros, protection: terms },
        createdAt: risk.decidedAt,
        submissionDeadlineAt: risk.expiresAt,
        positionOwnerDecisionId: document.contentHash,
        protectionIntent: evidence,
      })
    }
    return plans
  })
