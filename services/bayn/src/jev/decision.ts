import { JevPositionExitPolicySchema, jevPositionExitPolicy } from './exit-policy'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  IsoDateSchema,
  Sha256Schema,
  SymbolSchema,
  UnitIntervalSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import type { StrategyDefinition } from '../strategy/core'
import { JevBatchPlanSchema, JevBatchResultSchema, usableJevBatchInferences } from './batch'
import { JevContractError } from './contract'
import type { EntryInferenceInput } from './entry-inference-input'
import { selectSupportedEntryProposal } from './entry-questions'
import { JevObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import type { JevProtocol } from './protocol'
import { jevEntryQuoteExclusion, reproduceJevTradingSignalBatchEvidence } from './trading-signals'
import { JevCandidatePlanStatus } from './batch'
import { entryProposalExitPlan, type JevFundedExitPlan } from './strategy-exit-plan'

export const JevDecisionEvidenceSchema = Schema.Struct({
  observation: JevObservationSchema,
  batchPlan: JevBatchPlanSchema,
  batchResult: JevBatchResultSchema,
  decidedAt: UtcInstantSchema,
})
export type JevDecisionEvidence = typeof JevDecisionEvidenceSchema.Type

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

export const reproduceDecisionEvidence = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(JevDecisionEvidenceSchema, strictParseOptions)(input)
    const { observation, plan } = yield* reproduceJevTradingSignalBatchEvidence(
      evidence.observation,
      evidence.batchPlan,
    )
    if (observation.schemaVersion !== 'bayn.jev-observation.v1')
      return yield* unavailable('Native Jev decisions require native observations')
    const inferences = yield* usableJevBatchInferences(plan, evidence.batchResult, Date.parse(evidence.decidedAt))
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
      return yield* unavailable('Jev decision is beyond its market decision cutoff')
    const calendar = { executionCalendarHash: yield* canonicalHashV1Result(hours) }
    return { evidence, observation, inferences, calendar }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev decision evidence does not reproduce', cause })),
  )

export const selectJevEntryCandidates = (
  observation: Result.Result.Success<ReturnType<typeof reproduceDecisionEvidence>>['observation'],
  inferences: Result.Result.Success<ReturnType<typeof reproduceDecisionEvidence>>['inferences'],
  requests: readonly {
    readonly symbol: string
    readonly request: { readonly request: EntryInferenceInput }
    readonly status: JevCandidatePlanStatus.Requested
  }[],
) =>
  Result.gen(function* () {
    const entryPlanRejections: Record<string, 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS' | 'NO_FUNDED_CANDIDATES'> = {}
    const eligible: {
      symbol: string
      judgmentSupport: number
      modeledLossMicros: bigint
      weight: number
      exitPlan: JevFundedExitPlan
    }[] = []
    for (const { symbol, inference } of inferences) {
      const quote = observation.snapshot.latestQuotes[symbol]
      const candidate = requests.find((entry) => entry.symbol === symbol)
      if (quote === undefined || candidate === undefined)
        return yield* unavailable('Entry inference has no verified quote or sealed source request')
      const disposition = inference.handoff.disposition
      if (disposition.status === 'NO_FUNDED_PROPOSALS') {
        entryPlanRejections[symbol] = 'NO_FUNDED_CANDIDATES'
        continue
      }
      if (disposition.status !== 'READY' || inference.jev.status !== 'RECEIVED')
        return yield* unavailable('Entry inference has no complete source-bound provider judgments')
      const choice = yield* selectSupportedEntryProposal({
        proposals: disposition.evaluation.proposals,
        response: inference.jev.inference.response,
      })
      if (choice.selected === null) {
        entryPlanRejections[symbol] = 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS'
        continue
      }
      if ((yield* jevEntryQuoteExclusion(quote)) !== null) continue
      const { proposal, judgmentSupport, modeledLossMicros } = choice.selected
      if (proposal.symbol !== symbol) return yield* unavailable('Selected proposal belongs to another symbol')
      eligible.push({
        symbol,
        judgmentSupport,
        modeledLossMicros,
        weight: proposal.funding.maximumTargetWeight,
        exitPlan: entryProposalExitPlan(proposal),
      })
    }
    eligible.sort(
      (left, right) =>
        right.judgmentSupport - left.judgmentSupport ||
        (left.modeledLossMicros < right.modeledLossMicros
          ? -1
          : left.modeledLossMicros > right.modeledLossMicros
            ? 1
            : left.symbol.localeCompare(right.symbol)),
    )
    return { entryPlanRejections, selected: eligible.slice(0, observation.protocol.maximumPositions) }
  })

