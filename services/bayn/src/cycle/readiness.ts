import { Data, Effect, Result } from 'effect'

import { CycleTerminalReason, type AutonomousCycle } from './model'
import {
  decideCyclePublicationAdmission,
  decideFinalizedPublicationBinding,
  decidePublicationInspection,
} from './runner/publication-decisions'
import {
  measurePublicationFreshness,
  type CyclePublicationReadiness,
  type PublicationFreshness,
} from './runner/recovery-readiness-model'
import { CycleStore, type CycleMutationReceipt, type CycleStoreError, type CycleStoreShape } from './store'
import type { OperationalError } from '../errors'
import { MarketData, type MarketDataInspection, type MarketDataService } from '../market-data'
import { Pipeable } from '../pipeable'
import { currentUtcInstant } from '../time'

export type {
  CyclePublicationReadiness,
  PublicationFreshness,
  PublicationFreshnessFailure,
} from './runner/recovery-readiness-model'
export { measurePublicationFreshness } from './runner/recovery-readiness-model'

export class CycleReadinessError extends Data.TaggedError('CycleReadinessError')<{
  readonly operation: 'bind-publication' | 'inspect-publication' | 'measure-freshness' | 'missed-publication'
  readonly failure: 'contract' | 'market-data' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

const readinessError = (
  operation: CycleReadinessError['operation'],
  failure: CycleReadinessError['failure'],
  message: string,
  cause?: unknown,
): CycleReadinessError => new CycleReadinessError({ operation, failure, message, cause })

interface CyclePublicationDependencies {
  readonly marketData: MarketDataService
  readonly store: CycleStoreShape
  readonly now: Effect.Effect<string>
}

type BoundPublicationFailure = {
  readonly _tag: 'BoundPublicationSnapshotMissing'
  readonly cycleId: string
}

const boundResult = (
  outcome: 'BOUND' | 'ALREADY_BOUND',
  receipt: CycleMutationReceipt,
  observedAt: string,
  freshness?: PublicationFreshness,
): Result.Result<CyclePublicationReadiness, BoundPublicationFailure> => {
  const snapshotId = receipt.cycle.bindings.snapshotId
  if (snapshotId === undefined) {
    return Result.fail({ _tag: 'BoundPublicationSnapshotMissing', cycleId: receipt.cycle.identity.cycleId })
  }
  return Result.succeed({
    outcome,
    observedAt,
    cycle: receipt.cycle,
    snapshotId,
    ...(freshness === undefined ? {} : { freshness }),
  })
}

const measureFreshness = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
  message: string,
): Effect.Effect<PublicationFreshness, CycleReadinessError> =>
  Effect.fromResult(measurePublicationFreshness(cycle, inspection, observedAt)).pipe(
    Effect.mapError((cause) => readinessError('measure-freshness', 'contract', message, cause)),
  )

