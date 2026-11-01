import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result, sha256 } from '../hash'
import { strictParseOptions } from '../schemas'
import { stagedChartQuestionPolicy } from './staged-chart-questions'
import { JevContractError } from './contract'
import { EntryAblationSelection } from './entry-inference-input'
import { JevProtocolSchema, type JevProtocolMaterial } from './protocol'
import { stagedChartQuestionPolicy as filteredChartPolicy } from './retained-filtered-staged-chart-questions'
import { stagedChartQuestionPolicy as candidateChartPolicy } from './retained-candidate-staged-chart-questions'

export const entryAblationQuestionPolicyHash = Result.getOrThrow(canonicalHashV1Result(stagedChartQuestionPolicy))
export const entryAblationBehaviorHash = sha256('bayn.chart-entry-ablation.behavior.v1')

export const historicalAblationQuestionPolicyHash = (protocol: JevProtocolMaterial) =>
  canonicalHashV1Result(
    protocol.schemaVersion === 'bayn.jev.protocol.v36' || protocol.schemaVersion === 'bayn.jev.protocol.v35'
      ? stagedChartQuestionPolicy
      : protocol.schemaVersion === 'bayn.jev.protocol.v33' || protocol.schemaVersion === 'bayn.jev.protocol.v34'
        ? candidateChartPolicy
        : filteredChartPolicy,
  )

export const EntryAblationPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-ablation-policy.v1'),
  sharedProtocol: JevProtocolSchema,
  selectionPolicy: Schema.Enum(EntryAblationSelection),
  questionPolicyHash: Schema.Literal(entryAblationQuestionPolicyHash),
  jevStage: Schema.Literal('OMITTED_BY_POLICY'),
})
export type EntryAblationPolicy = typeof EntryAblationPolicySchema.Type

/** Freeze the changed selection and provider lifecycle alongside the complete shared trading protocol. */
type AblationMaterial<P extends JevProtocolMaterial> = Omit<
  EntryAblationPolicy,
  'sharedProtocol' | 'questionPolicyHash'
> & { readonly sharedProtocol: P; readonly questionPolicyHash: string }
export const makeEntryAblationPolicy = <P extends JevProtocolMaterial>(
  sharedProtocol: P,
  questionPolicyHash = entryAblationQuestionPolicyHash,
): AblationMaterial<P> => ({
  schemaVersion: 'bayn.entry-ablation-policy.v1',
  sharedProtocol,
  selectionPolicy: EntryAblationSelection.LowestModeledLoss,
  questionPolicyHash,
  jevStage: 'OMITTED_BY_POLICY',
})

export const decodeEntryAblationPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    EntryAblationPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Entry ablation policy is invalid', cause })),
  )

export const entryAblationStrategyIdentity = (policy: AblationMaterial<JevProtocolMaterial>) =>
  Result.gen(function* () {
    const strategy = {
      name: 'jev' as const,
      behaviorHash: entryAblationBehaviorHash,
      parameterHash: yield* canonicalHashV1Result(policy),
      parameterSchemaVersion: policy.schemaVersion,
    }
    return { strategy, protocolHash: yield* makeStrategyProtocolHashResult(strategy) }
  })
