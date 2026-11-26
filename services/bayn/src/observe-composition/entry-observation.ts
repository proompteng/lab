import { Effect, Option, Schema } from 'effect'

import { DecisionReadinessReason } from '../cycle/runner/readiness'
import type { AutonomousCycle } from '../cycle/model'
import { operationalError, type OperationalError } from '../errors'
import type { ExecutionSessionBinding } from '../execution-session'
import { JevBatchPlanVersion } from '../jev/batch'
import { jevFirstSignalDueMs, jevSignalDueAtMs, jevSignalIntervalMs } from '../jev/observation-query'
import type { JevContractError } from '../jev/contract'
import { JevDecisionEvidenceSchema, prepareJevDecisionEvidence } from '../jev/decision'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevAwaitingEvidence, evaluateJevObservationFromSnapshot } from '../jev/runtime'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import type { IntradayAlphaTrailingBaseline } from '../market-data/intraday/trailing-baseline'
import type { StrategyMarketSnapshot, VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { isIntradayAlphaRuntime, isRepeatedMomentumRuntime, type StrategyRuntime } from '../strategy'
import { evaluateIntradayAlphaFromSnapshot, makeIntradayAlphaEntryQuery } from '../strategy/intraday-alpha/runtime'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { strictParseOptions } from '../schemas'
import type { ObserveDecisionAwaitingSignal } from './decision-builder'
import type { CandidateObservationStore } from './candidate-observation'
import { NativeAlphaBaselinePreparation } from './alpha-baseline-preparation'
import { readEquityShortEligibility } from '../execution/equity-short'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { BrokerRead } from '../broker/alpaca/model'
import { equityClockSession } from '../equity-hours'
import { withObservedStage } from '../telemetry'

export interface EntryObservationContext {
  readonly strategy: StrategyRuntime
  readonly query: IntradaySnapshotQuery
  readonly observation: Parameters<typeof evaluateJevObservationFromSnapshot>[0]
  readonly calendar: ExecutionSessionBinding['calendar']
  readonly sessionDate: AutonomousCycle['identity']['executionSessionDate']
  readonly observedAt: string
  readonly admissionExpiresAt: number
  readonly loadSnapshot: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<
    VerifiedStrategyMarketSnapshot,
    OperationalError | ObserveDecisionAwaitingSignal,
    CandidateObservationStore
  >
}

type Evaluation = ReturnType<
  typeof evaluateJevObservationFromSnapshot<OperationalError | ObserveDecisionAwaitingSignal, CandidateObservationStore>
>

export type EntryObservation = (
  context: EntryObservationContext,
) => Effect.Effect<
  { readonly snapshot: StrategyMarketSnapshot; readonly decision: ProtectedEntryTarget },
  Effect.Error<Evaluation> | Schema.SchemaError | JevContractError,
  Effect.Services<Evaluation> | BrokerRead
>

export const observeChartEntry = (
  context: EntryObservationContext,
  version: JevBatchPlanVersion.V8 | JevBatchPlanVersion.Ablation,
  loadEligibility?: Effect.Effect<
    EntryObservationContext['observation']['equityShortEligibility'],
    OperationalError,
    BrokerRead
  >,
) =>
  Effect.gen(function* () {
    const strategy = context.strategy
    if (isRepeatedMomentumRuntime(strategy) || isIntradayAlphaRuntime(strategy))
      return yield* operationalError({
        component: 'strategy',
        operation: 'current-decision',
        message: 'Chart entry requires a chart strategy',
      })
    const evaluated = yield* evaluateJevObservationFromSnapshot<
      OperationalError | ObserveDecisionAwaitingSignal,
      CandidateObservationStore | BrokerRead
    >(
      context.observation,
      context.query.rangeEndAt,
      context.loadSnapshot(context.query),
      version,
      { admissionDeadlineAt: context.admissionExpiresAt },
      loadEligibility,
    )
    const { preparation } = evaluated
    const decision = yield* Effect.gen(function* () {
      const evidence = yield* Effect.fromResult(
        preparation === undefined
          ? Schema.decodeUnknownResult(JevDecisionEvidenceSchema, strictParseOptions)(evaluated.evidence)
          : prepareJevDecisionEvidence(preparation, evaluated.evidence.batchResult, evaluated.evidence.decidedAt),
      )
      if (Date.parse(evidence.decidedAt) >= context.admissionExpiresAt)
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission expired before its decision evidence completed',
          readiness: DecisionReadinessReason.NoEligibleCandidate,
        })
      return yield* Effect.fromResult(strategy.definition.decide({ market: evidence }))
    }).pipe(
      withObservedStage('bayn.jev.entry-selection', { operation: preparation === undefined ? 'replay' : 'retained' }),
    )
    return { snapshot: evaluated.snapshot, decision }
  })

