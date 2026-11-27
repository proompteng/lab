import { JevBatchPlanVersion } from './batch'
import { JevPositionExitPolicySchema, jevPositionExitPolicy } from './exit-policy'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'
import { freezeEvidence } from '../immutable-evidence'

import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema, Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import type { StrategyDefinition } from '../strategy/core'
import { JevBatchPlanSchema, JevBatchResultSchema, usableEntryBatchInferences } from './batch'
import { JevContractError } from './contract'
import { evaluateSupportedEntryProposals } from './entry-questions'
import { JevObservationSchema } from './observation-contract'
import { JevPurpose } from './portfolio'
import type { JevProtocol, JevProtocolMaterial } from './protocol'
import {
  isPreparedJevBatch,
  jevEntryQuoteExclusion,
  reproduceJevTradingSignalBatchEvidence,
  type PreparedJevBatch,
} from './trading-signals'
import { JevCandidatePlanStatus } from './batch'
import { JevFundedExitPlanSchema, type JevFundedExitPlan } from './strategy-exit-plan'
import { nativeEntryProposalExitPlan, isShortEntryProposal, type NativeEntryProposal } from './native-entry-proposal'
import { ShortFundedExitPlanSchema, type ShortFundedExitPlan } from './short-exit-plan'

export const JevDecisionEvidenceSchema = Schema.Struct({
  observation: JevObservationSchema,
  batchPlan: JevBatchPlanSchema,
  batchResult: JevBatchResultSchema,
  decidedAt: UtcInstantSchema,
})
export type JevDecisionEvidence = typeof JevDecisionEvidenceSchema.Type

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

type SupportedEntryCandidate = {
  readonly symbol: string
  readonly proposalId: string
  readonly structuralSupport: number
  readonly modeledGainMicros?: bigint
  readonly modeledLossMicros: bigint
}

const EV_PROBABILITY_SCALE = 10_000n

const compareSupportedEntryCandidates = (
  left: SupportedEntryCandidate,
  right: SupportedEntryCandidate,
  rankByModeledExpectedValue = false,
) => {
  if (
    rankByModeledExpectedValue &&
    left.modeledGainMicros !== undefined &&
    right.modeledGainMicros !== undefined &&
    left.modeledLossMicros > 0n &&
    right.modeledLossMicros > 0n
  ) {
    const leftProb = BigInt(Math.round(left.structuralSupport * Number(EV_PROBABILITY_SCALE)))
    const rightProb = BigInt(Math.round(right.structuralSupport * Number(EV_PROBABILITY_SCALE)))
    const leftEvNum = leftProb * left.modeledGainMicros - (EV_PROBABILITY_SCALE - leftProb) * left.modeledLossMicros
    const rightEvNum =
      rightProb * right.modeledGainMicros - (EV_PROBABILITY_SCALE - rightProb) * right.modeledLossMicros
    const crossDiff = rightEvNum * left.modeledLossMicros - leftEvNum * right.modeledLossMicros
    if (crossDiff > 0n) return 1
    if (crossDiff < 0n) return -1
  }
  const supportOrder = right.structuralSupport - left.structuralSupport
  if (supportOrder !== 0) return supportOrder
  if (left.modeledLossMicros < right.modeledLossMicros) return -1
  if (left.modeledLossMicros > right.modeledLossMicros) return 1
  const symbolOrder = left.symbol.localeCompare(right.symbol)
  return symbolOrder !== 0 ? symbolOrder : left.proposalId.localeCompare(right.proposalId)
}

export const selectJevEntryCandidatesFromSupported = <Candidate extends SupportedEntryCandidate>(
  candidates: readonly Candidate[],
  maximumPositions: number,
  rankByModeledExpectedValue = false,
) => {
  const selected: Candidate[] = []
  for (const candidate of candidates.toSorted((left, right) =>
    compareSupportedEntryCandidates(left, right, rankByModeledExpectedValue),
  )) {
    if (selected.some((entry) => entry.symbol === candidate.symbol)) continue
    selected.push(candidate)
    if (selected.length === maximumPositions) break
  }
  return selected
}

const decisionPreparations = new WeakMap<object, { evidence: JevDecisionEvidence; batch: PreparedJevBatch }>()

