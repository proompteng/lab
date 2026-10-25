import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { JevInstructionsSchema } from '../jev/instructions-contract'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export class ResearchError extends Data.TaggedError('ResearchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export const editorModel = 'qwen36-flamingo'
export const editorCheckpoint = '739af1e7aac320af1682ed1e0cce369af4c5265d'
export const maximumResearchStreamBytes = 2 * 1024 * 1024
export const maximumResearchReceiptBytes = 5 * 1024 * 1024
const Text = StrictNonEmptyStringSchema.check(Schema.isMaxLength(100_000))
const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const FlamingoResearchPolicySchema = Schema.Struct({
  model: Schema.Literal(editorModel),
  checkpoint: Schema.Literal(editorCheckpoint),
  servingImage: Schema.Literal('sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2'),
  tokenizerRevision: Schema.Literal(editorCheckpoint),
  chatTemplateRevision: Schema.Literal(editorCheckpoint),
  temperature: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  top_p: Unit,
  top_k: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  min_p: Unit,
  seed: NonNegativeIntegerSchema,
  presence_penalty: Schema.Finite.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
  frequency_penalty: Schema.Finite.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
  repetition_penalty: Schema.Finite.check(Schema.isGreaterThan(0)),
  enable_thinking: Schema.Boolean,
  max_tokens: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(4096)),
  stop: Schema.Array(Text).check(Schema.isMaxLength(8)),
})
export const OpenCodeResearchPolicySchema = Schema.Struct({
  harness: Schema.Literal('opencode'),
  harnessVersion: Schema.Literal('2.1.3'),
  model: Schema.Literal('glm-5.3-flash-free'),
  configurationHash: Sha256Schema,
  maximumModelCalls: Schema.Literal(1),
  maximumInputBytes: Schema.Literal(32768),
  temperature: Schema.Literal(0.6),
  max_tokens: Schema.Literal(4096),
})
export const ResearchPolicySchema = Schema.Union([FlamingoResearchPolicySchema, OpenCodeResearchPolicySchema])
export const ResearchRunSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-editor.v1'),
  purpose: Schema.Literal('prompt-edit'),
  sourceRevision: GitSourceRevisionSchema,
  studyHash: Sha256Schema,
  armManifestHashes: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isMaxLength(16), Schema.isUnique()),
  captureManifestHash: Sha256Schema,
  featureCutoff: UtcInstantSchema,
  registeredAt: UtcInstantSchema,
  deadlineAt: UtcInstantSchema,
  attempt: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(10)),
  promptTemplate: Text,
  context: Schema.Struct({
    memory: Schema.Struct({ sha256: Sha256Schema, availableAt: UtcInstantSchema, text: Text }),
  }),
  policy: ResearchPolicySchema,
  costBasis: Schema.NullOr(
    Schema.Struct({
      sourceEvidenceHash: Sha256Schema,
      effectiveFrom: UtcInstantSchema,
      effectiveUntil: UtcInstantSchema,
      allocation: Schema.Literal('reserved-capacity-wall-time'),
      picoUsdPerSecond: UnsignedMicrosSchema,
    }),
  ),
})
export type ResearchRun = typeof ResearchRunSchema.Type
const RetainedResearchRunSchema = Schema.Struct({
  ...ResearchRunSchema.fields,
  policy: Schema.Union([
    ResearchPolicySchema,
    Schema.Struct({
      ...FlamingoResearchPolicySchema.fields,
      model: Schema.Literal('qwen3-jev-editor-b968826d9c46'),
      checkpoint: Schema.Literal('b968826d9c46dd6066d109eabc6255188de91218'),
      tokenizerRevision: Schema.Literal('b968826d9c46dd6066d109eabc6255188de91218'),
      chatTemplateRevision: Schema.Literal('b968826d9c46dd6066d109eabc6255188de91218'),
    }),
  ]),
})
export type RetainedResearchRun = typeof RetainedResearchRunSchema.Type
const FlamingoServingIdentitySchema = Schema.Struct({
  model: StrictNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  checkpoint: GitSourceRevisionSchema,
  servingImage: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  tokenizerRevision: GitSourceRevisionSchema,
  chatTemplateRevision: GitSourceRevisionSchema,
})
export const ResearchServingIdentitySchema = Schema.Union([
  FlamingoServingIdentitySchema,
  Schema.Struct({
    harness: Schema.Literal('opencode'),
    harnessVersion: Schema.Literal('2.1.3'),
    model: Schema.Literal('glm-5.3-flash-free'),
    configurationHash: Sha256Schema,
  }),
])
export const researchServingIdentity = (policy: RetainedResearchRun['policy']) =>
  'harness' in policy
    ? {
        harness: policy.harness,
        harnessVersion: policy.harnessVersion,
        model: policy.model,
        configurationHash: policy.configurationHash,
      }
    : {
        model: policy.model,
        checkpoint: policy.checkpoint,
        servingImage: policy.servingImage,
        tokenizerRevision: policy.tokenizerRevision,
        chatTemplateRevision: policy.chatTemplateRevision,
      }

