import { Data, Effect, Result } from 'effect'

import { CycleTerminalReason, signalSessionCloseAt, type AutonomousCycle, type CycleConstructionFailure } from './cycle'
import {
  decideCyclePublicationAdmission,
  decideFinalizedPublicationBinding,
  decidePublicationInspection,
} from './cycle-runner/publication-decisions'
import { CycleStore, type CycleMutationReceipt, type CycleStoreError, type CycleStoreShape } from './db/cycle-store'
import type { OperationalError } from './errors'
import { MarketData, type MarketDataInspection, type MarketDataService } from './market-data'
import { currentUtcInstant } from './time'

export interface PublicationFreshness {
  readonly dataAgeMs: number
  readonly publicationDelayMs: number
}

export type CyclePublicationReadiness =
  | {
      readonly outcome: 'WAITING'
      readonly reason: 'SIGNAL_SESSION_OPEN' | 'PUBLICATION_MISSING'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'BOUND' | 'ALREADY_BOUND'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
      readonly snapshotId: string
      readonly freshness?: PublicationFreshness
    }
  | {
      readonly outcome: 'BLOCKED'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }

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

export type PublicationFreshnessFailure =
  | {
      readonly _tag: 'PublicationSessionMismatch'
      readonly expectedSessionDate: string
      readonly observedAsOfSession: string
      readonly observedLastSession: string
    }
  | {
      readonly _tag: 'PublicationCalendarMismatch'
      readonly expectedCalendarVersion: string
      readonly observedCalendarVersion: string
    }
  | {
      readonly _tag: 'PublicationSignalSessionMismatch'
      readonly expectedSessionDate: string
      readonly expectedCalendarVersion: string
      readonly observedSessionDate: string
      readonly observedCalendarVersion: string
    }
  | {
      readonly _tag: 'PublicationSignalCloseInvalid'
      readonly cause: CycleConstructionFailure
    }
  | {
      readonly _tag: 'PublicationSignalCloseMismatch'
      readonly expectedSignalCloseAt: string
      readonly observedSignalCloseAt: string
    }
  | {
      readonly _tag: 'PublicationElapsedInvalid'
      readonly measurement: 'data-age' | 'publication-delay'
      readonly later: string
      readonly earlier: string
      readonly milliseconds: number
    }

type BoundPublicationFailure = {
  readonly _tag: 'BoundPublicationSnapshotMissing'
  readonly cycleId: string
}

const elapsed = (
  later: string,
  earlier: string,
  measurement: Extract<PublicationFreshnessFailure, { readonly _tag: 'PublicationElapsedInvalid' }>['measurement'],
): Result.Result<number, PublicationFreshnessFailure> => {
  const milliseconds = Date.parse(later) - Date.parse(earlier)
  return !Number.isSafeInteger(milliseconds) || milliseconds < 0
    ? Result.fail({ _tag: 'PublicationElapsedInvalid', measurement, later, earlier, milliseconds })
    : Result.succeed(milliseconds)
}

export const measurePublicationFreshness = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Result.Result<PublicationFreshness, PublicationFreshnessFailure> => {
  const snapshot = inspection.manifest.finalizedSnapshot
  if (
    snapshot.asOfSession !== cycle.identity.signalSessionDate ||
    snapshot.lastSession !== cycle.identity.signalSessionDate
  ) {
    return Result.fail({
      _tag: 'PublicationSessionMismatch',
      expectedSessionDate: cycle.identity.signalSessionDate,
      observedAsOfSession: snapshot.asOfSession,
      observedLastSession: snapshot.lastSession,
    })
  }
  if (snapshot.calendarVersion !== cycle.identity.signalCalendarVersion) {
    return Result.fail({
      _tag: 'PublicationCalendarMismatch',
      expectedCalendarVersion: cycle.identity.signalCalendarVersion,
      observedCalendarVersion: snapshot.calendarVersion,
    })
  }
  if (
    inspection.signalSession.session_date !== cycle.identity.signalSessionDate ||
    inspection.signalSession.calendar_version !== cycle.identity.signalCalendarVersion
  ) {
    return Result.fail({
      _tag: 'PublicationSignalSessionMismatch',
      expectedSessionDate: cycle.identity.signalSessionDate,
      expectedCalendarVersion: cycle.identity.signalCalendarVersion,
      observedSessionDate: inspection.signalSession.session_date,
      observedCalendarVersion: inspection.signalSession.calendar_version,
    })
  }
  return Result.flatMap(
    Result.mapError(
      signalSessionCloseAt(inspection.signalSession),
      (cause): PublicationFreshnessFailure => ({ _tag: 'PublicationSignalCloseInvalid', cause }),
    ),
    (observedSignalCloseAt) =>
      observedSignalCloseAt !== cycle.window.signalCloseAt
        ? Result.fail({
            _tag: 'PublicationSignalCloseMismatch',
            expectedSignalCloseAt: cycle.window.signalCloseAt,
            observedSignalCloseAt,
          })
        : Result.flatMap(elapsed(observedAt, snapshot.finalizedAt, 'data-age'), (dataAgeMs) =>
            Result.map(
              elapsed(snapshot.finalizedAt, cycle.window.signalCloseAt, 'publication-delay'),
              (publicationDelayMs) => ({ dataAgeMs, publicationDelayMs }),
            ),
          ),
  )
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
        return yield* Effect.fail(
          readinessError(
            'bind-publication',
            'contract',
            'finalized Signal publication differs from the immutable cycle binding',
          ),
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
        return yield* Effect.fail(
          readinessError('bind-publication', 'contract', `unbound cycle ${cycle.identity.cycleId} is not pending`),
        )
      case 'BLOCK_MISSED':
        return yield* blockMissedPublication(store, cycle.identity.cycleId, observedAt)
      case 'REJECT_BEFORE_SIGNAL_CLOSE':
        return yield* Effect.fail(
          readinessError(
            'bind-publication',
            'contract',
            'finalized Signal publication cannot bind before the cycle signal close',
          ),
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

export const bindFinalizedCyclePublication = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError, CycleStore> =>
  Effect.flatMap(CycleStore, (store) => bindFinalizedCyclePublicationWith(store, cycle, inspection, observedAt))

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
            return yield* Effect.fail(
              readinessError(
                'inspect-publication',
                'contract',
                'bound finalized Signal publication is missing from its durable source',
              ),
            )
          }
          if (publication.inspection.manifest.finalizedSnapshot.snapshotId !== boundSnapshotId) {
            return yield* Effect.fail(
              readinessError(
                'inspect-publication',
                'contract',
                'finalized Signal publication does not match the immutable cycle binding',
              ),
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
        return yield* Effect.fail(
          readinessError('inspect-publication', 'contract', `unbound cycle ${cycle.identity.cycleId} is not pending`),
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
            return yield* Effect.fail(
              readinessError(
                'inspect-publication',
                'market-data',
                'finalized Signal publication inspection failed before its deadline',
                cause,
              ),
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
                  return yield* Effect.fail(
                    readinessError('inspect-publication', 'contract', 'publication decision lost finalized evidence'),
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