export const prepareJevDecisionEvidence = (
  batch: PreparedJevBatch,
  result: JevDecisionEvidence['batchResult'],
  decidedAt: string,
) =>
  Result.gen(function* () {
    if (!isPreparedJevBatch(batch)) return yield* unavailable('Jev decision requires its owned batch preparation')
    const clock = yield* Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(decidedAt)
    const batchResult = yield* Schema.decodeUnknownResult(JevBatchResultSchema, strictParseOptions)(result)
    const detachedResult = yield* Result.try({
      try: () => structuredClone(batchResult),
      catch: (cause) => new JevContractError({ message: 'Jev decision could not retain its exact result', cause }),
    })
    const { snapshot: _snapshot, contentHash: _contentHash, ...observation } = batch.source.verified
    const evidence: JevDecisionEvidence = freezeEvidence({
      observation,
      batchPlan: batch.plan,
      batchResult: detachedResult,
      decidedAt: clock,
    })
    decisionPreparations.set(evidence, { evidence, batch })
    return evidence
  })

export const reproduceDecisionEvidence = (input: unknown, expectedVersion: JevBatchPlanVersion) =>
  Result.gen(function* () {
    const prepared = typeof input === 'object' && input !== null ? decisionPreparations.get(input) : undefined
    const evidence =
      prepared?.evidence ?? (yield* Schema.decodeUnknownResult(JevDecisionEvidenceSchema, strictParseOptions)(input))
    const { observation, plan } =
      prepared === undefined
        ? yield* reproduceJevTradingSignalBatchEvidence(evidence.observation, evidence.batchPlan)
        : { observation: prepared.batch.source.verified, plan: prepared.batch.plan }
    if (observation.schemaVersion !== 'bayn.jev-observation.v1')
      return yield* unavailable('Native Jev decisions require native observations')
    const inferences = yield* usableEntryBatchInferences(
      plan,
      evidence.batchResult,
      Date.parse(evidence.decidedAt),
      expectedVersion,
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
      return yield* unavailable('Jev decision is beyond its market decision cutoff')
    const calendar = { executionCalendarHash: yield* canonicalHashV1Result(hours) }
    return { evidence, observation, inferences, calendar }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev decision evidence does not reproduce', cause })),
  )

export const selectJevEntryCandidates = (
  observation: Pick<Result.Result.Success<ReturnType<typeof reproduceDecisionEvidence>>['observation'], 'snapshot'> & {
    readonly protocol: Pick<JevProtocolMaterial, 'schemaVersion' | 'maximumPositions'>
  },
  inferences: Result.Result.Success<ReturnType<typeof reproduceDecisionEvidence>>['inferences'],
  requests: readonly {
    readonly symbol: string
    readonly status: JevCandidatePlanStatus.Requested
  }[],
) =>
  Result.gen(function* () {
    const entryPlanRejections: Record<string, 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS' | 'NO_FUNDED_CANDIDATES'> = {}
    const eligible: (SupportedEntryCandidate & { readonly proposal: NativeEntryProposal })[] = []
    for (const { symbol, inference } of inferences) {
      const quote = observation.snapshot.latestQuotes[symbol]
      const candidate = requests.find((entry) => entry.symbol === symbol)
      if (quote === undefined || candidate === undefined)
        return yield* unavailable('Entry inference has no verified quote or sealed source request')
      const disposition = inference.handoff.disposition
      if (disposition.status === 'SOURCE_INFEASIBLE' || disposition.status === 'NO_FUNDED_PROPOSALS') {
        entryPlanRejections[symbol] = 'NO_FUNDED_CANDIDATES'
        continue
      }
      if (disposition.status !== 'READY' || inference.jev.status !== 'RECEIVED')
        return yield* unavailable('Entry inference has no complete source-bound provider judgments')
      const evaluation = yield* evaluateSupportedEntryProposals({
        proposals: disposition.evaluation.proposals,
        response: inference.jev.inference.response,
        protocol: observation.protocol,
      })
      if (evaluation.supported.length === 0) {
        entryPlanRejections[symbol] = 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS'
        continue
      }
      if ((yield* jevEntryQuoteExclusion(quote)) !== null) continue
      for (const { proposal, structuralSupport, modeledGainMicros, modeledLossMicros } of evaluation.supported) {
        if (proposal.symbol !== symbol) return yield* unavailable('Supported proposal belongs to another symbol')
        eligible.push({
          symbol,
          proposalId: proposal.proposalId,
          structuralSupport,
          modeledGainMicros,
          modeledLossMicros,
          proposal,
        })
      }
    }
    return {
      entryPlanRejections,
      selected: selectJevEntryCandidatesFromSupported(
        eligible,
        observation.protocol.maximumPositions,
        observation.protocol.schemaVersion === 'bayn.jev.protocol.v42' ||
          observation.protocol.schemaVersion === 'bayn.jev.protocol.v43' ||
          observation.protocol.schemaVersion === 'bayn.jev.protocol.v44',
      ).map(({ symbol, proposal }) => ({
        symbol,
        weight: proposal.funding.maximumTargetWeight * (isShortEntryProposal(proposal) ? -1 : 1),
        exitPlan: nativeEntryProposalExitPlan(proposal),
      })),
    }
  })

export const makeChartEntryTargetMaterial = <Evidence extends { readonly decidedAt: string }>(
  source: {
    readonly evidence: Evidence
    readonly observation: Pick<
      Result.Result.Success<ReturnType<typeof reproduceDecisionEvidence>>['observation'],
      'snapshot' | 'observedAt'
    > & {
      readonly protocol: Pick<JevProtocol, 'maximumHoldingMinutes' | 'candidateSymbols'>
    }
    readonly calendar: { readonly executionCalendarHash: string }
  },
  selection: {
    readonly entryPlanRejections: Readonly<
      Record<string, 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS' | 'NO_FUNDED_CANDIDATES'>
    >
    readonly selected: readonly {
      readonly symbol: string
      readonly weight: number
      readonly exitPlan: JevFundedExitPlan | ShortFundedExitPlan
    }[]
  },
) =>
  Result.gen(function* () {
    const { evidence, observation, calendar } = source
    const { entryPlanRejections, selected } = selection
    const selectedSymbols = selected.map(({ symbol }) => symbol)
    return {
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
  })

export const decideJevEntry = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceDecisionEvidence(input, JevBatchPlanVersion.V8)
    if (source.observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* unavailable('An entry decision requires a flat entry observation')
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
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev entry target could not be derived', cause })))

export const ChartEntryTargetFields = {
  entryPlanRejections: Schema.Record(
    SymbolSchema,
    Schema.Literals(['UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS', 'NO_FUNDED_CANDIDATES']),
  ),
  exitPolicy: Schema.Struct({
    ...JevPositionExitPolicySchema.fields,
    plans: Schema.Record(SymbolSchema, Schema.Union([JevFundedExitPlanSchema, ShortFundedExitPlanSchema])),
  }),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  decidedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isMaxLength(1), Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }))),
  evidence: JevDecisionEvidenceSchema,
}

const TargetBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-entry-target.v7'),
  strategy: Schema.Literal('jev'),
  ...ChartEntryTargetFields,
})

// Retain only successful full-content fingerprints, never caller-owned evidence.
// Interleaved active/recovery targets must not evict one another on every check.
const verifiedEntryTargetHashes = new Set<string>()

export const JevEntryTargetSchema = TargetBase.check(
  Schema.makeFilter((target) => {
    const fingerprint = canonicalHashV1Result(target)
    if (Result.isSuccess(fingerprint) && verifiedEntryTargetHashes.delete(fingerprint.success)) {
      verifiedEntryTargetHashes.add(fingerprint.success)
      return []
    }
    const { evidence, ...material } = target
    const reproduced = decideJevEntry(evidence).pipe(
      Result.flatMap(({ evidence: _, ...derived }) => canonicalHashV1Result(derived)),
    )
    const supplied = canonicalHashV1Result(material)
    if (Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success) {
      if (Result.isSuccess(fingerprint)) {
        verifiedEntryTargetHashes.add(fingerprint.success)
        if (verifiedEntryTargetHashes.size > 64) {
          const oldest = verifiedEntryTargetHashes.values().next().value
          if (oldest !== undefined) verifiedEntryTargetHashes.delete(oldest)
        }
      }
      return []
    }
    return [{ path: ['evidence'], issue: 'complete recorded candidate evidence must reproduce the exact Jev target' }]
  }),
)
export type JevEntryTarget = typeof JevEntryTargetSchema.Type

export const jevPlanningTargetWeights = (
  target: Pick<ProtectedEntryTarget, 'targetWeights'>,
): Readonly<Record<string, number>> =>
  Object.fromEntries(Object.entries(target.targetWeights).filter(([, weight]) => weight !== 0))

export const jevEntryQuoteMaximumAgeMs = (
  _target: Pick<ProtectedEntryTarget, 'schemaVersion'>,
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
