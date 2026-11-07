import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { isContinuousMarket } from '../market-hours'
import { strictParseOptions, UtcInstantSchema } from '../schemas'
import { JevBatchPlanVersion, JevBatchResultSchema, JevCandidatePlanStatus } from './batch'
import { JevContractError } from './contract'
import { ChartEntryTargetFields, makeChartEntryTargetMaterial, selectJevEntryCandidates } from './decision'
import { deriveJevExitTargetMaterial, JevExitEvidenceSchema, JevExitTargetSchema } from './exit'
import { reproduceRetainedJevV38CandidateObservation } from './observation'
import { RetainedJevV38ObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import { RetainedJevProtocolV38Schema } from './protocol'
import {
  reproduceRetainedJevV38TradingSignalBatchEvidence,
  retainedJevV38BatchInferencesAt,
  RetainedJevV38BatchPlanSchema,
} from './retained-v38-trading-signals'

export const RetainedJevV38DecisionEvidenceSchema = Schema.Struct({
  observation: RetainedJevV38ObservationSchema,
  batchPlan: RetainedJevV38BatchPlanSchema,
  batchResult: JevBatchResultSchema,
  decidedAt: UtcInstantSchema,
})
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

/** Verify the original complete source once before reproducing its native or control target. */
export const reproduceRetainedJevV38DecisionSource = (input: unknown, version: JevBatchPlanVersion) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(RetainedJevV38DecisionEvidenceSchema, strictParseOptions)(input)
    const observation = yield* reproduceRetainedJevV38CandidateObservation(evidence.observation)
    const plan = yield* reproduceRetainedJevV38TradingSignalBatchEvidence(evidence.observation, evidence.batchPlan)
    if (observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* invalid('Retained v38 entry requires its original flat entry observation')
    const inferences = yield* retainedJevV38BatchInferencesAt(
      plan,
      evidence.batchResult,
      Date.parse(evidence.decidedAt),
      version,
    )
    const hours = observation.snapshot.manifest.calendar
    const session = isContinuousMarket(hours)
      ? undefined
      : hours.sessions.find((value) => value.date === observation.snapshot.manifest.sessionDate)
    if (
      !isContinuousMarket(hours) &&
      (session === undefined ||
        Date.parse(evidence.decidedAt) >=
          Date.parse(session.closeAt) - observation.protocol.entryCutoffMinutesBeforeClose * 60_000)
    )
      return yield* invalid('Retained v38 entry decision is beyond its original market cutoff')
    return {
      evidence,
      observation,
      inferences,
      calendar: { executionCalendarHash: yield* canonicalHashV1Result(hours) },
    }
  })

/** Original v38 target reconstruction for immutable operational evidence; never an admission path. */
export const reproduceRetainedJevV38EntryTarget = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceRetainedJevV38DecisionSource(input, JevBatchPlanVersion.V8)
    const selection = yield* selectJevEntryCandidates(
      source.observation,
      source.inferences,
      source.evidence.batchPlan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested),
    )
    return {
      schemaVersion: 'bayn.jev-entry-target.v7' as const,
      strategy: 'jev' as const,
      ...(yield* makeChartEntryTargetMaterial(source, selection)),
    }
  })
const same = (left: unknown, right: unknown) => {
  const a = canonicalHashV1Result(left)
  const b = canonicalHashV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
}

export const RetainedJevV38EntryTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-target.v7'),
  strategy: Schema.Literal('jev'),
  ...ChartEntryTargetFields,
  evidence: RetainedJevV38DecisionEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevV38EntryTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 candidate evidence must reproduce the exact retained target' }]
  }),
)

const RetainedExitEvidenceSchema = Schema.Struct({
  ...JevExitEvidenceSchema.fields,
  protocol: RetainedJevProtocolV38Schema,
})

export const reproduceRetainedJevV38ExitTarget = (input: unknown) =>
  Schema.decodeUnknownResult(
    RetainedExitEvidenceSchema,
    strictParseOptions,
  )(input).pipe(Result.flatMap(deriveJevExitTargetMaterial))

export const RetainedJevV38ExitTargetSchema = Schema.Struct({
  ...JevExitTargetSchema.fields,
  evidence: RetainedExitEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevV38ExitTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 exit evidence must reproduce the exact retained flat target' }]
  }),
)

export type RetainedJevV38EntryTarget = typeof RetainedJevV38EntryTargetSchema.Type
export type RetainedJevV38ExitTarget = typeof RetainedJevV38ExitTargetSchema.Type
