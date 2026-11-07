import { Result, Schema } from 'effect'

import { isContinuousMarket } from '../market-hours'
import {
  decodeJevBatchResult,
  JevBatchPlanSchema,
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  usableEntryBatchInferences,
  type JevBatchResult,
} from './batch'
import { JevContractError } from './contract'
import { selectJevEntryCandidates } from './decision'
import { reproduceRetainedJevV38CandidateObservation } from './observation'
import { JevObservationSchema, RetainedJevV38ObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import {
  decodeRetainedJevV38BatchResult,
  reproduceRetainedJevV38TradingSignalBatchEvidence,
  retainedJevV38BatchInferencesAt,
  RetainedJevV38BatchPlanSchema,
} from './retained-v38-trading-signals'
import { reproduceJevTradingSignalBatchEvidence } from './trading-signals'

// Development studies read committed evidence; these unions never enter execution admission.
export const JevStudyObservationSchema = Schema.Union([JevObservationSchema, RetainedJevV38ObservationSchema])
export const JevStudyBatchPlanSchema = Schema.Union([JevBatchPlanSchema, RetainedJevV38BatchPlanSchema])

export const reproduceJevStudyBatchEvidence = (inputObservation: unknown, inputPlan: unknown) =>
  Result.gen(function* () {
    if (Schema.is(RetainedJevV38ObservationSchema)(inputObservation)) {
      const observation = yield* reproduceRetainedJevV38CandidateObservation(inputObservation)
      const plan = yield* reproduceRetainedJevV38TradingSignalBatchEvidence(inputObservation, inputPlan)
      return { _tag: 'RETAINED_V38' as const, observation, plan }
    }
    const current = yield* reproduceJevTradingSignalBatchEvidence(inputObservation, inputPlan)
    return { _tag: 'CURRENT' as const, ...current }
  })

type StudyEvidence = Result.Result.Success<ReturnType<typeof reproduceJevStudyBatchEvidence>>

export const decodeJevStudyBatchResult = (source: StudyEvidence, input: unknown) =>
  source._tag === 'RETAINED_V38'
    ? decodeRetainedJevV38BatchResult(source.plan, input)
    : decodeJevBatchResult(source.plan, input)

export const jevStudyBatchInferencesAt = (source: StudyEvidence, result: JevBatchResult, now: number) =>
  source._tag === 'RETAINED_V38'
    ? retainedJevV38BatchInferencesAt(source.plan, result, now, JevBatchPlanVersion.V8)
    : usableEntryBatchInferences(source.plan, result, now, JevBatchPlanVersion.V8)

/** Only the historical study selection is returned, never an executable current target. */
export const selectRetainedJevV38StudyEntry = (
  source: Extract<StudyEvidence, { _tag: 'RETAINED_V38' }>,
  result: JevBatchResult,
  decidedAt: string,
) =>
  Result.gen(function* () {
    const { observation, plan } = source
    if (observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* Result.fail(
        new JevContractError({ message: 'Retained study selection requires a flat entry observation' }),
      )
    const inferences = yield* retainedJevV38BatchInferencesAt(
      plan,
      result,
      Date.parse(decidedAt),
      JevBatchPlanVersion.V8,
    )
    const hours = observation.snapshot.manifest.calendar
    const session = isContinuousMarket(hours)
      ? undefined
      : hours.sessions.find((value) => value.date === observation.snapshot.manifest.sessionDate)
    if (
      !isContinuousMarket(hours) &&
      (session === undefined ||
        Date.parse(decidedAt) >=
          Date.parse(session.closeAt) - observation.protocol.entryCutoffMinutesBeforeClose * 60_000)
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Retained study decision is beyond its market cutoff' }),
      )
    const selection = yield* selectJevEntryCandidates(
      observation,
      inferences,
      plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested),
    )
    return { selectedSymbols: selection.selected.map(({ symbol }) => symbol) }
  })
