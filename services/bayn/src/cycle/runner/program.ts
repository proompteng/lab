import { Effect, Option, pipe } from 'effect'

import { BrokerRead, type MarketCalendarObservation } from '../../broker/alpaca'
import type { OperationalError } from '../../errors'
import { MarketData, type MarketDataInspection } from '../../market-data'
import { currentUtcInstant } from '../../time'
import { CycleState, type AutonomousCycle } from '../model'
import { bindFinalizedCyclePublication, runCyclePublicationReadiness, type CycleReadinessError } from '../readiness'
import { selectCycleRecovery, type CycleRecoverySelection, type CycleRecoveryState } from '../recovery'
import { CycleStore, type CycleStoreShape } from '../store'
import { isTerminalCycleState } from '../transitions'
import {
  beginCycleAuthoritySelection,
  calendarCandidateFailureError,
  calendarQueryFailureError,
  completeCycleAuthoritySelection,
  finishRecoveryResult,
  makeIntradayCycleDraft,
  marketCalendarQueryFromSession,
  marketCalendarQueryForPublications,
  readinessFailure,
  reduceCycleAuthoritySelection,
  selectCycleAcquisition,
  selectCycleCalendarCandidate,
  selectIntradayExecutionSession,
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
      runnerError({
        operation: 'bind-publication',
        failure: cause.failure === 'store' ? 'store' : 'contract',
        message: 'exact finalized Signal publication binding failed',
        cause,
      }),
    ),
    Effect.flatMap((readiness) =>
      readiness.outcome === 'WAITING'
        ? Effect.fail(
            runnerError({
              operation: 'bind-publication',
              failure: 'contract',
              message: 'discovered finalized Signal publication unexpectedly remained waiting',
            }),
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
      runnerError({
        operation: 'read-authority-slot',
        failure: 'store',
        message: 'durable autonomous cycle authority-slot read failed',
        cause,
      }),
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
            observedAt,
            readiness,
          }),
        ),
      ),
    ),
  )

