import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { jevSignalWindowEndMs } from '../jev/observation-query'
import { decodeExecutionDecisionDocument } from '../shadow-decision-contract'
import {
  IntradayAlphaObservationSchema,
  reproduceIntradayAlphaObservation,
} from '../strategy/intraday-alpha/observation'
import { ResearchStrategyEngine, type ResearchStrategyBinding } from '../system-assessment/strategy-binding'
import type { AlphaBaselineSource } from '../system-assessment/alpha-observation-witness'
import type { PreparedAlphaBaselineSource } from '../system-assessment/alpha-baseline-witness'
import { prepareReplayAlphaBaselineSources, selectReplayAlphaBaselineSource } from './alpha-baseline'
import { prepareReplayAlphaBaselinePreparations, selectReplayAlphaBaselinePreparation } from './alpha-prepared-baseline'
import {
  AnyReplayAlphaBaselineUseSchema,
  ReplayAlphaBaselineUseSchema,
  PreparedReplayAlphaBaselineUseSchema,
} from './alpha-baseline-use'
import type { ReplayObservationLatencyReceipt } from './decision-latency'
import { ReplayBrokerFailure } from './broker'

export const ReplayAlphaObservationSchema = Schema.Struct({
  contentHash: Sha256Schema,
  payload: IntradayAlphaObservationSchema,
  baselineUse: ReplayAlphaBaselineUseSchema,
})
export const PreparedReplayAlphaObservationSchema = Schema.Struct({
  contentHash: Sha256Schema,
  payload: IntradayAlphaObservationSchema,
  baselineUse: PreparedReplayAlphaBaselineUseSchema,
})
export const ReplayAlphaBaselineGapSchema = Schema.Struct({
  reason: Schema.Literal('MISSING_CAUSAL_ALPHA_BASELINE'),
  sessionDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  firstAvailableAt: Schema.NullOr(UtcInstantSchema),
})
export type ReplayAlphaBaselineGap = typeof ReplayAlphaBaselineGapSchema.Type

interface AlphaEvidenceInput {
  readonly binding: ResearchStrategyBinding
  readonly observations: readonly (
    | typeof ReplayAlphaObservationSchema.Type
    | typeof PreparedReplayAlphaObservationSchema.Type
  )[]
  readonly baselineGaps: readonly ReplayAlphaBaselineGap[]
  readonly decisions: readonly unknown[]
  readonly runId: string
  readonly observationReleases?: readonly ReplayObservationLatencyReceipt[]
}
type AlphaEvidenceSources =
  | { readonly sourceKind: 'observation'; readonly sources: readonly AlphaBaselineSource[] }
  | { readonly sourceKind: 'preparation'; readonly preparations: readonly PreparedAlphaBaselineSource[] }

