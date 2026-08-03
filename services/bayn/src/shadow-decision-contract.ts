import { Data, Result, Schema } from 'effect'

import { intentIdForPlan, paperIntentIdForDecodedPlan } from './execution/intents/domain'
import { ExecutionSessionBindingSchema } from './execution-session'
import { canonicalHashV1Result } from './hash'
import { OrderSide, PositiveMicrosSchema, RiskOutcome } from './execution/contracts'
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
    if (target !== undefined) {
      const identity = intentIdForPlan({
        schemaVersion: 'bayn.paper-intent-plan.v1',
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
      })
      if (Result.isFailure(identity)) {
        issues.push({
          path: ['deltaRisk', index, 'evaluation', 'input', 'intentId'],
          issue: 'corresponding ordered target delta must have a canonical identity',
        })
      } else if (evaluation.input.intentId !== identity.success) {
        issues.push({
          path: ['deltaRisk', index, 'evaluation', 'input', 'intentId'],
          issue: 'must bind the corresponding ordered target delta',
        })
      }
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
  const expectedHash = canonicalHashV1Result(material)
  if (Result.isFailure(expectedHash)) {
    return [{ path: ['contentHash'], issue: 'shadow decision material must be canonicalizable' }]
  }
  return contentHash === expectedHash.success
    ? []
    : [{ path: ['contentHash'], issue: 'must match the canonical shadow decision material' }]
}

export const ObserveShadowDecisionDocumentSchema = ObserveShadowDecisionDocumentSemanticSchema.check(
  Schema.makeFilter(documentHashIssues),
)
export type ObserveShadowDecisionDocument = typeof ObserveShadowDecisionDocumentSchema.Type

const PaperDecisionBindingsSchema = Schema.Struct({
  ...ShadowDecisionBindingsSchema.fields,
  qualificationRunId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
})

const PaperRiskBlockSchema = Schema.Struct({
  intentId: Sha256Schema,
  decisionId: Sha256Schema,
  reasonCodes: Schema.Array(StrictNonEmptyStringSchema).check(Schema.isMinLength(1), Schema.isUnique()),
})

const PaperDecisionMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-cycle-decision.v1'),
  mode: Schema.Literal('PAPER'),
  dispatchable: Schema.Boolean,
  bindings: PaperDecisionBindingsSchema,
  /** Persist the complete signal/session binding so a close plan can be built after data services expire. */
  executionSession: Schema.optionalKey(ExecutionSessionBindingSchema),
  targetPlan: TargetPlanResultSchema,
  deltaRisk: Schema.Array(DeltaRiskEvaluationSchema),
  orderedIntentIds: Schema.Array(Sha256Schema),
  riskBlock: Schema.optionalKey(PaperRiskBlockSchema),
  /** Previous close-plan content hash used to derive a distinct residual close identity. */
  replanGenerationHash: Schema.optionalKey(Sha256Schema),
  createdAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})

const paperMaterialIssues = (document: typeof PaperDecisionMaterialSchema.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (document.expiresAt !== document.submissionCutoffAt) {
    issues.push({ path: ['expiresAt'], issue: 'must equal the immutable cycle submission cutoff' })
  }
  if (document.createdAt >= document.expiresAt) {
    issues.push({ path: ['createdAt'], issue: 'must precede PAPER authority expiry' })
  }
  const targets = document.targetPlan.intentTargets
  const planned = document.targetPlan.status === TargetPlanStatus.Planned
  const riskBlocked = document.riskBlock !== undefined
  const riskCount = document.deltaRisk.length
  if (
    document.orderedIntentIds.length !== riskCount ||
    (planned && !riskBlocked && riskCount !== targets.length) ||
    (planned && riskBlocked && (riskCount < 1 || riskCount > targets.length)) ||
    (!planned && riskCount !== 0)
  ) {
    issues.push({
      path: ['orderedIntentIds'],
      issue: 'must align with the exact executable plan or cumulative risk-block prefix',
    })
  }
  if (
    (planned && riskBlocked && document.dispatchable) ||
    (planned && !riskBlocked && !document.dispatchable) ||
    (!planned && (!document.dispatchable || riskBlocked))
  ) {
    issues.push({
      path: ['dispatchable'],
      issue: 'must be false only for a planned PAPER decision with exact blocked risk evidence',
    })
  }
  if (new Set(document.orderedIntentIds).size !== document.orderedIntentIds.length) {
    issues.push({ path: ['orderedIntentIds'], issue: 'must not contain duplicate intent identities' })
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
      issues.push({ path: ['targetPlan', 'intentTargets', index], issue: 'must match the PAPER decision bindings' })
    }
    const risk = document.deltaRisk[index]
    if (risk === undefined) continue
    const plan = {
      schemaVersion: 'bayn.paper-intent-plan.v1',
      ...target,
      notionalLimitMicros: risk.notionalLimitMicros,
      ...(document.replanGenerationHash === undefined ? {} : { replanGenerationHash: document.replanGenerationHash }),
    } as const
    const identity = paperIntentIdForDecodedPlan(plan, document.bindings.authorityGenerationHash)
    if (Result.isFailure(identity) || document.orderedIntentIds[index] !== identity.success) {
      issues.push({ path: ['orderedIntentIds', index], issue: 'must bind the exact ordered target content' })
    }
    if (risk.evaluation.input.intentId !== document.orderedIntentIds[index]) {
      issues.push({ path: ['deltaRisk', index], issue: 'must bind the corresponding ordered intent identity' })
    }
    const notional = BigInt(risk.notionalLimitMicros)
    const previousRisk = document.deltaRisk[index - 1]
    const expectedAggregateBuyingPower =
      (previousRisk === undefined ? 0n : BigInt(previousRisk.evaluation.metrics.aggregateBuyingPowerMicros)) +
      (target.side === OrderSide.Buy ? notional : 0n)
    const expectedOutcome = riskBlocked && index === riskCount - 1 ? RiskOutcome.Blocked : RiskOutcome.Approved
    if (
      risk.evaluation.policyHash !== document.bindings.policyHash ||
      risk.evaluation.input.evaluatedAt !== document.createdAt ||
      risk.evaluation.decision.outcome !== expectedOutcome ||
      risk.evaluation.decision.decidedAt !== document.createdAt ||
      risk.evaluation.decision.expiresAt > document.expiresAt ||
      risk.evaluation.metrics.orderNotionalMicros !== risk.notionalLimitMicros ||
      BigInt(risk.evaluation.metrics.aggregateBuyingPowerMicros) !== expectedAggregateBuyingPower ||
      (previousRisk !== undefined &&
        BigInt(risk.evaluation.metrics.dailyTradedNotionalMicros) !==
          BigInt(previousRisk.evaluation.metrics.dailyTradedNotionalMicros) + notional)
    ) {
      issues.push({
        path: ['deltaRisk', index],
        issue: 'must contain complete cumulative PAPER risk evidence through the first blocked delta',
      })
    }
  }
  if (document.riskBlock !== undefined) {
    const blockedRisk = document.deltaRisk.at(-1)
    const blockedDecision = blockedRisk?.evaluation.decision
    const knownReasonCodes = Object.values(Reason)
    if (
      blockedDecision === undefined ||
      blockedDecision.outcome !== RiskOutcome.Blocked ||
      blockedDecision.intentId !== document.riskBlock.intentId ||
      blockedDecision.decisionId !== document.riskBlock.decisionId ||
      blockedDecision.reasonCodes.length !== document.riskBlock.reasonCodes.length ||
      blockedDecision.reasonCodes.some((reason, index) => reason !== document.riskBlock?.reasonCodes[index]) ||
      blockedDecision.reasonCodes.some((reason) => !knownReasonCodes.includes(reason as Reason)) ||
      blockedDecision.reasonCodes.includes(Reason.AuthorityNotPaper)
    ) {
      issues.push({
        path: ['riskBlock'],
        issue: 'must bind the final blocked PAPER risk decision and its exact non-authority reasons',
      })
    }
  }
  return issues
}