/** Live and research alpha share fresh broker eligibility and the subsequent source observation cut. */
export const observeNativeAlphaEntry = (
  context: EntryObservationContext,
  loadTrailingBaseline?: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<IntradayAlphaTrailingBaseline, OperationalError | JevAwaitingEvidence>,
): ReturnType<EntryObservation> => {
  if (isIntradayAlphaRuntime(context.strategy)) {
    const policy = context.strategy.definition.parameters
    return Effect.fromResult(
      makeIntradayAlphaEntryQuery({
        policy,
        calendar: context.calendar,
        sessionDate: context.sessionDate,
        observedAtMs: Date.parse(context.observedAt),
      }),
    ).pipe(
      Effect.flatMap((query) =>
        evaluateIntradayAlphaFromSnapshot({
          observation: context.observation,
          rangeEndAt: query.rangeEndAt,
          loadSnapshot: currentUtcInstant.pipe(
            Effect.flatMap((observedAt) => context.loadSnapshot({ ...query, observedAt })),
          ),
          ...(equityClockSession(context.observedAt) === 'regular'
            ? {
                loadEligibility: readEquityShortEligibility(query.candidateSymbols ?? []).pipe(
                  Effect.mapError((cause) =>
                    operationalError({
                      component: 'strategy',
                      operation: 'current-decision',
                      message: 'Intraday alpha broker eligibility could not be observed',
                      cause,
                    }),
                  ),
                ),
              }
            : {}),
          policy,
          admissionExpiresAt: context.admissionExpiresAt,
          ...(loadTrailingBaseline === undefined ? {} : { loadTrailingBaseline: loadTrailingBaseline(query) }),
        }),
      ),
    )
  }
  return Effect.fail(
    operationalError({
      component: 'strategy',
      operation: 'current-decision',
      message: 'Native alpha observation requires its explicit alpha runtime',
    }),
  )
}

export const observeNativeEntry: EntryObservation = (context) => {
  if (isIntradayAlphaRuntime(context.strategy)) {
    const policy = context.strategy.definition.parameters
    return Effect.gen(function* () {
      const preparation = yield* Effect.serviceOption(NativeAlphaBaselinePreparation)
      if (Option.isNone(preparation))
        return yield* operationalError({
          component: 'market-data',
          operation: 'alpha-baseline-preparation',
          message: 'Native alpha requires its durable prospective baseline preparation',
        })
      // Preparation commits on the existing preopen wake even when the subsequent entry query is still warming up.
      const recorded = yield* preparation.value
        .prepare({
          cycleId: context.observation.cycleId,
          authorityGenerationHash: context.observation.authorityGenerationHash,
          accountId: context.observation.portfolio.brokerState.account.accountId,
          sessionDate: context.sessionDate,
          calendar: context.calendar,
          policy,
        })
        .pipe(
          Effect.catchTag('TrailingBaselinePendingCoverage', (pending) =>
            Effect.fail(
              new JevAwaitingEvidence({
                message: pending.message,
                readiness: DecisionReadinessReason.LookbackWarmup,
                availableAt: utcInstantFromEpochMillis(
                  jevFirstSignalDueMs(Date.parse(pending.regularOpenAt), policy.sharedProtocol),
                ),
              }),
            ),
          ),
        )
      const query = yield* Effect.fromResult(
        makeIntradayAlphaEntryQuery({
          policy,
          calendar: context.calendar,
          sessionDate: context.sessionDate,
          observedAtMs: Date.parse(context.observedAt),
        }),
      )
      if (Date.parse(recorded.recordedAt) > Date.parse(context.observedAt))
        return yield* new JevAwaitingEvidence({
          message: 'Native alpha baseline preparation committed after this original admission cut',
          readiness: DecisionReadinessReason.SnapshotUnavailable,
          availableAt: utcInstantFromEpochMillis(
            jevSignalDueAtMs(Date.parse(query.rangeEndAt) + jevSignalIntervalMs, policy.sharedProtocol),
          ),
        })
      return yield* observeNativeAlphaEntry(context, () =>
        Effect.succeed(recorded.payload.acquisition.trailingBaseline),
      )
    })
  }
  return context.strategy.definition.parameters.schemaVersion === defaultJevProtocolDocument.schemaVersion
    ? observeChartEntry(
        {
          ...context,
          loadSnapshot: (query) =>
            currentUtcInstant.pipe(Effect.flatMap((observedAt) => context.loadSnapshot({ ...query, observedAt }))),
        },
        JevBatchPlanVersion.V8,
        context.query.feed === 'iex' && equityClockSession(context.observedAt) === 'regular'
          ? readEquityShortEligibility(context.query.candidateSymbols ?? []).pipe(
              Effect.mapError((cause) =>
                operationalError({
                  component: 'strategy',
                  operation: 'current-decision',
                  message: 'Native entry broker eligibility could not be observed',
                  cause,
                }),
              ),
            )
          : undefined,
      )
    : Effect.fail(
        operationalError({
          component: 'strategy',
          operation: 'current-decision',
          message: 'Native entry requires the source-controlled Jev protocol',
        }),
      )
}
