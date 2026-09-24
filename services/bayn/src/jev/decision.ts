import { Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../cycle/construction'
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
import { JevBatchPlanSchema, JevBatchPlanVersion, JevBatchResultSchema, usableJevBatchInferences } from './batch'
import { JevContractError } from './contract'
import { JevObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import type { JevProtocol } from './protocol'
import { jevEntryQuoteExclusion, reproduceJevTradingSignalBatchEvidence } from './trading-signals'

export const JevDecisionEvidenceSchema = Schema.Struct({
  observation: JevObservationSchema,
  batchPlan: JevBatchPlanSchema,
  batchResult: JevBatchResultSchema,
  decidedAt: UtcInstantSchema,
})
export type JevDecisionEvidence = typeof JevDecisionEvidenceSchema.Type

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

const reproduceDecisionEvidence = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(JevDecisionEvidenceSchema, strictParseOptions)(input)
    const { observation, plan } = yield* reproduceJevTradingSignalBatchEvidence(
      evidence.observation,
      evidence.batchPlan,
    )
    if (observation.schemaVersion !== 'bayn.jev-observation.v1')
      return yield* unavailable('Native Jev decisions require native observations')
    const inferences = yield* usableJevBatchInferences(plan, evidence.batchResult, Date.parse(evidence.decidedAt))
    const session = observation.snapshot.manifest.calendar.sessions.find(
      (value) => value.date === observation.snapshot.manifest.sessionDate,
    )
    if (
      session === undefined ||
      Date.parse(evidence.decidedAt) >=
        Date.parse(session.closeAt) - observation.protocol.entryCutoffMinutesBeforeClose * 60_000
    )
      return yield* unavailable('Jev decision is beyond its session decision cutoff')
    const calendar = yield* makeExecutionCalendarObservation({
      schemaVersion: observation.snapshot.manifest.calendar.schemaVersion,
      source: observation.snapshot.manifest.calendar.source,
      ...session,
    })
    return { evidence, observation, inferences, calendar }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev decision evidence does not reproduce', cause })),
  )

export const decideJevEntry = (input: unknown) =>
  Result.gen(function* () {
    const { evidence, observation, inferences, calendar } = yield* reproduceDecisionEvidence(input)
    if (observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* unavailable('An entry decision requires a flat entry observation')
    const eligible: { symbol: string; probability: number }[] = []
    for (const { symbol, inference } of inferences) {
      const answer = inference.response.answers['action']
      const quote = observation.snapshot.latestQuotes[symbol]
      if (answer?.type !== 'choice' || quote === undefined)
        return yield* unavailable('Jev entry has no typed action or verified quote')
      const probability = answer.probabilities['enter']
      if (probability === undefined) return yield* unavailable('Jev entry answer is missing its enter probability')
      const quoteEligible = (yield* jevEntryQuoteExclusion(quote, observation.protocol.maximumSpreadBps)) === null
      if (answer.choice === 'enter' && probability >= observation.protocol.minimumEntryProbability && quoteEligible)
        eligible.push({ symbol, probability })
    }
    eligible.sort(
      (left, right) =>
        right.probability - left.probability || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0),
    )
    const selectedSymbols = eligible.slice(0, observation.protocol.maximumPositions).map(({ symbol }) => symbol)
    const weight =
      Math.floor(
        Math.min(observation.protocol.maximumGrossWeight, observation.protocol.maximumSymbolWeight) * 1_000_000,
      ) / 1_000_000
    return {
      schemaVersion: 'bayn.jev-entry-target.v1' as const,
      strategy: 'jev' as const,
      sessionDate: yield* Schema.decodeUnknownResult(IsoDateSchema)(observation.snapshot.manifest.sessionDate),
      snapshotId: observation.snapshot.manifest.snapshotId,
      observedAt: observation.observedAt,
      decidedAt: evidence.decidedAt,
      calendarHash: calendar.executionCalendarHash,
      selectedSymbols,
      targetWeights: Object.fromEntries(
        observation.protocol.candidateSymbols.map((symbol) => [symbol, selectedSymbols.includes(symbol) ? weight : 0]),
      ),
      evidence,
    }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev entry target could not be derived', cause })))

const TargetBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-target.v1'),
  strategy: Schema.Literal('jev'),
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
  target: JevEntryTarget,
  quoteEventAt: string,
  quoteAgeLimitMs: number,
): number =>
  target.evidence.batchPlan.schemaVersion === JevBatchPlanVersion.V1
    ? Math.min(quoteAgeLimitMs, Date.parse(target.evidence.batchPlan.expiresAt) - Date.parse(quoteEventAt))
    : quoteAgeLimitMs

export enum JevManagementAction {
  Hold = 'HOLD',
  Exit = 'EXIT',
}

export const decideJevManagement = (input: unknown) =>
  Result.gen(function* () {
    const { evidence, observation, inferences } = yield* reproduceDecisionEvidence(input)
    const inference = inferences[0]
    if (observation.portfolio.purpose !== JevPurpose.Manage || inferences.length !== 1 || inference === undefined)
      return yield* unavailable('Management requires the complete held-position inference')
    const answer = inference.inference.response.answers['action']
    if (answer?.type !== 'choice' || answer.probabilities['exit'] === undefined)
      return yield* unavailable('Jev management has no typed exit probability')
    return {
      schemaVersion: 'bayn.jev-management-decision.v1' as const,
      cycleId: observation.cycleId,
      entryDecisionHash: observation.portfolio.entryDecisionHash,
      symbol: inference.symbol,
      action:
        answer.choice === 'exit' && answer.probabilities['exit'] >= observation.protocol.minimumExitProbability
          ? JevManagementAction.Exit
          : JevManagementAction.Hold,
      evidence,
    }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Jev management decision could not be derived', cause }),
    ),
  )

export const JevManagementDecisionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-management-decision.v1'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  symbol: SymbolSchema,
  action: Schema.Enum(JevManagementAction),
  evidence: JevDecisionEvidenceSchema,
}).check(
  Schema.makeFilter((decision) => {
    const { evidence, ...material } = decision
    const reproduced = decideJevManagement(evidence).pipe(
      Result.flatMap(({ evidence: _, ...derived }) => canonicalHashV1Result(derived)),
    )
    const supplied = canonicalHashV1Result(material)
    return Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success
      ? []
      : [{ path: ['evidence'], issue: 'recorded held-position evidence must reproduce the exact management decision' }]
  }),
)

export type JevManagementDecision = typeof JevManagementDecisionSchema.Type

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
