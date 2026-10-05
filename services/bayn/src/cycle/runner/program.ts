import { Effect, Option, pipe } from 'effect'

import { BrokerRead } from '../../broker/alpaca'
import { Authority } from '../../execution/contracts'
import { currentUtcInstant } from '../../time'
import { CycleState, type AutonomousCycle } from '../model'
import { selectCycleRecovery, type CycleRecoverySelection, type CycleRecoveryState } from '../recovery'
import { CycleStore, type CycleDecisionBindingEvidence } from '../store'
import { isTerminalCycleState } from '../transitions'
import { canRearmUnboundPreSubmissionCycle } from './calendar-decisions'
import {
  calendarQueryFailureError,
  finishRecoveryResult,
  makeIntradayCycleDraft,
  marketCalendarQueryFromSession,
  nextIntradayEntryAttemptOrdinal,
  selectIntradayExecutionSession,
} from './decisions'
import { runnerError, type CycleRunContext, type CycleRunnerError, type CycleRunResult } from './model'
import { DecisionReadinessReason } from './readiness'

const currentIsoTime = currentUtcInstant

export const discoverAutonomousCyclePass = <R>(
  context: CycleRunContext<R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> => {
  const candidate =
    (context.strategyName === 'intraday-momentum' || context.strategyName === 'jev') &&
    context.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v3'
      ? {
          cycleBindingId: context.cycleBindingId,
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
    const firstAttemptDraft = yield* Effect.fromResult(
      makeIntradayCycleDraft(candidate, calendar.value, executionSession, 1),
    ).pipe(
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
        qualificationRunId: context.cycleBindingId,
        accountId: context.accountId,
        executionSessionDate: firstAttemptDraft.identity.executionSessionDate,
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
    let recoveredBlockedCycle = false
    if (
      Option.isSome(existing) &&
      existing.value.state === CycleState.Blocked &&
      context.authorityGenerationHash !== undefined
    ) {
      const prior = yield* store.readDecisionDocument(existing.value.identity.cycleId).pipe(
        Effect.mapError((cause) =>
          runnerError({
            operation: 'read-authority-slot',
            failure: 'store',
            message: 'blocked cycle authority binding read failed',
            cause,
          }),
        ),
      )
      recoveredBlockedCycle = Option.isNone(prior)
        ? canRearmUnboundPreSubmissionCycle(existing.value, candidate, calendar.value, executionSession)
        : prior.value.mode === Authority.Execution &&
          prior.value.contentHash === existing.value.bindings.decisionHash &&
          prior.value.bindings.authorityGenerationHash !== context.authorityGenerationHash
    }
    const entryAttemptOrdinal = Option.isSome(existing)
      ? nextIntradayEntryAttemptOrdinal(existing.value, observedAt, recoveredBlockedCycle)
      : 1
    if (Option.isSome(existing) && entryAttemptOrdinal === undefined) {
      return isTerminalCycleState(existing.value.state)
        ? ({ outcome: 'ALREADY_TERMINAL', observedAt, cycle: existing.value } as const)
        : ({ outcome: 'ALREADY_ACQUIRED', observedAt, cycle: existing.value } as const)
    }
    const draft =
      entryAttemptOrdinal === 1
        ? firstAttemptDraft
        : yield* Effect.fromResult(
            makeIntradayCycleDraft(candidate, calendar.value, executionSession, entryAttemptOrdinal),
          ).pipe(
            Effect.mapError((cause) =>
              runnerError({
                operation: 'build-cycle',
                failure: 'contract',
                message: 'intraday autonomous cycle rearm construction failed',
                cause,
              }),
            ),
          )
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
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | R> => {
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
        waitReason: 'AWAITING_SUBMISSION_OPEN',
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
                    readiness: cause.readiness ?? {
                      reason: DecisionReadinessReason.DecisionPending,
                      message: cause.message,
                    },
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
            (context.buildDecisionEvidence?.(document) ?? Effect.succeed<CycleDecisionBindingEvidence>({})).pipe(
              Effect.mapError((cause) =>
                runnerError({
                  operation: 'build-decision',
                  failure: cause.failure === 'not-ready' ? 'contract' : cause.failure,
                  message: cause.message,
                  cause,
                }),
              ),
              Effect.flatMap((evidence) =>
                pipe(
                  currentIsoTime,
                  Effect.flatMap((bindObservedAt) =>
                    pipe(
                      CycleStore,
                      Effect.flatMap((store) =>
                        store.bindDecision(selection.cycle.identity.cycleId, document, bindObservedAt, evidence),
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
                  cycleBindingId: context.cycleBindingId,
                  accountId: context.accountId,
                  strategyProtocolHash: context.strategyProtocolHash,
                  observedAt: decisionObservedAt,
                  cycle: selection.cycle,
                  decisionDocument: Option.getOrNull(document),
                }),
                Effect.flatMap((next) => recoverCycle(next, context)),
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
  cycle: AutonomousCycle | undefined,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | R> =>
  currentIsoTime.pipe(
    Effect.flatMap((observedAt) =>
      chooseRecovery({
        cycleBindingId: context.cycleBindingId,
        accountId: context.accountId,
        strategyProtocolHash: context.strategyProtocolHash,
        observedAt,
        cycle,
      }),
    ),
    Effect.flatMap((selection) => recoverCycle(selection, context)),
  )
