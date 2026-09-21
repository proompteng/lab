import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotPurpose } from '../market-data'
import type { IntradayQuote } from '../market-data/intraday/model'
import { intradayAgeNanos, millisecondsAsNanos } from '../market-data/intraday/time'
import { reproduceStrategySnapshot } from '../market-data/streaming/replay'
import { IsoDateSchema, Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { numberToMicros } from '../strategy/execution-model/fixed-point'
import { JevContractError } from './contract'
import { JevManagementAction, JevManagementDecisionSchema } from './decision'
import { JevObservationSchema } from './observation-contract'
import { JevPortfolioSchema, JevPurpose } from './portfolio'
import { JevProtocolSchema } from './protocol'

export enum JevExitReason {
  Model = 'JEV_EXIT',
  MaximumHold = 'MAXIMUM_HOLD',
  ProtectiveStop = 'PROTECTIVE_STOP',
}

const TriggerSchema = Schema.Union([
  Schema.Struct({ reason: Schema.Literal(JevExitReason.Model), decision: JevManagementDecisionSchema }),
  Schema.Struct({ reason: Schema.Literal(JevExitReason.MaximumHold) }),
  Schema.Struct({
    reason: Schema.Literal(JevExitReason.ProtectiveStop),
    manifest: JevObservationSchema.fields.manifest,
    rows: JevObservationSchema.fields.rows,
  }),
])

export const JevExitEvidenceSchema = Schema.Struct({
  cycleId: Sha256Schema,
  sessionDate: IsoDateSchema,
  protocol: JevProtocolSchema,
  portfolio: JevPortfolioSchema,
  observedAt: UtcInstantSchema,
  trigger: TriggerSchema,
})
export type JevExitEvidence = typeof JevExitEvidenceSchema.Type

const invalid = (message: string) => Result.fail(new JevContractError({ message }))
export const jevProtectiveQuoteIsFresh = (
  quote: Pick<IntradayQuote, 'eventAt'>,
  observedAt: string,
  maximumAgeMs: number,
): boolean => {
  const age = intradayAgeNanos(observedAt, quote.eventAt)
  return age >= 0n && age <= millisecondsAsNanos(maximumAgeMs)
}

export const jevProtectiveStopCrossed = (
  basisMicros: bigint,
  quantityMicros: bigint,
  bidMicros: bigint,
  stopBps: number,
): boolean =>
  (basisMicros * 1_000_000n - bidMicros * quantityMicros) * 10_000n >= basisMicros * 1_000_000n * BigInt(stopBps)
const equal = (left: unknown, right: unknown) => {
  const a = canonicalHashV1Result(left)
  const b = canonicalHashV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
}

export const decideJevExit = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(JevExitEvidenceSchema, strictParseOptions)(input)
    const { portfolio, protocol, trigger } = evidence
    if (portfolio.purpose !== JevPurpose.Manage) return yield* invalid('Exit requires an accounted held position')
    const state = portfolio.brokerState
    const position = state.positions.find(({ quantityMicros }) => BigInt(quantityMicros) > 0n)
    const firstFill = portfolio.entryFills[0]
    if (position?.schemaVersion !== 'bayn.position.v2' || firstFill === undefined)
      return yield* invalid('Exit requires a long position with cost basis and its first fill')
    const now = Date.parse(evidence.observedAt)
    if (
      !protocol.candidateSymbols.includes(position.symbol) ||
      firstFill.occurredAt.slice(0, 10) !== evidence.sessionDate ||
      evidence.observedAt.slice(0, 10) !== evidence.sessionDate ||
      [
        state.account.observedAt,
        state.positionsObservedAt,
        state.ordersObservedAt,
        state.reconciliation.reconciledAt,
      ].some((at) => Date.parse(at) > now || now - Date.parse(at) > protocol.maximumQuoteAgeMs)
    )
      return yield* invalid('Exit requires current position evidence for its strategy session')
    switch (trigger.reason) {
      case JevExitReason.MaximumHold:
        if (now < Date.parse(firstFill.occurredAt) + protocol.maximumHoldingMinutes * 60_000)
          return yield* invalid('Maximum holding time has not elapsed since the actual first fill')
        break
      case JevExitReason.Model: {
        const decision = trigger.decision
        if (
          decision.action !== JevManagementAction.Exit ||
          decision.cycleId !== evidence.cycleId ||
          decision.entryDecisionHash !== portfolio.entryDecisionHash ||
          decision.symbol !== position.symbol ||
          decision.evidence.decidedAt !== evidence.observedAt ||
          !equal(decision.evidence.observation.portfolio, portfolio) ||
          !equal(decision.evidence.observation.protocol, protocol)
        )
          return yield* invalid('Exit must reproduce the same position and protocol as the complete model decision')
        break
      }
      case JevExitReason.ProtectiveStop: {
        const snapshot = yield* reproduceStrategySnapshot(trigger.manifest, trigger.rows)
        const m = snapshot.manifest
        const end = Math.floor(now / 60_000) * 60_000
        const session = m.calendar.sessions.find(({ date }) => date === evidence.sessionDate)
        if (
          m.purpose !== IntradaySnapshotPurpose.Liquidation ||
          m.observedAt !== evidence.observedAt ||
          m.sessionDate !== evidence.sessionDate ||
          m.symbols.length !== 1 ||
          m.symbols[0] !== position.symbol ||
          m.universeId !== protocol.universeId ||
          m.universeSymbolHash !== protocol.universeSymbolHash ||
          !equal(m.universe, protocol.universe) ||
          m.feed !== protocol.feed ||
          m.delayClass !== protocol.delayClass ||
          !equal(m.sourceTopics, protocol.sourceTopics) ||
          m.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
          Date.parse(m.rangeEndAt) !== end ||
          Date.parse(m.rangeStartAt) !== end - 60_000 ||
          session === undefined ||
          m.rangeStartAt < session.openAt ||
          evidence.observedAt >= session.closeAt
        )
          return yield* invalid(
            'Protective stop requires a fresh reproduced liquidation quote from the exact market source',
          )
        const quote = snapshot.latestQuotes[position.symbol]
        if (
          quote === undefined ||
          quote.bidSize <= 0 ||
          !jevProtectiveQuoteIsFresh(quote, evidence.observedAt, protocol.maximumQuoteAgeMs)
        )
          return yield* invalid('Protective stop has no fresh executable bid')
        const bid = yield* numberToMicros(quote.bidPrice)
        if (
          !jevProtectiveStopCrossed(
            BigInt(position.costBasisMicros),
            BigInt(position.quantityMicros),
            bid,
            protocol.protectiveStopBps,
          )
        )
          return yield* invalid('The verified bid has not crossed the protective stop')
        break
      }
    }
    return {
      schemaVersion: 'bayn.jev-exit-target.v1' as const,
      strategyName: 'jev' as const,
      cycleId: evidence.cycleId,
      entryDecisionHash: portfolio.entryDecisionHash,
      sessionDate: evidence.sessionDate,
      symbols: [position.symbol],
      targetWeights: { [position.symbol]: 0 as const },
      reason: trigger.reason,
      observedAt: evidence.observedAt,
      evidence,
    }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev exit evidence does not reproduce', cause })))

export const JevExitTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-exit-target.v1'),
  strategyName: Schema.Literal('jev'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  targetWeights: Schema.Record(SymbolSchema, Schema.Literal(0)),
  reason: Schema.Enum(JevExitReason),
  observedAt: UtcInstantSchema,
  evidence: JevExitEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = decideJevExit(target.evidence)
    return Result.isSuccess(reproduced) && equal(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'the complete exit evidence must reproduce the exact flat target' }]
  }),
)
export type JevExitTarget = typeof JevExitTargetSchema.Type

export const jevExitCommitDeadline = (target: JevExitTarget): string =>
  target.evidence.trigger.reason === JevExitReason.Model
    ? target.evidence.trigger.decision.evidence.batchPlan.expiresAt
    : new Date(Date.parse(target.observedAt) + target.evidence.protocol.maximumQuoteAgeMs).toISOString()
