import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result, sha256 } from '../hash'
import { strictParseOptions } from '../schemas'
import { stagedChartQuestionPolicy } from './staged-chart-questions'
import { JevContractError } from './contract'
import { EntryAblationSelection } from './entry-inference-input'
import { JevProtocolSchema, type JevProtocol } from './protocol'

export const entryAblationQuestionPolicyHash = Result.getOrThrow(canonicalHashV1Result(stagedChartQuestionPolicy))
export const entryAblationBehaviorHash = sha256('bayn.chart-entry-ablation.behavior.v1')

export const EntryAblationPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-ablation-policy.v1'),
  sharedProtocol: JevProtocolSchema,
  selectionPolicy: Schema.Enum(EntryAblationSelection),
  questionPolicyHash: Schema.Literal(entryAblationQuestionPolicyHash),
  jevStage: Schema.Literal('OMITTED_BY_POLICY'),
})
export type EntryAblationPolicy = typeof EntryAblationPolicySchema.Type

/** Freeze the changed selection and provider lifecycle alongside the complete shared trading protocol. */
export const makeEntryAblationPolicy = (sharedProtocol: JevProtocol): EntryAblationPolicy => ({
  schemaVersion: 'bayn.entry-ablation-policy.v1',
  sharedProtocol,
  selectionPolicy: EntryAblationSelection.LowestModeledLoss,
  questionPolicyHash: entryAblationQuestionPolicyHash,
  jevStage: 'OMITTED_BY_POLICY',
})

export const decodeEntryAblationPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    EntryAblationPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Entry ablation policy is invalid', cause })),
  )

export const entryAblationStrategyIdentity = (policy: EntryAblationPolicy) =>
  Result.gen(function* () {
    const strategy = {
      name: 'jev' as const,
      behaviorHash: entryAblationBehaviorHash,
      parameterHash: yield* canonicalHashV1Result(policy),
      parameterSchemaVersion: policy.schemaVersion,
    }
    return { strategy, protocolHash: yield* makeStrategyProtocolHashResult(strategy) }
  })