export const hashResearch = (input: unknown) =>
  canonicalHashV1Result(input).pipe(
    Result.mapError((cause) => new ResearchError({ message: 'Research evidence cannot be hashed', cause })),
  )

const validateResearchRun = <Run extends RetainedResearchRun>(run: Run) =>
  Result.gen(function* () {
    if (Buffer.byteLength(JSON.stringify(run)) > 262144)
      return yield* Result.fail(new ResearchError({ message: 'Research registration exceeds 256 KiB' }))
    if (sha256(run.context.memory.text) !== run.context.memory.sha256)
      return yield* Result.fail(
        new ResearchError({ message: 'Research context bytes differ from their retained hash' }),
      )
    if (
      run.registeredAt > run.featureCutoff ||
      run.deadlineAt <= run.featureCutoff ||
      Date.parse(run.deadlineAt) - Date.parse(run.featureCutoff) > 180_000
    )
      return yield* Result.fail(
        new ResearchError({ message: 'Research registration or deadline is outside the decision window' }),
      )
    if (run.context.memory.availableAt > run.featureCutoff)
      return yield* Result.fail(
        new ResearchError({ message: 'Research context contains evidence unavailable at its cutoff' }),
      )
    if (
      run.costBasis !== null &&
      (run.costBasis.effectiveFrom > run.featureCutoff ||
        run.costBasis.effectiveUntil < run.deadlineAt ||
        BigInt(run.costBasis.picoUsdPerSecond) === 0n ||
        BigInt(run.costBasis.picoUsdPerSecond) * 180n >= 2n ** 128n)
    )
      return yield* Result.fail(
        new ResearchError({
          message: 'Research cost basis does not cover the attempt or exceeds its positive ledger allocation bound',
        }),
      )
    return run
  })

export const decodeResearchRun = (input: unknown) =>
  Schema.decodeUnknownResult(
    ResearchRunSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new ResearchError({ message: 'Research run is malformed', cause })),
    Result.flatMap(validateResearchRun),
  )

export const decodeRetainedResearchRun = (input: unknown) =>
  Schema.decodeUnknownResult(
    RetainedResearchRunSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new ResearchError({ message: 'Retained research run is malformed', cause })),
    Result.flatMap(validateResearchRun),
  )

export const researchRequest = (run: RetainedResearchRun) => {
  if ('harness' in run.policy) return { schemaVersion: 'bayn.opencode-proposal.v1', registration: run }

  const {
    model,
    temperature,
    top_p,
    top_k,
    min_p,
    seed,
    presence_penalty,
    frequency_penalty,
    repetition_penalty,
    enable_thinking,
    max_tokens,
    stop,
  } = run.policy
  return {
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'bayn_jev_instructions',
        strict: true,
        schema: Schema.toJsonSchemaDocument(JevInstructionsSchema, { onExcessProperty: 'error' }).schema,
      },
    },
    temperature,
    top_p,
    top_k,
    min_p,
    seed,
    presence_penalty,
    frequency_penalty,
    repetition_penalty,
    max_tokens,
    stop,
    chat_template_kwargs: { enable_thinking },
    stream: true,
    stream_options: { include_usage: true },
    n: 1,
    messages: [
      {
        role: 'user',
        content: `${run.promptTemplate}\n\n${run.context.memory.text}\n\nReturn only the complete instruction JSON object with exactly one entry string field. Do not return context wrappers, XML tags, notes or other keys.`,
      },
    ],
  }
}

