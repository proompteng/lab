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
import { JevContractError, type JevRequest } from './contract'
import { JevObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import type { JevProtocol } from './protocol'
import { jevEntryQuoteExclusion, reproduceJevTradingSignalBatchEvidence } from './trading-signals'
import { JevCandidatePlanStatus } from './batch'
import { JevEntrySetup, selectedJevTradePlan } from './trade-plan-choices'
import { type JevFundedExitPlan } from './strategy-exit-plan'

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
    readonly request: { readonly request: JevRequest }
    readonly status: JevCandidatePlanStatus.Requested
  }[],
) =>
  Result.gen(function* () {
    const entryPlanRejections: Record<
      string,
      'MODEL_WAIT' | 'MODEL_AVOID' | 'MODEL_SETUP_UNSUPPORTED' | 'NO_FUNDED_CANDIDATES'
    > = {}
    const eligible: { symbol: string; probability: number; weight: number; exitPlan: JevFundedExitPlan }[] = []
    for (const { symbol, inference } of inferences) {
      const answer = inference.response.answers['action']
      const setup = inference.response.answers['setup']
      const quote = observation.snapshot.latestQuotes[symbol]
      if (answer?.type !== 'choice' || setup?.type !== 'choice' || quote === undefined)
        return yield* unavailable('Jev entry has no typed setup, economic plan or verified quote')
      const probability = setup.probabilities[setup.choice]
      if (probability === undefined) return yield* unavailable('Jev setup answer is missing its chosen probability')
      const quoteEligible = (yield* jevEntryQuoteExclusion(quote)) === null
      const candidate = requests.find((entry) => entry.symbol === symbol)
      if (candidate?.status !== JevCandidatePlanStatus.Requested)
        return yield* unavailable('Jev selected entry has no sealed request')
      const plan = yield* selectedJevTradePlan(candidate.request.request, inference.response)
      if (plan === null) {
        const question = candidate.request.request.questions['action']
        const hasPlans =
          question?.type === 'choice' && Object.keys(question.criteria).some((key) => key.startsWith('plan_'))
        entryPlanRejections[symbol] = !hasPlans
          ? 'NO_FUNDED_CANDIDATES'
          : setup.choice !== JevEntrySetup.Upward
            ? 'MODEL_SETUP_UNSUPPORTED'
            : answer.choice === 'wait'
              ? 'MODEL_WAIT'
              : 'MODEL_AVOID'
        continue
      }
      if (plan.levels.symbol !== symbol) return yield* unavailable('Selected Jev plan belongs to another symbol')
      if (!quoteEligible) continue
      eligible.push({ symbol, probability, weight: observation.protocol.maximumSymbolWeight, exitPlan: plan })
    }
    eligible.sort(
      (left, right) =>
        right.probability - left.probability || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0),
    )
    const selected = eligible.slice(0, observation.protocol.maximumPositions)
    return { entryPlanRejections, selected }
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
      exitPolicy: jevPositionExitPolicy(Object.fromEntries(selected.map(({ symbol, exitPlan }) => [symbol, exitPlan]))),
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
    Schema.Literals(['MODEL_WAIT', 'MODEL_AVOID', 'MODEL_SETUP_UNSUPPORTED', 'NO_FUNDED_CANDIDATES']),
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