export const decideJevEntry = (input: unknown) =>
  Result.gen(function* () {
    const { evidence, observation, inferences, calendar } = yield* reproduceDecisionEvidence(input)
    if (observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* unavailable('An entry decision requires a flat entry observation')
    const { entryPlanRejections, selected } = yield* selectJevEntryCandidates(
      observation,
      inferences,
      evidence.batchPlan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested),
    )
    const selectedSymbols = selected.map(({ symbol }) => symbol)
    return {
      schemaVersion: 'bayn.jev-entry-target.v7' as const,
      strategy: 'jev' as const,
      entryPlanRejections,
      exitPolicy: jevPositionExitPolicy(
        observation.protocol,
        Object.fromEntries(selected.map(({ symbol, exitPlan }) => [symbol, exitPlan])),
      ),
      sessionDate: yield* Schema.decodeUnknownResult(IsoDateSchema)(observation.snapshot.manifest.sessionDate),
      snapshotId: observation.snapshot.manifest.snapshotId,
      observedAt: observation.observedAt,
      decidedAt: evidence.decidedAt,
      calendarHash: calendar.executionCalendarHash,
      selectedSymbols,
      targetWeights: Object.fromEntries(
        observation.protocol.candidateSymbols.map((symbol) => [
          symbol,
          selected.find((entry) => entry.symbol === symbol)?.weight ?? 0,
        ]),
      ),
      evidence,
    }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev entry target could not be derived', cause })))

const TargetBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-target.v7'),
  strategy: Schema.Literal('jev'),
  entryPlanRejections: Schema.Record(
    SymbolSchema,
    Schema.Literals(['UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS', 'NO_FUNDED_CANDIDATES']),
  ),
  exitPolicy: JevPositionExitPolicySchema,
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  decidedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isMaxLength(1), Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  evidence: JevDecisionEvidenceSchema,
})

export const JevEntryTargetSchema = TargetBase.check(
  Schema.makeFilter((target) => {
    const { evidence, ...material } = target
    const reproduced = decideJevEntry(evidence).pipe(
      Result.flatMap(({ evidence: _, ...derived }) => canonicalHashV1Result(derived)),
    )
    const supplied = canonicalHashV1Result(material)
    return Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success
      ? []
      : [{ path: ['evidence'], issue: 'complete recorded candidate evidence must reproduce the exact Jev target' }]
  }),
)
export type JevEntryTarget = typeof JevEntryTargetSchema.Type

export const jevPlanningTargetWeights = (target: JevEntryTarget): Readonly<Record<string, number>> =>
  Object.fromEntries(Object.entries(target.targetWeights).filter(([, weight]) => weight > 0))

export const jevEntryQuoteMaximumAgeMs = (
  _target: JevEntryTarget,
  _quoteEventAt: string,
  quoteAgeLimitMs: number,
): number => quoteAgeLimitMs

export const makeJevDefinition = (
  protocol: JevProtocol,
): StrategyDefinition<JevDecisionEvidence, JevContractError, JevEntryTarget, JevProtocol> => ({
  name: 'jev',
  holdingPeriod: 'INTRADAY',
  parameters: protocol,
  decide: ({ market }) =>
    Result.gen(function* () {
      const expected = yield* canonicalHashV1Result(protocol)
      const actual = yield* canonicalHashV1Result(market.observation.protocol)
      if (expected !== actual) return yield* unavailable('Jev observation protocol differs from the active strategy')
      return yield* decideJevEntry(market)
    }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev strategy decision failed', cause }))),
})
