import { Effect, Option, pipe } from 'effect'

import { BrokerRead, type MarketCalendarObservation } from '../broker/alpaca'
import { CycleState, type AutonomousCycle } from '../cycle'
import {
  bindFinalizedCyclePublication,
  runCyclePublicationReadiness,
  type CycleReadinessError,
} from '../cycle-readiness'
import { selectCycleRecovery, type CycleRecoverySelection, type CycleRecoveryState } from '../cycle-recovery'
import { CycleStore, type CycleStoreShape } from '../db/cycle-store'
import type { OperationalError } from '../errors'
import { MarketData, type MarketDataInspection } from '../market-data'
import { currentUtcInstant } from '../time'
import {
  beginCycleAuthoritySelection,
  calendarCandidateFailureError,
  calendarQueryFailureError,
  completeCycleAuthoritySelection,
  finishRecoveryResult,
  marketCalendarQueryForPublications,
  readinessFailure,
  reduceCycleAuthoritySelection,
  selectCycleCalendarCandidate,
  selectCyclePassContinuation,
  selectDiscoveredPublications,
  type CycleAcquireMaterial,
  type CycleAuthoritySelection,
  type CycleAuthoritySelectionState,
  type CycleAuthoritySlot,
  type CyclePassProgress,
  type NonEmptyPublications,
} from './decisions'
import {
  runnerError,
  type CycleBindingResult,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'

const currentIsoTime = currentUtcInstant

const bindDiscoveredPublication = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Effect.Effect<CycleBindingResult, CycleRunnerError, CycleStore> =>
  bindFinalizedCyclePublication(cycle, inspection, observedAt).pipe(
    Effect.mapError((cause: CycleReadinessError) =>
      runnerError(
        'bind-publication',
        cause.failure === 'store' ? 'store' : 'contract',
        'exact finalized Signal publication binding failed',
        cause,
      ),
    ),
    Effect.flatMap((readiness) =>
      readiness.outcome === 'WAITING'
        ? Effect.fail(
            runnerError(
              'bind-publication',
              'contract',
              'discovered finalized Signal publication unexpectedly remained waiting',
            ),
          )
        : Effect.succeed(readiness),
    ),
  )

const readCycleAuthoritySlot = <R>(
  store: CycleStoreShape,
  context: CycleRunContext<R>,
  publication: MarketDataInspection,
): Effect.Effect<CycleAuthoritySlot, CycleRunnerError> => {
  const signalSessionDate = publication.signalSession.session_date
  return pipe(
    store.readAuthoritySlot({
      qualificationRunId: context.qualificationRunId,
      accountId: context.accountId,
      signalSessionDate,
    }),
    Effect.mapError((cause) =>
      runnerError('read-authority-slot', 'store', 'durable autonomous cycle authority-slot read failed', cause),
    ),
    Effect.map((existing) => ({ publication, existing: Option.getOrUndefined(existing) })),
  )
}

const continueCycleAuthorityReads = <R>(
  store: CycleStoreShape,
  context: CycleRunContext<R>,
  state: CycleAuthoritySelectionState,
  publications: readonly MarketDataInspection[],
): Effect.Effect<CycleAuthoritySelection, CycleRunnerError> => {
  const [publication, ...remaining] = publications
  if (publication === undefined) {
    return Effect.succeed(completeCycleAuthoritySelection(state, context.cadence))
  }
  return pipe(
    readCycleAuthoritySlot(store, context, publication),
    Effect.flatMap((slot) => {
      const reduction = reduceCycleAuthoritySelection(state, slot)
      return reduction._tag === 'CONTINUE'
        ? continueCycleAuthorityReads(store, context, reduction.state, remaining)
        : Effect.succeed(reduction)
    }),
  )
}

const readCycleAuthoritySlots = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
): Effect.Effect<CycleAuthoritySelection, CycleRunnerError, CycleStore> =>
  pipe(
    CycleStore,
    Effect.flatMap((store) => {
      const [firstPublication, ...remainingPublications] = publications
      return pipe(
        readCycleAuthoritySlot(store, context, firstPublication),
        Effect.flatMap((slot) => {
          const initial = beginCycleAuthoritySelection(slot)
          return initial._tag === 'CONTINUE'
            ? continueCycleAuthorityReads(store, context, initial.state, remainingPublications)
            : Effect.succeed(initial)
        }),
      )
    }),
  )