/** Source portfolio and eligibility never replace the replay broker; only the witnessed historical baseline is reused. */
const verifyAlphaEvidence = (input: AlphaEvidenceInput & AlphaEvidenceSources) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new ReplayBrokerFailure({ message }))
    const binding = input.binding
    const preparations =
      input.sourceKind === 'preparation'
        ? yield* prepareReplayAlphaBaselinePreparations(binding, input.preparations)
        : []
    if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) {
      if (input.observations.length !== 0 || input.baselineGaps.length !== 0)
        return yield* fail('A different replay engine cannot claim alpha observations or baseline gaps')
      return []
    }
    const accountId = `replay-${input.runId}`
    const sources =
      input.sourceKind === 'observation' ? yield* prepareReplayAlphaBaselineSources(binding, input.sources) : []
    const releases = new Map(input.observationReleases?.map((receipt) => [receipt.observationHash, receipt]) ?? [])
    if (releases.size !== (input.observationReleases?.length ?? 0))
      return yield* fail('Alpha observation release inventory duplicates its command identity')
    const observations = []
    const seen = new Set<string>()
    for (const row of input.observations) {
      const observed = yield* reproduceIntradayAlphaObservation(row.payload)
      const manifest = observed.snapshot.manifest
      const use = yield* Schema.decodeUnknownResult(
        AnyReplayAlphaBaselineUseSchema,
        strictParseOptions,
      )(row.baselineUse)
      if ((input.sourceKind === 'preparation') !== (use.schemaVersion === 'bayn.replay-alpha-baseline-use.v2'))
        return yield* fail('Alpha baseline-use receipt differs from its replay source version')
      const release = releases.get(row.contentHash)
      if (
        seen.has(row.contentHash) ||
        observed.contentHash !== row.contentHash ||
        observed.portfolio.brokerState.account.accountId !== accountId ||
        (yield* canonicalHashV1Result(observed.protocol)) !==
          (yield* canonicalHashV1Result(binding.parameters.sharedProtocol))
      )
        return yield* fail('Alpha replay observation is duplicated or differs from its engine, account or content')
      if (
        use.observationHash !== row.contentHash ||
        use.cycleId !== observed.cycleId ||
        use.authorityGenerationHash !== observed.authorityGenerationHash ||
        use.sessionDate !== manifest.sessionDate ||
        use.windowEndAt !== manifest.rangeEndAt ||
        use.commandIssuedAt > use.admissionObservedAt ||
        use.admissionObservedAt > observed.observedAt ||
        use.admissionObservedAt >= use.admissionExpiresAt ||
        observed.observedAt >= use.admissionExpiresAt ||
        jevSignalWindowEndMs(Date.parse(use.admissionObservedAt), binding.parameters.sharedProtocol) !==
          Date.parse(use.windowEndAt) ||
        (release !== undefined &&
          (release.commandIssuedAt !== use.commandIssuedAt || release.observedAt !== observed.observedAt))
      )
        return yield* fail('Alpha baseline-use receipt changed its original command, admission, owner or window')
      const query = {
        sessionDate: manifest.sessionDate,
        symbols: binding.parameters.candidateSymbols,
        noiseAreaSymbols: binding.parameters.noiseAreaSymbols,
        lookbackSessions: binding.parameters.trailingBaseline.lookbackSessions,
        minimumSessions: binding.parameters.trailingBaseline.minimumSessions,
        sourceContract: {
          provider: 'alpaca' as const,
          feed: manifest.feed,
          sourceTopic: manifest.sourceTopics.bars,
          universeId: manifest.universeId,
        },
      }
      const selected =
        input.sourceKind === 'preparation'
          ? yield* selectReplayAlphaBaselinePreparation(binding, preparations, query, use.commandIssuedAt).pipe(
              Result.map((source) => ({
                sourceHash: source.preparationHash,
                witnessSourceHash: source.witnessSourceHash,
                baseline: source.payload.acquisition.trailingBaseline,
              })),
            )
          : yield* selectReplayAlphaBaselineSource(binding, sources, query, use.admissionObservedAt).pipe(
              Result.map((source) => ({
                sourceHash: source.observationHash,
                witnessSourceHash: source.witnessSourceHash,
                baseline: source.payload.trailingBaseline,
              })),
            )
      const baselineHash = yield* canonicalHashV1Result(selected.baseline)
      if (
        selected.sourceHash !==
          (use.schemaVersion === 'bayn.replay-alpha-baseline-use.v2'
            ? use.sourcePreparationHash
            : use.sourceObservationHash) ||
        selected.witnessSourceHash !== use.sourceWitnessHash ||
        baselineHash !== use.baselineHash ||
        baselineHash !== (yield* canonicalHashV1Result(observed.trailingBaseline))
      )
        return yield* fail('Alpha replay observation changed its causally available retained baseline')
      seen.add(row.contentHash)
      observations.push(observed)
    }
    if ([...releases.keys()].some((hash) => !seen.has(hash)))
      return yield* fail('Alpha command receipt has no retained observation')
    const decisions = new Set<string>()
    for (const raw of input.decisions) {
      const document = yield* decodeExecutionDecisionDocument(raw)
      const target = document.strategyDecision
      const observationHash =
        target?.schemaVersion === 'bayn.intraday-alpha-target.v2'
          ? yield* canonicalHashV1Result(target.evidence.observation)
          : null
      if (
        target?.schemaVersion !== 'bayn.intraday-alpha-target.v2' ||
        decisions.has(document.contentHash) ||
        document.bindings.accountId !== accountId ||
        document.bindings.strategyProtocolHash !== binding.protocolHash ||
        (yield* canonicalHashV1Result(target.policy)) !== (yield* canonicalHashV1Result(binding.parameters)) ||
        observationHash === null ||
        !seen.has(observationHash)
      )
        return yield* fail('Alpha replay decision does not bind its complete native policy and retained observation')
      const admitted = input.observations.find((row) => row.contentHash === observationHash)
      if (admitted === undefined || target.evidence.decidedAt >= admitted.baselineUse.admissionExpiresAt)
        return yield* fail('Alpha replay decision completed outside its original admission deadline')
      decisions.add(document.contentHash)
    }
    const gapKeys = new Set<string>()
    for (const gap of input.baselineGaps) {
      const key = `${gap.sessionDate}:${gap.observedAt}`
      const firstAvailable =
        input.sourceKind === 'preparation'
          ? (preparations
              .filter((source) => source.payload.sessionDate === gap.sessionDate)
              .toSorted((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))[0]?.availableAt ?? null)
          : (sources
              .filter((source) => source.payload.trailingBaseline.sessionDate === gap.sessionDate)
              .toSorted((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))[0]?.availableAt ?? null)
      if (
        gapKeys.has(key) ||
        gap.firstAvailableAt !== firstAvailable ||
        (firstAvailable !== null && Date.parse(firstAvailable) <= Date.parse(gap.observedAt))
      )
        return yield* fail('Alpha baseline gap invents missing data or changes its first causal availability')
      gapKeys.add(key)
    }
    return observations
  })

export const verifyReplayAlphaEvidence = (
  input: Omit<AlphaEvidenceInput, 'observations'> & {
    readonly observations: readonly (typeof ReplayAlphaObservationSchema.Type)[]
    readonly sources: readonly AlphaBaselineSource[]
  },
) => verifyAlphaEvidence({ ...input, sourceKind: 'observation' })

export const verifyPreparedReplayAlphaEvidence = (
  input: Omit<AlphaEvidenceInput, 'observations'> & {
    readonly observations: readonly (typeof PreparedReplayAlphaObservationSchema.Type)[]
    readonly preparations: readonly PreparedAlphaBaselineSource[]
  },
) => verifyAlphaEvidence({ ...input, sourceKind: 'preparation' })
