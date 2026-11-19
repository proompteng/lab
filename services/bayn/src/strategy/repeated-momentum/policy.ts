import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../../contracts'
import { canonicalHashV1Result, sha256 } from '../../hash'
import { JevContractError } from '../../jev/contract'
import { JevProtocolSchema, type JevProtocolMaterial } from '../../jev/protocol'
import { strictParseOptions } from '../../schemas'

export const repeatedMomentumPromptPolicy = {
  schemaVersion: 'bayn.repeated-momentum-prompts.v1',
  providers: [],
} as const
export const repeatedMomentumPromptsHash = () => canonicalHashV1Result(repeatedMomentumPromptPolicy)

export const momentumExitDefinition = { protectiveStopBps: 50, profitTargetNetBps: 100 } as const
export enum MomentumSelection {
  PositiveRelativeReturn = 'POSITIVE_RETURN_AND_EXCESS_RETURN_DESCENDING_THEN_SYMBOL',
}

export const RepeatedMomentumPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.repeated-momentum-policy.v1'),
  sharedProtocol: JevProtocolSchema,
  selection: Schema.Enum(MomentumSelection),
  reference: Schema.Literal('COMMON_OBSERVED_MINUTE_WITH_NATIVE_BENCHMARK_PRICING'),
  maximumPositions: Schema.Literal(1),
  unfundedSelection: Schema.Literal('ABSTAIN_WITHOUT_RESELECTION'),
  providers: Schema.Literal('NONE'),
  exits: Schema.Struct({
    protectiveStopBps: Schema.Literal(momentumExitDefinition.protectiveStopBps),
    profitTargetNetBps: Schema.Literal(momentumExitDefinition.profitTargetNetBps),
    riskAndManagement: Schema.Literal('SHARED_NATIVE_EXECUTION'),
  }),
})
export type RepeatedMomentumPolicy = typeof RepeatedMomentumPolicySchema.Type
export const repeatedMomentumBehaviorHash = sha256('bayn.repeated-momentum.behavior.v1')

export const makeRepeatedMomentumPolicy = <P extends JevProtocolMaterial>(
  sharedProtocol: P,
): Omit<RepeatedMomentumPolicy, 'sharedProtocol'> & { readonly sharedProtocol: P } => ({
  schemaVersion: 'bayn.repeated-momentum-policy.v1',
  sharedProtocol,
  selection: MomentumSelection.PositiveRelativeReturn,
  reference: 'COMMON_OBSERVED_MINUTE_WITH_NATIVE_BENCHMARK_PRICING',
  maximumPositions: 1,
  unfundedSelection: 'ABSTAIN_WITHOUT_RESELECTION',
  providers: 'NONE',
  exits: { ...momentumExitDefinition, riskAndManagement: 'SHARED_NATIVE_EXECUTION' },
})

export const decodeRepeatedMomentumPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    RepeatedMomentumPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Repeated momentum policy is invalid', cause })),
  )

export const repeatedMomentumStrategyIdentity = (
  policy: Omit<RepeatedMomentumPolicy, 'sharedProtocol'> & { readonly sharedProtocol: JevProtocolMaterial },
) =>
  Result.gen(function* () {
    const strategy = {
      name: 'jev' as const,
      behaviorHash: repeatedMomentumBehaviorHash,
      parameterHash: yield* canonicalHashV1Result(policy),
      parameterSchemaVersion: policy.schemaVersion,
    }
    return { strategy, protocolHash: yield* makeStrategyProtocolHashResult(strategy) }
  })