const blockMissedPublication = (
  store: CycleStoreShape,
  cycleId: string,
  observedAt: string,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError> =>
  store.block(cycleId, CycleTerminalReason.MissedPublication, observedAt).pipe(
    Effect.map((receipt) => ({ outcome: 'BLOCKED', observedAt, cycle: receipt.cycle }) as const),
    Effect.mapError((cause: CycleStoreError) =>
      readinessError('missed-publication', 'store', 'failed to persist the missed publication deadline', cause),
    ),
  )

const bindFinalizedCyclePublicationWith = (
  store: CycleStoreShape,
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError> =>
  Effect.gen(function* () {
    const snapshotId = inspection.manifest.finalizedSnapshot.snapshotId
    switch (decideFinalizedPublicationBinding(cycle, snapshotId, observedAt)._tag) {
      case 'RETURN_BLOCKED':
        return { outcome: 'BLOCKED', observedAt, cycle }
      case 'REJECT_IMMUTABLE_BINDING':
        return yield* readinessError(
          'bind-publication',
          'contract',
          'finalized Signal publication differs from the immutable cycle binding',
        )

      case 'RETURN_ALREADY_BOUND': {
        const freshness = yield* measureFreshness(
          cycle,
          inspection,
          observedAt,
          'finalized Signal publication freshness is invalid',
        )
        return { outcome: 'ALREADY_BOUND', observedAt, cycle, snapshotId, freshness }
      }
      case 'REJECT_UNBOUND_STATE':
        return yield* readinessError(
          'bind-publication',
          'contract',
          `unbound cycle ${cycle.identity.cycleId} is not pending`,
        )

      case 'BLOCK_MISSED':
        return yield* blockMissedPublication(store, cycle.identity.cycleId, observedAt)
      case 'REJECT_BEFORE_SIGNAL_CLOSE':
        return yield* readinessError(
          'bind-publication',
          'contract',
          'finalized Signal publication cannot bind before the cycle signal close',
        )

      case 'BIND':
        break
    }
    const freshness = yield* measureFreshness(
      cycle,
      inspection,
      observedAt,
      'finalized Signal publication freshness is invalid',
    )
    const receipt = yield* store
      .bindSnapshot(cycle.identity.cycleId, inspection.manifest, observedAt)
      .pipe(
        Effect.mapError((cause) =>
          readinessError(
            'bind-publication',
            'store',
            'failed to persist and bind the finalized Signal publication',
            cause,
          ),
        ),
      )
    return yield* Effect.fromResult(
      boundResult(receipt.changed ? 'BOUND' : 'ALREADY_BOUND', receipt, observedAt, freshness),
    ).pipe(
      Effect.mapError((cause) =>
        readinessError(
          'bind-publication',
          'contract',
          'finalized Signal publication binding returned an invalid cycle',
          cause,
        ),
      ),
    )
  })

const bindFinalizedCyclePublicationDataFirst = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError, CycleStore> =>
  Effect.flatMap(CycleStore, (store) => bindFinalizedCyclePublicationWith(store, cycle, inspection, observedAt))

export const bindFinalizedCyclePublication = Pipeable.dual(3, bindFinalizedCyclePublicationDataFirst)

const inspectBoundPublication = (
  cycle: AutonomousCycle,
  marketData: MarketDataService,
  now: Effect.Effect<string>,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError> => {
  const boundSnapshotId = cycle.bindings.snapshotId
  if (boundSnapshotId === undefined) {
    return Effect.fail(readinessError('inspect-publication', 'contract', 'bound cycle does not retain a snapshot ID'))
  }
  return marketData
    .inspectSnapshotPublication({
      snapshotId: boundSnapshotId,
      signalSessionDate: cycle.identity.signalSessionDate,
      signalCalendarVersion: cycle.identity.signalCalendarVersion,
    })
    .pipe(
      Effect.mapError((cause) =>
        readinessError(
          'inspect-publication',
          'market-data',
          'failed to read back the bound finalized Signal publication',
          cause,
        ),
      ),
      Effect.flatMap((publication) =>
        Effect.gen(function* () {
          if (publication.outcome === 'MISSING') {
            return yield* readinessError(
              'inspect-publication',
              'contract',
              'bound finalized Signal publication is missing from its durable source',
            )
          }
          if (publication.inspection.manifest.finalizedSnapshot.snapshotId !== boundSnapshotId) {
            return yield* readinessError(
              'inspect-publication',
              'contract',
              'finalized Signal publication does not match the immutable cycle binding',
            )
          }
          const observedAt = yield* now
          const freshness = yield* measureFreshness(
            cycle,
            publication.inspection,
            observedAt,
            'bound finalized Signal publication freshness is invalid',
          )
          return {
            outcome: 'ALREADY_BOUND',
            observedAt,
            cycle,
            snapshotId: boundSnapshotId,
            freshness,
          } as const
        }),
      ),
    )
}

const runCyclePublicationReadinessWith = (
  dependencies: CyclePublicationDependencies,
  cycle: AutonomousCycle,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError> =>
  Effect.gen(function* () {
    const initialObservedAt = yield* dependencies.now
    switch (decideCyclePublicationAdmission(cycle, initialObservedAt)._tag) {
      case 'RETURN_BLOCKED':
        return { outcome: 'BLOCKED', observedAt: initialObservedAt, cycle }
      case 'INSPECT_BOUND':
        return yield* inspectBoundPublication(cycle, dependencies.marketData, dependencies.now)
      case 'REJECT_UNBOUND_STATE':
        return yield* readinessError(
          'inspect-publication',
          'contract',
          `unbound cycle ${cycle.identity.cycleId} is not pending`,
        )

      case 'BLOCK_MISSED':
        return yield* blockMissedPublication(dependencies.store, cycle.identity.cycleId, initialObservedAt)
      case 'WAIT_SIGNAL':
        return { outcome: 'WAITING', reason: 'SIGNAL_SESSION_OPEN', observedAt: initialObservedAt, cycle }
      case 'INSPECT_PUBLICATION':
        break
    }

    return yield* Effect.matchEffect(
      dependencies.marketData.inspectPublication({
        signalSessionDate: cycle.identity.signalSessionDate,
        signalCalendarVersion: cycle.identity.signalCalendarVersion,
      }),
      {
        onFailure: (cause: OperationalError) =>
          Effect.gen(function* () {
            const observedAt = yield* dependencies.now
            if (observedAt >= cycle.window.publicationDeadlineAt) {
              return yield* blockMissedPublication(dependencies.store, cycle.identity.cycleId, observedAt)
            }
            return yield* readinessError(
              'inspect-publication',
              'market-data',
              'finalized Signal publication inspection failed before its deadline',
              cause,
            )
          }),
        onSuccess: (publication) =>
          Effect.gen(function* () {
            const observedAt = yield* dependencies.now
            switch (
              decidePublicationInspection(
                publication.outcome !== 'MISSING',
                observedAt,
                cycle.window.publicationDeadlineAt,
              )._tag
            ) {
              case 'BLOCK_MISSED':
                return yield* blockMissedPublication(dependencies.store, cycle.identity.cycleId, observedAt)
              case 'WAIT_MISSING':
                return { outcome: 'WAITING', reason: 'PUBLICATION_MISSING', observedAt, cycle } as const
              case 'BIND_FINALIZED':
                if (publication.outcome === 'MISSING') {
                  return yield* readinessError(
                    'inspect-publication',
                    'contract',
                    'publication decision lost finalized evidence',
                  )
                }
                return yield* bindFinalizedCyclePublicationWith(
                  dependencies.store,
                  cycle,
                  publication.inspection,
                  observedAt,
                )
            }
          }),
      },
    )
  })

export const runCyclePublicationReadiness = (
  cycle: AutonomousCycle,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError, MarketData | CycleStore> =>
  Effect.all({ marketData: MarketData, store: CycleStore }).pipe(
    Effect.flatMap(({ marketData, store }) =>
      runCyclePublicationReadinessWith({ marketData, store, now: currentUtcInstant }, cycle),
    ),
  )
