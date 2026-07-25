import { Data, Result, Schema } from 'effect'

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

const ObserveShadowDecisionDocumentSemanticSchema = ObserveShadowDecisionDocumentBase.check(
  Schema.makeFilter((document) => materialIssues(document)),
)

const documentHashIssues = (
  document: typeof ObserveShadowDecisionDocumentSemanticSchema.Type,
): readonly Schema.FilterIssue[] => {
  const { contentHash, ...material } = document
  return contentHash === canonicalHashV1(material)
    ? []
    : [{ path: ['contentHash'], issue: 'must match the canonical shadow decision material' }]
}

export const ObserveShadowDecisionDocumentSchema = ObserveShadowDecisionDocumentSemanticSchema.check(
  Schema.makeFilter(documentHashIssues),
)
export type ObserveShadowDecisionDocument = typeof ObserveShadowDecisionDocumentSchema.Type

interface MakeShadowDecisionDocumentIssue {
  readonly operation: 'make'
  readonly reason: 'canonicalization' | 'contract'
}

interface DecodeShadowDecisionDocumentIssue {
  readonly operation: 'decode'
  readonly reason: 'contract'
}

type ShadowDecisionContractIssue = MakeShadowDecisionDocumentIssue | DecodeShadowDecisionDocumentIssue

interface ShadowDecisionContractFailureDetails {
  readonly message: string
  readonly cause?: unknown
}

export const ShadowDecisionContractFailure = Data.TaggedError('ShadowDecisionContractFailure')<
  ShadowDecisionContractIssue & ShadowDecisionContractFailureDetails
>
export type ShadowDecisionContractFailure = InstanceType<typeof ShadowDecisionContractFailure>

type ShadowDecisionContractReason<Operation extends ShadowDecisionContractIssue['operation']> = Extract<
  ShadowDecisionContractIssue,
  { readonly operation: Operation }
>['reason']

const makeDocumentFailure = (
  reason: ShadowDecisionContractReason<'make'>,
  message: string,
  cause?: unknown,
): ShadowDecisionContractFailure => new ShadowDecisionContractFailure({ operation: 'make', reason, message, cause })

const decodeDocumentFailure = (
  reason: ShadowDecisionContractReason<'decode'>,
  message: string,
  cause?: unknown,
): ShadowDecisionContractFailure => new ShadowDecisionContractFailure({ operation: 'decode', reason, message, cause })

const decodeDocumentResult = Schema.decodeUnknownResult(ObserveShadowDecisionDocumentSchema, strictParseOptions)

export const makeObserveShadowDecisionDocument = (
  material: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> => {
  if (typeof material !== 'object' || material === null || Array.isArray(material)) {
    return Result.fail(makeDocumentFailure('contract', 'shadow decision material must be an object'))
  }
  return Result.flatMap(
    Result.try({
      try: () => ({ ...material, contentHash: canonicalHashV1(material) }),
      catch: (cause) =>
        makeDocumentFailure('canonicalization', 'shadow decision material is not canonicalizable', cause),
    }),
    (candidate) =>
      Result.mapError(decodeDocumentResult(candidate), (cause) =>
        makeDocumentFailure('contract', 'shadow decision material failed its durable contract', cause),
      ),
  )
}

export const decodeObserveShadowDecisionDocument = (
  input: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> =>
  Result.mapError(decodeDocumentResult(input), (cause) =>
    decodeDocumentFailure('contract', 'shadow decision document failed its durable contract', cause),
  )
