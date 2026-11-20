import { Effect, Schema } from 'effect'

import { DecisionReadinessReason } from '../cycle/runner/readiness'
import type { AutonomousCycle } from '../cycle/model'
import { operationalError, type OperationalError } from '../errors'
import type { ExecutionSessionBinding } from '../execution-session'
import { JevBatchPlanVersion } from '../jev/batch'
import type { JevContractError } from '../jev/contract'
import { JevDecisionEvidenceSchema, prepareJevDecisionEvidence } from '../jev/decision'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevAwaitingEvidence, evaluateJevObservationFromSnapshot } from '../jev/runtime'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import type { StrategyMarketSnapshot, VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { isRepeatedMomentumRuntime, type StrategyRuntime } from '../strategy'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { strictParseOptions } from '../schemas'
import type { ObserveDecisionAwaitingSignal } from './decision-builder'
import type { CandidateObservationStore } from './candidate-observation'
import { readEquityShortEligibility } from '../execution/equity-short'
import { currentUtcInstant } from '../time'
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
    if (isRepeatedMomentumRuntime(strategy))
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

export const observeNativeEntry = (context: EntryObservationContext) =>
  context.strategy.definition.parameters.schemaVersion === defaultJevProtocolDocument.schemaVersion
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
