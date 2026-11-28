import { Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonEqualV1 } from '../hash'
import { isContinuousMarket } from '../market-hours'
import { strictParseOptions, UtcInstantSchema } from '../schemas'
import { JevBatchPlanVersion, JevBatchResultSchema, JevCandidatePlanStatus } from './batch'
import { JevContractError } from './contract'
import { ChartEntryTargetFields, makeChartEntryTargetMaterial, selectJevEntryCandidates } from './decision'
import { deriveJevExitTargetMaterial, JevExitEvidenceSchema, JevExitTargetSchema } from './exit'
import { RetainedJevObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import { RetainedVisualJevProtocolSchema } from './protocol'
import {
  reproduceRetainedJevTradingSignalBatchEvidence,
  retainedJevV38BatchInferencesAt,
  RetainedJevBatchPlanSchema,
} from './retained-jev-trading-signals'

export const RetainedJevDecisionEvidenceSchema = Schema.Struct({
  observation: RetainedJevObservationSchema,
  batchPlan: RetainedJevBatchPlanSchema,
  batchResult: JevBatchResultSchema,
  decidedAt: UtcInstantSchema,
})
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

/** Verify the original complete source once before reproducing its native or control target. */
export const reproduceRetainedJevDecisionSource = (input: unknown, version: JevBatchPlanVersion) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(RetainedJevDecisionEvidenceSchema, strictParseOptions)(input)
    const { observation, plan } = yield* reproduceRetainedJevTradingSignalBatchEvidence(
      evidence.observation,
      evidence.batchPlan,
    )
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
export const reproduceRetainedJevEntryTarget = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceRetainedJevDecisionSource(input, JevBatchPlanVersion.V8)
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
const same = canonicalJsonEqualV1

export const RetainedJevEntryTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-target.v7'),
  strategy: Schema.Literal('jev'),
  ...ChartEntryTargetFields,
  evidence: RetainedJevDecisionEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevEntryTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 candidate evidence must reproduce the exact retained target' }]
  }),
)

const RetainedExitEvidenceSchema = Schema.Struct({
  ...JevExitEvidenceSchema.fields,
  protocol: RetainedVisualJevProtocolSchema,
})

export const reproduceRetainedJevExitTarget = (input: unknown) =>
  Schema.decodeUnknownResult(
    RetainedExitEvidenceSchema,
    strictParseOptions,
  )(input).pipe(Result.flatMap(deriveJevExitTargetMaterial))

export const RetainedJevExitTargetSchema = Schema.Struct({
  ...JevExitTargetSchema.fields,
  evidence: RetainedExitEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevExitTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 exit evidence must reproduce the exact retained flat target' }]
  }),
)

export type RetainedJevEntryTarget = typeof RetainedJevEntryTargetSchema.Type
export type RetainedJevExitTarget = typeof RetainedJevExitTargetSchema.Type
