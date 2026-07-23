import { Clock, Data, Effect } from 'effect'

import { CycleState, CycleTerminalReason, signalSessionCloseAt, type AutonomousCycle } from './cycle'
import { CycleStore, type CycleMutationReceipt, type CycleStoreError, type CycleStoreShape } from './db/cycle-store'
import type { OperationalError } from './errors'
import { MarketData, type MarketDataInspection, type MarketDataService } from './market-data'

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

const currentTime = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))

const elapsed = (later: string, earlier: string, name: string): number => {
  const milliseconds = Date.parse(later) - Date.parse(earlier)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError(`${name} must be a non-negative safe millisecond duration`)
  }
  return milliseconds
}

export const measurePublicationFreshness = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): PublicationFreshness => {
  const snapshot = inspection.manifest.finalizedSnapshot
  if (
    snapshot.asOfSession !== cycle.identity.signalSessionDate ||
    snapshot.lastSession !== cycle.identity.signalSessionDate
  ) {
    throw new TypeError('finalized Signal publication does not end at the cycle signal session')
  }
  if (snapshot.calendarVersion !== cycle.identity.signalCalendarVersion) {
    throw new TypeError('finalized Signal publication does not match the cycle Signal calendar')
  }
  if (
    inspection.signalSession.session_date !== cycle.identity.signalSessionDate ||
    inspection.signalSession.calendar_version !== cycle.identity.signalCalendarVersion ||
    signalSessionCloseAt(inspection.signalSession) !== cycle.window.signalCloseAt
  ) {
    throw new TypeError('verified Signal session material does not match the cycle window')
  }
  return {
    dataAgeMs: elapsed(observedAt, snapshot.finalizedAt, 'Signal data age'),
    publicationDelayMs: elapsed(snapshot.finalizedAt, cycle.window.signalCloseAt, 'Signal publication delay'),
  }
}

const boundResult = (
  outcome: 'BOUND' | 'ALREADY_BOUND',
  receipt: CycleMutationReceipt,
  observedAt: string,
  freshness?: PublicationFreshness,
): CyclePublicationReadiness => {
  const snapshotId = receipt.cycle.bindings.snapshotId
  if (snapshotId === undefined) {
    throw new TypeError('successful finalized-publication binding did not retain a snapshot ID')
  }
  return {
    outcome,
    observedAt,
    cycle: receipt.cycle,
    snapshotId,
    ...(freshness === undefined ? {} : { freshness }),
  }
}

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

const inspectBoundPublication = (
  cycle: AutonomousCycle,
  marketData: MarketDataService,
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
          const observedAt = yield* currentTime
          const freshness = yield* Effect.try({
            try: () => measurePublicationFreshness(cycle, publication.inspection, observedAt),
            catch: (cause) =>
              readinessError(
                'measure-freshness',
                'contract',
                'bound finalized Signal publication freshness is invalid',
                cause,
              ),
          })
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

export const runCyclePublicationReadiness = (
  cycle: AutonomousCycle,
): Effect.Effect<CyclePublicationReadiness, CycleReadinessError, MarketData | CycleStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const store = yield* CycleStore
    const initialObservedAt = yield* currentTime

    if (cycle.state === CycleState.Blocked) {
      return { outcome: 'BLOCKED', observedAt: initialObservedAt, cycle }
    }
    if (cycle.bindings.snapshotId !== undefined) {
      return yield* inspectBoundPublication(cycle, marketData)
    }
    if (cycle.state !== CycleState.Pending) {
      return yield* Effect.fail(
        readinessError('inspect-publication', 'contract', `unbound cycle ${cycle.identity.cycleId} is not pending`),
      )
    }
    if (initialObservedAt >= cycle.window.publicationDeadlineAt) {
      return yield* blockMissedPublication(store, cycle.identity.cycleId, initialObservedAt)
    }
    if (initialObservedAt < cycle.window.signalCloseAt) {
      return {
        outcome: 'WAITING',
        reason: 'SIGNAL_SESSION_OPEN',
        observedAt: initialObservedAt,
        cycle,
      }
    }

    return yield* Effect.matchEffect(
      marketData.inspectPublication({
        signalSessionDate: cycle.identity.signalSessionDate,
        signalCalendarVersion: cycle.identity.signalCalendarVersion,
      }),
      {
        onFailure: (cause: OperationalError) =>
          Effect.gen(function* () {
            const observedAt = yield* currentTime
            if (observedAt >= cycle.window.publicationDeadlineAt) {
              return yield* blockMissedPublication(store, cycle.identity.cycleId, observedAt)
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
            const observedAt = yield* currentTime
            if (observedAt >= cycle.window.publicationDeadlineAt) {
              return yield* blockMissedPublication(store, cycle.identity.cycleId, observedAt)
            }
            if (publication.outcome === 'MISSING') {
              return {
                outcome: 'WAITING',
                reason: 'PUBLICATION_MISSING',
                observedAt,
                cycle,
              } as const
            }
            const freshness = yield* Effect.try({
              try: () => measurePublicationFreshness(cycle, publication.inspection, observedAt),
              catch: (cause) =>
                readinessError(
                  'measure-freshness',
                  'contract',
                  'finalized Signal publication freshness is invalid',
                  cause,
                ),
            })
            const receipt = yield* store
              .bindSnapshot(cycle.identity.cycleId, publication.inspection.manifest, observedAt)
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
            return yield* Effect.try({
              try: () => boundResult(receipt.changed ? 'BOUND' : 'ALREADY_BOUND', receipt, observedAt, freshness),
              catch: (cause) =>
                readinessError(
                  'bind-publication',
                  'contract',
                  'finalized Signal publication binding returned an invalid cycle',
                  cause,
                ),
            })
          }),
      },
    )
  })
