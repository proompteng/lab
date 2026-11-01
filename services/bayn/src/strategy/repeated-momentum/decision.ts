import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { JevContractError } from '../../jev/contract'
import { JevPositionExitPolicySchema, positionProtectionIntervalMs } from '../../jev/exit-policy'
import { reproduceJevCandidateObservation } from '../../jev/observation'
import { JevObservationSchema } from '../../jev/observation-contract'
import { JevPurpose } from '../../jev/portfolio'
import { isContinuousMarket } from '../../market-hours'
import {
  IsoDateSchema,
  Sha256Schema,
  SymbolSchema,
  UnitIntervalSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { MomentumFundedExitPlanSchema, makeMomentumFundedExitPlan } from './exit-plan'
import { RepeatedMomentumPolicySchema, type RepeatedMomentumPolicy } from './policy'
import { momentumControlCandidates } from './signals'
import type { StrategyDefinition } from '../core'

const PositiveIntegerString = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))

export enum MomentumDecisionReason {
  Selected = 'POSITIVE_RELATIVE_MOMENTUM',
  NoSignal = 'NO_POSITIVE_RELATIVE_MOMENTUM',
  Unfunded = 'SELECTED_SIGNAL_UNFUNDED',
}
export const MomentumDecisionEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.repeated-momentum-evidence.v1'),
  observation: JevObservationSchema,
  decidedAt: UtcInstantSchema,
})
export type MomentumDecisionEvidence = typeof MomentumDecisionEvidenceSchema.Type

const deriveMomentumTarget = (policy: RepeatedMomentumPolicy, evidence: MomentumDecisionEvidence) =>
  Result.gen(function* () {
    const observation = yield* reproduceJevCandidateObservation(evidence.observation)
    const protocol = policy.sharedProtocol
    const decided = Date.parse(evidence.decidedAt)
    const hours = observation.snapshot.manifest.calendar
    const session = isContinuousMarket(hours)
      ? undefined
      : hours.sessions.find((entry) => entry.date === observation.snapshot.manifest.sessionDate)
    if (
      observation.portfolio.purpose !== JevPurpose.Entry ||
      (yield* canonicalHashV1Result(protocol)) !== (yield* canonicalHashV1Result(observation.protocol)) ||
      decided < Date.parse(observation.observedAt) ||
      decided >= Date.parse(observation.observedAt) + protocol.inferenceValidityMs ||
      (!isContinuousMarket(hours) &&
        (session === undefined ||
          decided >= Date.parse(session.closeAt) - protocol.entryCutoffMinutesBeforeClose * 60000))
    )
      return yield* Result.fail(
        new JevContractError({
          message: 'Momentum decision differs from its flat source, protocol or original deadline',
        }),
      )
    const signals = yield* momentumControlCandidates(observation.snapshot)
    const selected = signals[0]
    const funded =
      selected === undefined ? null : yield* makeMomentumFundedExitPlan(policy, observation, selected.symbol)
    const plans: Record<string, typeof MomentumFundedExitPlanSchema.Type> = {}
    if (selected !== undefined && funded !== null) plans[selected.symbol] = funded.plan
    return {
      schemaVersion: 'bayn.repeated-momentum-target.v1' as const,
      strategy: 'jev' as const,
      policy,
      evidence,
      reason:
        selected === undefined
          ? MomentumDecisionReason.NoSignal
          : funded === null
            ? MomentumDecisionReason.Unfunded
            : MomentumDecisionReason.Selected,
      sessionDate: yield* Schema.decodeUnknownResult(IsoDateSchema)(observation.snapshot.manifest.sessionDate),
      snapshotId: observation.snapshot.manifest.snapshotId,
      observedAt: observation.observedAt,
      decidedAt: evidence.decidedAt,
      calendarHash: yield* canonicalHashV1Result(hours),
      signals: signals.map(({ symbol, excessReturn }) => ({
        symbol,
        numerator: excessReturn.numerator.toString(),
        denominator: excessReturn.denominator.toString(),
      })),
      selectedSymbols: selected === undefined || funded === null ? [] : [selected.symbol],
      targetWeights: Object.fromEntries(
        protocol.candidateSymbols.map((symbol) => [
          symbol,
          selected?.symbol === symbol && funded !== null ? funded.weight : 0,
        ]),
      ),
      exitPolicy: {
        schemaVersion: 'bayn.position-exit-policy.v5' as const,
        maximumPriceCheckIntervalMs: positionProtectionIntervalMs,
        maximumHoldingMinutes: protocol.maximumHoldingMinutes,
        plans,
      },
    }
  })

export const decideRepeatedMomentumEntry = (input: unknown, policy: RepeatedMomentumPolicy) =>
  Result.gen(function* () {
    const verifiedPolicy = yield* Schema.decodeUnknownResult(RepeatedMomentumPolicySchema, strictParseOptions)(policy)
    const evidence = yield* Schema.decodeUnknownResult(MomentumDecisionEvidenceSchema, strictParseOptions)(input)
    return yield* deriveMomentumTarget(verifiedPolicy, evidence)
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Repeated momentum target could not be derived', cause }),
    ),
  )

export const RepeatedMomentumTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.repeated-momentum-target.v1'),
  strategy: Schema.Literal('jev'),
  policy: RepeatedMomentumPolicySchema,
  evidence: MomentumDecisionEvidenceSchema,
  reason: Schema.Enum(MomentumDecisionReason),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  decidedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  signals: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      numerator: PositiveIntegerString,
      denominator: PositiveIntegerString,
    }),
  ),
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isMaxLength(1), Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  exitPolicy: Schema.Struct({
    ...JevPositionExitPolicySchema.fields,
    plans: Schema.Record(SymbolSchema, MomentumFundedExitPlanSchema),
  }),
}).check(
  Schema.makeFilter((target) => {
    const reproduced = deriveMomentumTarget(target.policy, target.evidence).pipe(Result.flatMap(canonicalHashV1Result))
    const observed = canonicalHashV1Result(target)
    return Result.isSuccess(reproduced) && Result.isSuccess(observed) && reproduced.success === observed.success
      ? []
      : [{ path: [], issue: 'momentum target must reproduce its complete policy and causal source' }]
  }),
)
export type RepeatedMomentumTarget = typeof RepeatedMomentumTargetSchema.Type

export const makeRepeatedMomentumDefinition = (
  policy: RepeatedMomentumPolicy,
): StrategyDefinition<MomentumDecisionEvidence, JevContractError, RepeatedMomentumTarget, RepeatedMomentumPolicy> => ({
  name: 'jev',
  holdingPeriod: 'INTRADAY',
  parameters: policy,
  decide: ({ market }) => decideRepeatedMomentumEntry(market, policy),
})