const PaperDecisionDocumentSemanticSchema = Schema.Struct({
  ...PaperDecisionMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(Schema.makeFilter(paperMaterialIssues))

export const PaperDecisionDocumentSchema = PaperDecisionDocumentSemanticSchema.check(
  Schema.makeFilter((document) => {
    const { contentHash, ...material } = document
    const expectedHash = canonicalHashV1Result(material)
    return Result.isFailure(expectedHash) || expectedHash.success !== contentHash
      ? [{ path: ['contentHash'], issue: 'must match the canonical PAPER decision material' }]
      : []
  }),
)
export type PaperDecisionDocument = typeof PaperDecisionDocumentSchema.Type

export const CycleDecisionDocumentSchema = Schema.Union([
  ObserveShadowDecisionDocumentSchema,
  PaperDecisionDocumentSchema,
])
export type CycleDecisionDocument = typeof CycleDecisionDocumentSchema.Type

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
const decodePaperDocumentResult = Schema.decodeUnknownResult(PaperDecisionDocumentSchema, strictParseOptions)

export const makeObserveShadowDecisionDocument = (
  material: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> => {
  if (typeof material !== 'object' || material === null || Array.isArray(material)) {
    return Result.fail(makeDocumentFailure('contract', 'shadow decision material must be an object'))
  }
  return Result.flatMap(
    Result.mapError(canonicalHashV1Result(material), (cause) =>
      makeDocumentFailure('canonicalization', 'shadow decision material is not canonicalizable', cause),
    ),
    (contentHash) =>
      Result.flatMap(
        Result.try({
          try: () => ({ ...material, contentHash }),
          catch: (cause) =>
            makeDocumentFailure('canonicalization', 'shadow decision material is not canonicalizable', cause),
        }),
        (candidate) =>
          Result.mapError(decodeDocumentResult(candidate), (cause) =>
            makeDocumentFailure('contract', 'shadow decision material failed its durable contract', cause),
          ),
      ),
  )
}

export const decodeObserveShadowDecisionDocument = (
  input: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionContractFailure> =>
  Result.mapError(decodeDocumentResult(input), (cause) =>
    decodeDocumentFailure('contract', 'shadow decision document failed its durable contract', cause),
  )

export const makePaperDecisionDocument = (
  material: unknown,
): Result.Result<PaperDecisionDocument, ShadowDecisionContractFailure> => {
  if (typeof material !== 'object' || material === null || Array.isArray(material)) {
    return Result.fail(makeDocumentFailure('contract', 'PAPER decision material must be an object'))
  }
  return Result.flatMap(
    Result.mapError(canonicalHashV1Result(material), (cause) =>
      makeDocumentFailure('canonicalization', 'PAPER decision material is not canonicalizable', cause),
    ),
    (contentHash) =>
      Result.mapError(decodePaperDocumentResult({ ...material, contentHash }), (cause) =>
        makeDocumentFailure('contract', 'PAPER decision material failed its durable contract', cause),
      ),
  )
}

export const decodePaperDecisionDocument = (
  input: unknown,
): Result.Result<PaperDecisionDocument, ShadowDecisionContractFailure> =>
  Result.mapError(decodePaperDocumentResult(input), (cause) =>
    decodeDocumentFailure('contract', 'PAPER decision document failed its durable contract', cause),
  )