export enum ResearchOutcome {
  Complete = 'COMPLETE',
  Rejected = 'REJECTED',
  Expired = 'EXPIRED',
  Ambiguous = 'AMBIGUOUS',
  Unavailable = 'UNAVAILABLE',
}
const Base64Schema = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
)
export const OpenCodeEvidenceSchema = Schema.Struct({
  firstTokenAtMs: NonNegativeIntegerSchema,
  serverSourceRevision: GitSourceRevisionSchema,
  sessionId: StrictNonEmptyStringSchema.check(Schema.isMaxLength(128), Schema.isPattern(/^ses_[A-Za-z0-9]+$/)),
  studyHash: Sha256Schema,
  configurationHash: Sha256Schema,
  modelCalls: Schema.Literal(1),
  providerCostUsd: Schema.Literal(0),
  providerRequestHash: Sha256Schema,
  providerRequestBase64: Base64Schema.check(Schema.isMaxLength(4 * Math.ceil(32768 / 3))),
})
export const OpenCodeResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opencode-response.v1'),
  harnessEvidence: OpenCodeEvidenceSchema,
  providerResponseBase64: Base64Schema.check(Schema.isMaxLength(4 * Math.ceil(maximumResearchStreamBytes / 3))),
})
export const ResearchReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-receipt.v2'),
  workerSourceRevision: Schema.NullOr(GitSourceRevisionSchema),
  runId: Sha256Schema,
  requestHash: Sha256Schema,
  startedAtMs: NonNegativeIntegerSchema,
  completedAtMs: NonNegativeIntegerSchema,
  firstTokenAtMs: Schema.NullOr(NonNegativeIntegerSchema),
  outcome: Schema.Enum(ResearchOutcome),
  httpStatus: Schema.NullOr(NonNegativeIntegerSchema),
  servingIdentity: Schema.NullOr(ResearchServingIdentitySchema),
  harnessEvidence: Schema.optionalKey(OpenCodeEvidenceSchema),
  serverRequestId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(160))),
  responseHash: Schema.NullOr(Sha256Schema),
  responseText: Schema.String.check(Schema.isMaxLength(262144)),
  responseBase64: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(maximumResearchStreamBytes / 3)),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
  instructions: Schema.NullOr(JevInstructionsSchema),
  usage: Schema.NullOr(
    Schema.Struct({
      prompt_tokens: NonNegativeIntegerSchema,
      completion_tokens: NonNegativeIntegerSchema,
      total_tokens: NonNegativeIntegerSchema,
    }),
  ),
  costPicoUsd: Schema.NullOr(UnsignedMicrosSchema),
  qualification: Schema.Literal('UNQUALIFIED'),
  receiptHash: Sha256Schema,
})
export type ResearchReceipt = typeof ResearchReceiptSchema.Type

export const sealResearchReceipt = (
  run: RetainedResearchRun,
  material: Omit<ResearchReceipt, 'schemaVersion' | 'qualification' | 'receiptHash' | 'costPicoUsd'>,
) =>
  Result.gen(function* () {
    const cost =
      run.costBasis === null || material.outcome !== ResearchOutcome.Complete
        ? null
        : (
            (BigInt(Math.max(0, material.completedAtMs - material.startedAtMs)) *
              BigInt(run.costBasis.picoUsdPerSecond) +
              999n) /
            1000n
          ).toString()
    const receipt = {
      schemaVersion: 'bayn.research-receipt.v2' as const,
      ...material,
      costPicoUsd: cost,
      qualification: 'UNQUALIFIED' as const,
    }
    return { ...receipt, receiptHash: yield* hashResearch(receipt) }
  })

export const parseResearchOutput = (_run: RetainedResearchRun, output: string) =>
  Schema.decodeUnknownResult(
    Schema.fromJsonString(JevInstructionsSchema),
    strictParseOptions,
  )(output).pipe(
    Result.mapError(
      (cause) =>
        new ResearchError({ message: 'Jev editor must return only the native instruction JSON document', cause }),
    ),
  )