const acquireCycleCandidate = (
  cadence: CycleRunContext['cadence'],
  material: CycleAcquireMaterial,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  pipe(
    CycleStore,
    Effect.flatMap((store) =>
      pipe(
        currentIsoTime,
        Effect.flatMap((acquiredAt) => {
          const admission = selectCycleAcquisition(cadence, material, acquiredAt)
          if (admission._tag === 'NOT_DUE') return Effect.succeed(admission.result)
          return pipe(
            store.acquire(admission.material.draft, acquiredAt),
            Effect.mapError((cause) =>
              runnerError({
                operation: 'acquire-cycle',
                failure: 'store',
                message: 'durable autonomous cycle acquisition failed',
                cause,
              }),
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
          )
        }),
      ),
    ),
  )

const interpretCycleCalendar = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
  knownMissedCapitalBootstrap: boolean,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  Effect.fromResult(
    selectCycleCalendarCandidate(
      context,
      publications,
      observation,
      calendarReadContentHash,
      observedAt,
      knownMissedCapitalBootstrap,
    ),
  ).pipe(
    Effect.mapError(calendarCandidateFailureError),
    Effect.flatMap((decision) =>
      decision._tag === 'NOT_DUE'
        ? Effect.succeed(decision.result)
        : acquireCycleCandidate(context.cadence, decision.material),
    ),
  )

const readCycleCalendar = <R>(
  context: CycleRunContext<R>,
  selection: Extract<CycleAuthoritySelection, { readonly _tag: 'READ_CALENDAR' }>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> =>
  pipe(
    marketCalendarQueryForPublications(selection.publications),
    Effect.fromResult,
    Effect.mapError(calendarQueryFailureError),
    Effect.flatMap((query) =>
      pipe(
        BrokerRead,
        Effect.flatMap((broker) => broker.marketCalendar(query)),
        Effect.mapError((cause) =>
          runnerError({
            operation: 'market-calendar',
            failure: 'calendar-read',
            message: 'authoritative broker calendar read failed',
            cause,
          }),
        ),
      ),
    ),
    Effect.flatMap((calendar) =>
      pipe(
        currentIsoTime,
        Effect.flatMap((observedAt) =>
          interpretCycleCalendar(
            context,
            selection.publications,
            calendar.value,
            calendar.evidence.contentHash,
            observedAt,
            selection.reason === 'MISSED_CAPITAL_BOOTSTRAP',
          ),
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
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'ALREADY_TERMINAL':
      return Effect.succeed({
        outcome: 'ALREADY_TERMINAL',
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'READ_CALENDAR':
      return readCycleCalendar(context, selection)
  }
}

const discoverIntradayCyclePass = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> => {
  const candidate =
    context.strategyName === 'opening-drive-momentum' &&
    context.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v2'
      ? {
          qualificationRunId: context.qualificationRunId,
          strategyName: context.strategyName,
          strategyProtocolHash: context.strategyProtocolHash,
          accountId: context.accountId,
          executionPolicy: context.executionPolicy,
        }
      : context.strategyName === 'intraday-momentum' &&
          context.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v3'
        ? {
            qualificationRunId: context.qualificationRunId,
            strategyName: context.strategyName,
            strategyProtocolHash: context.strategyProtocolHash,
            accountId: context.accountId,
            executionPolicy: context.executionPolicy,
          }
        : undefined
  if (candidate === undefined) {
    return Effect.fail(
      runnerError({
        operation: 'configure',
        failure: 'invalid-config',
        message: 'intraday discovery requires an exact strategy and session-relative execution-policy pairing',
      }),
    )
  }
  return Effect.gen(function* () {
    const observedAt = yield* currentIsoTime
    const query = yield* Effect.fromResult(marketCalendarQueryFromSession(observedAt.slice(0, 10))).pipe(
      Effect.mapError(calendarQueryFailureError),
    )
    const broker = yield* BrokerRead
    const calendar = yield* broker.marketCalendar(query).pipe(
      Effect.mapError((cause) =>
        runnerError({
          operation: 'market-calendar',
          failure: 'calendar-read',
          message: 'authoritative broker calendar read failed',
          cause,
        }),
      ),
    )
    const executionSession = selectIntradayExecutionSession(calendar.value, candidate.executionPolicy, observedAt)
    if (executionSession === undefined) {
      return yield* runnerError({
        operation: 'select-session',
        failure: 'calendar-unavailable',
        message: 'broker calendar has no session whose intraday entry cutoff remains open',
      })
    }
    const draft = yield* Effect.fromResult(makeIntradayCycleDraft(candidate, calendar.value, executionSession)).pipe(
      Effect.mapError((cause) =>
        runnerError({
          operation: 'build-cycle',
          failure: 'contract',
          message: 'intraday autonomous cycle draft construction failed',
          cause,
        }),
      ),
    )
    const store = yield* CycleStore
    const existing = yield* store
      .readAuthoritySlot({
        qualificationRunId: context.qualificationRunId,
        accountId: context.accountId,
        executionSessionDate: draft.identity.executionSessionDate,
      })
      .pipe(
        Effect.mapError((cause) =>
          runnerError({
            operation: 'read-authority-slot',
            failure: 'store',
            message: 'durable intraday cycle authority-slot read failed',
            cause,
          }),
        ),
      )
    if (Option.isSome(existing)) {
      return isTerminalCycleState(existing.value.state)
        ? ({ outcome: 'ALREADY_TERMINAL', observedAt, cycle: existing.value } as const)
        : ({ outcome: 'ALREADY_ACQUIRED', observedAt, cycle: existing.value } as const)
    }
    const receipt = yield* store.acquire(draft, observedAt).pipe(
      Effect.mapError((cause) =>
        runnerError({
          operation: 'acquire-cycle',
          failure: 'store',
          message: 'durable intraday autonomous cycle acquisition failed',
          cause,
        }),
      ),
    )
    return {
      outcome: receipt.created ? 'ACQUIRED' : 'REACQUIRED',
      executionSessionDate: executionSession.date,
      observedAt,
      calendarResponseHash: calendar.value.normalizedResponseHash,
      calendarReadContentHash: calendar.evidence.contentHash,
      receipt,
    } as const
  })
}

export const discoverAutonomousCyclePass = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> =>
  context.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v2' ||
  context.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v3' ||
  context.strategyName === 'opening-drive-momentum' ||
  context.strategyName === 'intraday-momentum'
    ? discoverIntradayCyclePass(context)
    : pipe(
        MarketData,
        Effect.flatMap((marketData) => marketData.inspectCyclePublications),
        Effect.mapError((cause: OperationalError) =>
          runnerError({
            operation: 'inspect-publication',
            failure: 'market-data',
            message: 'bounded finalized Signal publication discovery failed',
            cause,
          }),
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
      runnerError({
        operation: 'recover-cycle',
        failure: 'contract',
        message: 'autonomous cycle recovery state is invalid',
        cause,
      }),
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
          runnerError({
            operation: 'recover-cycle',
            failure: 'store',
            message: 'unfinished autonomous cycle blocking failed',
            cause,
          }),
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
          runnerError({
            operation: 'recover-cycle',
            failure: readinessFailure(cause),
            message: 'unfinished cycle publication recovery failed',
            cause,
          }),
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
          runnerError({
            operation: 'recover-cycle',
            failure: 'store',
            message: 'durable cycle activation failed',
            cause,
          }),
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
        Effect.matchEffect({
          onFailure: (cause) =>
            cause.failure === 'not-ready'
              ? currentIsoTime.pipe(
                  Effect.map((observedAt) => ({
                    outcome: 'RECOVERED' as const,
                    action: 'WAITING' as const,
                    observedAt,
                    cycle: selection.cycle,
                  })),
                )
              : Effect.fail(
                  runnerError({
                    operation: 'build-decision',
                    failure: cause.failure,
                    message: cause.message,
                    cause,
                  }),
                ),
          onSuccess: (document) =>
            pipe(
              currentIsoTime,
              Effect.flatMap((bindObservedAt) =>
                pipe(
                  CycleStore,
                  Effect.flatMap((store) =>
                    store.bindDecision(selection.cycle.identity.cycleId, document, bindObservedAt),
                  ),
                  Effect.mapError((cause) =>
                    runnerError({
                      operation: 'recover-cycle',
                      failure: 'store',
                      message: 'durable shadow decision binding failed',
                      cause,
                    }),
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
        }),
      )
    case 'READ_DECISION':
      return pipe(
        CycleStore,
        Effect.flatMap((store) => store.readDecisionDocument(selection.cycle.identity.cycleId)),
        Effect.mapError((cause) =>
          runnerError({
            operation: 'recover-cycle',
            failure: 'store',
            message: 'durable shadow decision read failed',
            cause,
          }),
        ),
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
          runnerError({
            operation: 'recover-cycle',
            failure: 'store',
            message: 'shadow cycle terminal transition failed',
            cause,
          }),
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
      runnerError({
        operation: 'read-oldest-unfinished',
        failure: 'store',
        message: 'oldest unfinished autonomous cycle read failed',
        cause,
      }),
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
          runnerError({
            operation: 'recover-cycle',
            failure: 'contract',
            message: `autonomous cycle pass repeated ${continuation.progress} without durable progress`,
          }),
        )
      }
      if (completedProgress.has(continuation.progress)) {
        return Effect.fail(
          runnerError({
            operation: 'recover-cycle',
            failure: 'contract',
            message: `autonomous cycle pass repeated ${continuation.progress} after durable progress`,
          }),
        )
      }
      return continueAutonomousCyclePass(context, new Set([...completedProgress, continuation.progress]), progressKey)
    }),
  )

export const runAutonomousCycleUntilSettled = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> =>
  continueAutonomousCyclePass(context, new Set())