const resumeDiscoveredPublication = (
  selection: Extract<CycleAuthoritySelection, { readonly _tag: 'RESUME' }>,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  pipe(
    currentIsoTime,
    Effect.flatMap((observedAt) =>
      pipe(
        bindDiscoveredPublication(selection.cycle, selection.publication, observedAt),
        Effect.map(
          (readiness): CycleRunResult => ({
            outcome: 'RESUMED',
            signalSessionDate: selection.publication.signalSession.session_date,
            observedAt,
            readiness,
          }),
        ),
      ),
    ),
  )

const acquireCycleCandidate = (
  material: CycleAcquireMaterial,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  pipe(
    CycleStore,
    Effect.flatMap((store) =>
      pipe(
        currentIsoTime,
        Effect.flatMap((acquiredAt) =>
          pipe(
            store.acquire(material.draft, acquiredAt),
            Effect.mapError((cause) =>
              runnerError('acquire-cycle', 'store', 'durable autonomous cycle acquisition failed', cause),
            ),
          ),
        ),
        Effect.flatMap((receipt) =>
          pipe(
            currentIsoTime,
            Effect.flatMap((bindingObservedAt) =>
              pipe(
                bindDiscoveredPublication(receipt.cycle, material.publication, bindingObservedAt),
                Effect.map(
                  (readiness): CycleRunResult => ({
                    outcome: receipt.created ? 'ACQUIRED' : 'REACQUIRED',
                    signalSessionDate: material.signalSessionDate,
                    executionSessionDate: material.executionSessionDate,
                    observedAt: bindingObservedAt,
                    calendarResponseHash: material.calendarResponseHash,
                    calendarReadContentHash: material.calendarReadContentHash,
                    receipt,
                    readiness,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

const interpretCycleCalendar = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  Effect.fromResult(
    selectCycleCalendarCandidate(context, publications, observation, calendarReadContentHash, observedAt),
  ).pipe(
    Effect.mapError(calendarCandidateFailureError),
    Effect.flatMap((decision) =>
      decision._tag === 'NOT_DUE' ? Effect.succeed(decision.result) : acquireCycleCandidate(decision.material),
    ),
  )

const readCycleCalendar = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> =>
  pipe(
    marketCalendarQueryForPublications(publications),
    Effect.fromResult,
    Effect.mapError(calendarQueryFailureError),
    Effect.flatMap((query) =>
      pipe(
        BrokerRead,
        Effect.flatMap((broker) => broker.marketCalendar(query)),
        Effect.mapError((cause) =>
          runnerError('market-calendar', 'calendar-read', 'authoritative broker calendar read failed', cause),
        ),
      ),
    ),
    Effect.flatMap((calendar) =>
      pipe(
        currentIsoTime,
        Effect.flatMap((observedAt) =>
          interpretCycleCalendar(context, publications, calendar.value, calendar.evidence.contentHash, observedAt),
        ),
      ),
    ),
  )

const interpretCycleAuthoritySelection = <R>(
  context: CycleRunContext<R>,
  selection: CycleAuthoritySelection,
  discoveryObservedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> => {
  switch (selection._tag) {
    case 'RESUME':
      return resumeDiscoveredPublication(selection)
    case 'ALREADY_ACQUIRED':
      return Effect.succeed({
        outcome: 'ALREADY_ACQUIRED',
        signalSessionDate: selection.publication.signalSession.session_date,
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'ALREADY_TERMINAL':
      return Effect.succeed({
        outcome: 'ALREADY_TERMINAL',
        signalSessionDate: selection.cycle.identity.signalSessionDate,
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'READ_CALENDAR':
      return readCycleCalendar(context, selection.publications)
  }
}

export const discoverAutonomousCyclePass = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> =>
  pipe(
    MarketData,
    Effect.flatMap((marketData) => marketData.inspectCyclePublications),
    Effect.mapError((cause: OperationalError) =>
      runnerError('inspect-publication', 'market-data', 'bounded finalized Signal publication discovery failed', cause),
    ),
    Effect.flatMap((discovery) =>
      pipe(
        selectDiscoveredPublications(discovery),
        Effect.fromResult,
        Effect.flatMap((decision) =>
          decision._tag === 'NO_PUBLICATION'
            ? Effect.succeed(decision.result)
            : pipe(
                readCycleAuthoritySlots(context, decision.publications),
                Effect.flatMap((selection) =>
                  interpretCycleAuthoritySelection(context, selection, decision.observedAt),
                ),
              ),
        ),
      ),
    ),
  )

const chooseRecovery = (state: CycleRecoveryState): Effect.Effect<CycleRecoverySelection, CycleRunnerError> =>
  Effect.fromResult(selectCycleRecovery(state)).pipe(
    Effect.mapError((cause) =>
      runnerError('recover-cycle', 'contract', 'autonomous cycle recovery state is invalid', cause),
    ),
  )

const recoverCycle = <R>(
  selection: CycleRecoverySelection,
  context: CycleRunContext<R>,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> => {
  switch (selection.action) {
    case 'DISCOVER':
      return discoverAutonomousCyclePass(context)
    case 'BLOCK':
      return pipe(
        CycleStore,
        Effect.flatMap((store) => store.block(selection.cycleId, selection.reason, selection.observedAt)),
        Effect.mapError((cause) =>
          runnerError('recover-cycle', 'store', 'unfinished autonomous cycle blocking failed', cause),
        ),
        Effect.map(
          (blocked): CycleRunResult => ({
            outcome: 'RECOVERED',
            action: 'BLOCKED',
            observedAt: selection.observedAt,
            cycle: blocked.cycle,
          }),
        ),
      )
    case 'READ_PUBLICATION':
      return runCyclePublicationReadiness(selection.cycle).pipe(
        Effect.mapError((cause: CycleReadinessError) =>
          runnerError('recover-cycle', readinessFailure(cause), 'unfinished cycle publication recovery failed', cause),
        ),
        Effect.flatMap((readiness) =>
          chooseRecovery({
            qualificationRunId: context.qualificationRunId,
            accountId: context.accountId,
            strategyProtocolHash: context.strategyProtocolHash,
            observedAt,
            cycle: selection.cycle,
            readiness,
          }),
        ),
        Effect.flatMap((next) => recoverCycle(next, context, observedAt)),
      )
    case 'RETURN_READINESS':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: selection.recoveryAction,
        observedAt: selection.result.observedAt,
        cycle: selection.result.cycle,
      })
    case 'ACTIVATE':
      return pipe(
        CycleStore,
        Effect.flatMap((store) => store.activate(selection.cycleId, selection.observedAt)),
        Effect.mapError((cause) =>
          runnerError('recover-cycle', 'store', 'snapshot-bound cycle activation failed', cause),
        ),
        Effect.map(
          (activation): CycleRunResult => ({
            outcome: 'RECOVERED',
            action: activation.cycle.state === CycleState.Blocked ? 'BLOCKED' : 'ACTIVATED',
            observedAt: selection.observedAt,
            cycle: activation.cycle,
          }),
        ),
      )
    case 'WAIT':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: 'WAITING',
        observedAt: selection.observedAt,
        cycle: selection.cycle,
      })
    case 'BUILD_DECISION':
      return context.buildDecision(selection.cycle).pipe(
        Effect.mapError((cause) => runnerError('build-decision', cause.failure, cause.message, cause)),
        Effect.flatMap((document) =>
          pipe(
            currentIsoTime,
            Effect.flatMap((bindObservedAt) =>
              pipe(
                CycleStore,
                Effect.flatMap((store) =>
                  store.bindDecision(selection.cycle.identity.cycleId, document, bindObservedAt),
                ),
                Effect.mapError((cause) =>
                  runnerError('recover-cycle', 'store', 'durable shadow decision binding failed', cause),
                ),
                Effect.map(
                  (binding): CycleRunResult => ({
                    outcome: 'RECOVERED',
                    action: binding.cycle.state === CycleState.Blocked ? 'BLOCKED' : 'BOUND_DECISION',
                    observedAt: binding.cycle.updatedAt,
                    cycle: binding.cycle,
                  }),
                ),
              ),
            ),
          ),
        ),
      )
    case 'READ_DECISION':
      return pipe(
        CycleStore,
        Effect.flatMap((store) => store.readDecisionDocument(selection.cycle.identity.cycleId)),
        Effect.mapError((cause) => runnerError('recover-cycle', 'store', 'durable shadow decision read failed', cause)),
        Effect.flatMap((document) =>
          pipe(
            currentIsoTime,
            Effect.flatMap((decisionObservedAt) =>
              pipe(
                chooseRecovery({
                  qualificationRunId: context.qualificationRunId,
                  accountId: context.accountId,
                  strategyProtocolHash: context.strategyProtocolHash,
                  observedAt: decisionObservedAt,
                  cycle: selection.cycle,
                  decisionDocument: Option.getOrNull(document),
                }),
                Effect.flatMap((next) => recoverCycle(next, context, decisionObservedAt)),
              ),
            ),
          ),
        ),
      )
    case 'FINISH':
      return pipe(
        CycleStore,
        Effect.flatMap((store) => store.finish(selection.cycleId, selection.state, selection.observedAt)),
        Effect.mapError((cause) =>
          runnerError('recover-cycle', 'store', 'shadow cycle terminal transition failed', cause),
        ),
        Effect.flatMap((finished) => Effect.fromResult(finishRecoveryResult(selection, finished.cycle))),
      )
  }
}

export const runAutonomousCyclePass = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> =>
  pipe(
    CycleStore,
    Effect.flatMap((store) =>
      store.readOldestUnfinished({
        qualificationRunId: context.qualificationRunId,
        accountId: context.accountId,
      }),
    ),
    Effect.mapError((cause) =>
      runnerError('read-oldest-unfinished', 'store', 'oldest unfinished autonomous cycle read failed', cause),
    ),
    Effect.flatMap((unfinished) =>
      pipe(
        currentIsoTime,
        Effect.flatMap((observedAt) =>
          pipe(
            chooseRecovery({
              qualificationRunId: context.qualificationRunId,
              accountId: context.accountId,
              strategyProtocolHash: context.strategyProtocolHash,
              observedAt,
              cycle: Option.getOrUndefined(unfinished),
            }),
            Effect.flatMap((selection) => recoverCycle(selection, context, observedAt)),
          ),
        ),
      ),
    ),
  )

const cycleProgressKey = (cycle: AutonomousCycle): string =>
  `${cycle.identity.cycleId}:${cycle.state}:${cycle.stateVersion}`

const continueAutonomousCyclePass = <R>(
  context: CycleRunContext<R>,
  completedProgress: ReadonlySet<CyclePassProgress>,
  previousProgressKey?: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> =>
  runAutonomousCyclePass(context).pipe(
    Effect.flatMap((result) => {
      const continuation = selectCyclePassContinuation(result)
      if (continuation._tag === 'RETURN') return Effect.succeed(result)
      const progressKey = cycleProgressKey(continuation.cycle)
      if (progressKey === previousProgressKey) {
        return Effect.fail(
          runnerError(
            'recover-cycle',
            'contract',
            `autonomous cycle pass repeated ${continuation.progress} without durable progress`,
          ),
        )
      }
      if (completedProgress.has(continuation.progress)) {
        return Effect.fail(
          runnerError(
            'recover-cycle',
            'contract',
            `autonomous cycle pass repeated ${continuation.progress} after durable progress`,
          ),
        )
      }
      return continueAutonomousCyclePass(context, new Set([...completedProgress, continuation.progress]), progressKey)
    }),
  )

export const runAutonomousCycleUntilSettled = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> =>
  continueAutonomousCyclePass(context, new Set())
