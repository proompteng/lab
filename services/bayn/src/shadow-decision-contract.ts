import { Schema } from 'effect'

import { intentIdForPlan } from './execution/intents'
import { canonicalHashV1 } from './hash'
import { PositiveMicrosSchema, RiskOutcome } from './paper'
import { EvaluationSchema, Reason } from './risk'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from './schemas'
import { TargetPlanResultSchema, TargetPlanStatus } from './target-planner'

const ShadowDecisionBindingsSchema = Schema.Struct({
  strategyName: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  snapshotFinalizedAt: UtcInstantSchema,
  strategyDecisionHash: Sha256Schema,
  policyHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  accountSnapshotHash: Sha256Schema,
  planningBrokerStateHash: Sha256Schema,
  reconciliationId: Sha256Schema,
  reconciliationHash: Sha256Schema,
})
export type ShadowDecisionBindings = typeof ShadowDecisionBindingsSchema.Type

const DeltaRiskEvaluationSchema = Schema.Struct({
  notionalLimitMicros: PositiveMicrosSchema,
  evaluation: EvaluationSchema,
})
export type DeltaRiskEvaluation = typeof DeltaRiskEvaluationSchema.Type

const ObserveShadowDecisionMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.observe-shadow-decision.v1'),
  mode: Schema.Literal('OBSERVE'),
  dispatchable: Schema.Literal(false),
  bindings: ShadowDecisionBindingsSchema,
  targetPlan: TargetPlanResultSchema,
  deltaRisk: Schema.Array(DeltaRiskEvaluationSchema),
  createdAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})
export type ObserveShadowDecisionMaterial = typeof ObserveShadowDecisionMaterialSchema.Type

const materialIssues = (document: ObserveShadowDecisionMaterial): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (document.expiresAt !== document.submissionCutoffAt) {
    issues.push({ path: ['expiresAt'], issue: 'must equal the immutable cycle submission cutoff' })
  }
  if (document.createdAt >= document.submissionCutoffAt) {
    issues.push({ path: ['createdAt'], issue: 'must precede the immutable cycle submission cutoff' })
  }

  const targets = document.targetPlan.intentTargets
  const expectedRiskCount = document.targetPlan.status === TargetPlanStatus.Planned ? targets.length : 0
  if (document.deltaRisk.length !== expectedRiskCount) {
    issues.push({ path: ['deltaRisk'], issue: 'must align one-for-one with the ordered planned target deltas' })
  }
  for (const [index, target] of targets.entries()) {
    if (
      target.strategyName !== document.bindings.strategyName ||
      target.cycleId !== document.bindings.cycleId ||
      target.decisionHash !== document.bindings.strategyDecisionHash ||
      target.policyHash !== document.bindings.policyHash ||
      target.accountId !== document.bindings.accountId ||
      target.createdAt !== document.createdAt
    ) {
      issues.push({ path: ['targetPlan', 'intentTargets', index], issue: 'must match the shadow decision bindings' })
    }
  }
  for (const [index, risk] of document.deltaRisk.entries()) {
    const evaluation = risk.evaluation
    const target = targets[index]
    if (
      target !== undefined &&
      evaluation.input.intentId !==
        intentIdForPlan({
          schemaVersion: 'bayn.paper-intent-plan.v1',
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
        })
    ) {
      issues.push({
        path: ['deltaRisk', index, 'evaluation', 'input', 'intentId'],
        issue: 'must bind the corresponding ordered target delta',
      })
    }
    if (evaluation.policyHash !== document.bindings.policyHash) {
      issues.push({ path: ['deltaRisk', index, 'evaluation', 'policyHash'], issue: 'must match the bound policy' })
    }
    if (
      evaluation.decision.outcome !== RiskOutcome.Blocked ||
      !evaluation.decision.reasonCodes.includes(Reason.AuthorityNotPaper)
    ) {
      issues.push({
        path: ['deltaRisk', index, 'evaluation', 'decision'],
        issue: 'OBSERVE risk must remain blocked by non-paper authority',
      })
    }
    if (
      evaluation.decision.decidedAt !== document.createdAt ||
      evaluation.decision.expiresAt > document.submissionCutoffAt
    ) {
      issues.push({
        path: ['deltaRisk', index, 'evaluation', 'decision'],
        issue: 'must be evaluated with this shadow decision and expire by the cycle cutoff',
      })
    }
  }
  return issues
}

const ObserveShadowDecisionDocumentBase = Schema.Struct({
  ...ObserveShadowDecisionMaterialSchema.fields,
  contentHash: Sha256Schema,
})

export const ObserveShadowDecisionDocumentSchema = ObserveShadowDecisionDocumentBase.check(
  Schema.makeFilter((document: typeof ObserveShadowDecisionDocumentBase.Type): readonly Schema.FilterIssue[] => {
    const { contentHash, ...material } = document
    const issues = [...materialIssues(material)]
    if (contentHash !== canonicalHashV1(material)) {
      issues.push({ path: ['contentHash'], issue: 'must match the canonical shadow decision material' })
    }
    return issues
  }),
)
export type ObserveShadowDecisionDocument = typeof ObserveShadowDecisionDocumentSchema.Type

const decodeDocumentSync = Schema.decodeUnknownSync(ObserveShadowDecisionDocumentSchema, strictParseOptions)

export const makeObserveShadowDecisionDocument = (
  material: ObserveShadowDecisionMaterial,
): ObserveShadowDecisionDocument => decodeDocumentSync({ ...material, contentHash: canonicalHashV1(material) })

export const decodeObserveShadowDecisionDocument = Schema.decodeUnknownEffect(
  ObserveShadowDecisionDocumentSchema,
  strictParseOptions,
)
