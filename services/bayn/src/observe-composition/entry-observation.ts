import { Effect, Schema } from 'effect'

import { DecisionReadinessReason } from '../cycle/runner/readiness'
import type { AutonomousCycle } from '../cycle/model'
import { operationalError, type OperationalError } from '../errors'
import type { ExecutionSessionBinding } from '../execution-session'
import { JevBatchPlanVersion } from '../jev/batch'
import type { JevContractError } from '../jev/contract'
import { JevDecisionEvidenceSchema } from '../jev/decision'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevAwaitingEvidence, evaluateJevObservationFromSnapshot } from '../jev/runtime'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { isRepeatedMomentumRuntime, type StrategyRuntime } from '../strategy'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { strictParseOptions } from '../schemas'
import type { ObserveDecisionAwaitingSignal } from './decision-builder'
import type { CandidateObservationStore } from './candidate-observation'

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
  { readonly snapshot: VerifiedStrategyMarketSnapshot; readonly decision: ProtectedEntryTarget },
  Effect.Error<Evaluation> | Schema.SchemaError | JevContractError,
  Effect.Services<Evaluation>
>

export const observeChartEntry = (
  context: EntryObservationContext,
  version: JevBatchPlanVersion.V8 | JevBatchPlanVersion.Ablation,
) =>
  Effect.gen(function* () {
    const strategy = context.strategy
    if (isRepeatedMomentumRuntime(strategy))
      return yield* operationalError({
        component: 'strategy',
        operation: 'current-decision',
        message: 'Chart entry requires a chart strategy',
      })
    const evaluated = yield* evaluateJevObservationFromSnapshot(
      context.observation,
      context.query.rangeEndAt,
      context.loadSnapshot(context.query),
      version,
      { admissionDeadlineAt: context.admissionExpiresAt },
    )
    const evidence = yield* Effect.fromResult(
      Schema.decodeUnknownResult(JevDecisionEvidenceSchema, strictParseOptions)(evaluated.evidence),
    )
    if (Date.parse(evidence.decidedAt) >= context.admissionExpiresAt)
      return yield* new JevAwaitingEvidence({
        message: 'Entry admission expired before its decision evidence completed',
        readiness: DecisionReadinessReason.NoEligibleCandidate,
      })
    const decision = yield* Effect.fromResult(strategy.definition.decide({ market: evidence }))
    return { snapshot: evaluated.snapshot, decision }
  })

export const observeNativeEntry: EntryObservation = (context) =>
  context.strategy.definition.parameters.schemaVersion === defaultJevProtocolDocument.schemaVersion
    ? observeChartEntry(context, JevBatchPlanVersion.V8)
    : Effect.fail(
        operationalError({
          component: 'strategy',
          operation: 'current-decision',
          message: 'Native entry requires the source-controlled Jev protocol',
        }),
      )
