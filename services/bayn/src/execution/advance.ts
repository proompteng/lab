import { Cause, Data, Effect, Exit } from 'effect'

import { CycleState } from '../cycle/model'
import type { CycleRunnerError } from '../cycle/runner'
import type { CycleRunResult } from '../cycle/runner/model'
import { canonicalHashV1Result } from '../hash'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { ExecutionStageTimings, type ExecutionStageTiming, withObservedSpan } from '../telemetry'
import { operationCurrentTimeMillis } from '../operation-timeout'

interface AdvancePass {
  readonly observation: AutonomousCyclePassObservation
  readonly result?: CycleRunResult
  readonly nextDelayMs?: number
  readonly nextWakeAt?: string
}

export interface AdvanceExecutionCommand {
  readonly controllerKey: string
  readonly epoch: number
  readonly sequence: number
  readonly issuedAt: string
  readonly sourceRevision: string
}

export type ExecutionBlocker =
  | { readonly _tag: 'CycleBlocked' }
  | {
      readonly _tag: 'PassFailure'
      readonly operation: CycleRunnerError['operation']
      readonly failure: CycleRunnerError['failure']
    }

export type AdvanceOutcome = { readonly nextWakeAt?: string } & (
  | {
      readonly _tag: 'Completed'
      readonly receiptHash: string
      readonly nextDelayMs: number
      readonly observation: AutonomousCyclePassObservation
    }
  | {
      readonly _tag: 'Waiting'
      readonly reason: { readonly _tag: 'WindowClosed' | 'RecoveryWaiting' }
      readonly receiptHash: string
      readonly nextDelayMs: number
      readonly observation: AutonomousCyclePassObservation
    }
  | {
      readonly _tag: 'Blocked'
      readonly reason: ExecutionBlocker
      readonly receiptHash: string
      readonly nextDelayMs: number
      readonly observation: AutonomousCyclePassObservation
    }
)

export class TransientExecutionFailure extends Data.TaggedError('TransientExecutionFailure')<{
  readonly operation: 'advance' | 'receipt-hash'
  readonly message: string
  readonly cause: unknown
}> {}

type UnhashedAdvanceOutcome =
  | { readonly _tag: 'Completed' }
  | { readonly _tag: 'Waiting'; readonly reason: { readonly _tag: 'WindowClosed' | 'RecoveryWaiting' } }
  | { readonly _tag: 'Blocked'; readonly reason: ExecutionBlocker }

const classifyAdvance = ({ observation, result }: AdvancePass): UnhashedAdvanceOutcome => {
  if (observation.result === 'FAILURE') {
    return {
      _tag: 'Blocked',
      reason: {
        _tag: 'PassFailure',
        operation: observation.operation,
        failure: observation.failure,
      },
    }
  }
  if (observation.outcome === 'WINDOW_CLOSED') {
    return { _tag: 'Waiting', reason: { _tag: 'WindowClosed' } }
  }
  if (
    observation.outcome === 'WAITING' ||
    (result?.outcome === 'RECOVERED' && result.action === 'WAITING') ||
    observation.recoveryAction === 'WAITING'
  ) {
    return { _tag: 'Waiting', reason: { _tag: 'RecoveryWaiting' } }
  }
  if ((result?.outcome === 'RECOVERED' && result.action === 'BLOCKED') || observation.recoveryAction === 'BLOCKED') {
    return { _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } }
  }
  if (result?.outcome === 'ALREADY_TERMINAL' && result.cycle.state === CycleState.Blocked) {
    return { _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } }
  }
  return { _tag: 'Completed' }
}

const hashOutcome = (
  command: AdvanceExecutionCommand,
  outcome: UnhashedAdvanceOutcome,
  advance: AdvancePass,
  nextDelayMs: number,
): Effect.Effect<string, TransientExecutionFailure> => {
  const { observation, result } = advance
  const material = {
    schemaVersion:
      observation.jevObservationReferences === undefined
        ? 'bayn.execution-advance-receipt.v1'
        : 'bayn.execution-advance-receipt.v2',
    ...(observation.jevObservationReferences === undefined
      ? {}
      : { jevObservationReferences: observation.jevObservationReferences }),
    controllerKey: command.controllerKey,
    epoch: command.epoch,
    sequence: command.sequence,
    issuedAt: command.issuedAt,
    sourceRevision: command.sourceRevision,
    outcome: outcome._tag,
    blocker: outcome._tag === 'Blocked' ? outcome.reason : null,
    ...(outcome._tag === 'Waiting' ? { waiting: outcome.reason } : {}),
    observation:
      observation.result === 'SUCCESS'
        ? {
            result: observation.result,
            outcome: observation.outcome,
            observedAt: observation.observedAt,
            ...(observation.recoveryAction === undefined ? {} : { recoveryAction: observation.recoveryAction }),
            ...(observation.waitReason === undefined ? {} : { waitReason: observation.waitReason }),
            ...(observation.readiness === undefined ? {} : { readiness: observation.readiness }),
          }
        : {
            result: observation.result,
            operation: observation.operation,
            failure: observation.failure,
            observedAt: observation.observedAt,
          },
    cycleResult:
      result === undefined
        ? null
        : {
            outcome: result.outcome,
            ...(result.outcome === 'RECOVERED' ? { action: result.action } : {}),
          },
    nextDelayMs,
    ...(advance.nextWakeAt === undefined ? {} : { nextWakeAt: advance.nextWakeAt }),
  }
  return Effect.fromResult(canonicalHashV1Result(material)).pipe(
    Effect.mapError(
      (cause) =>
        new TransientExecutionFailure({
          operation: 'receipt-hash',
          message: 'execution advance receipt could not be canonically hashed',
          cause,
        }),
    ),
  )
}

export const advanceExecutionOnce = <R>(
  command: AdvanceExecutionCommand,
  driver: {
    readonly advance: Effect.Effect<AdvancePass, CycleRunnerError, R>
    readonly nextDelayMs: number
  },
): Effect.Effect<AdvanceOutcome, TransientExecutionFailure, R> =>
  Effect.gen(function* () {
    const startedAt = yield* operationCurrentTimeMillis
    const stageTimings = new Map<string, ExecutionStageTiming>()
    return yield* driver.advance.pipe(
      Effect.mapError(
        (cause) =>
          new TransientExecutionFailure({
            operation: 'advance',
            message: 'execution advance did not complete within its bounded interpreter',
            cause,
          }),
      ),
      Effect.flatMap((advance) => {
        const outcome = classifyAdvance(advance)
        const nextDelayMs = advance.nextDelayMs ?? driver.nextDelayMs
        return hashOutcome(command, outcome, advance, nextDelayMs).pipe(
          Effect.map(
            (receiptHash): AdvanceOutcome => ({
              ...outcome,
              receiptHash,
              nextDelayMs,
              ...(advance.nextWakeAt === undefined ? {} : { nextWakeAt: advance.nextWakeAt }),
              observation:
                advance.observation.result === 'SUCCESS' && advance.nextWakeAt !== undefined
                  ? { ...advance.observation, nextWakeAt: advance.nextWakeAt }
                  : advance.observation,
            }),
          ),
        )
      }),
      Effect.onExit((exit) =>
        operationCurrentTimeMillis.pipe(
          Effect.flatMap((finishedAt) => {
            const elapsedMs = Math.max(0, finishedAt - startedAt)
            const outcome = Exit.isSuccess(exit)
              ? exit.value._tag
              : Cause.hasInterruptsOnly(exit.cause)
                ? 'Interrupted'
                : 'Failed'
            const log = Exit.isSuccess(exit)
              ? Effect.logInfo('Bayn execution advance completed')
              : Effect.logWarning('Bayn execution advance did not complete', exit.cause)
            return Effect.annotateCurrentSpan({
              'bayn.execution.elapsed_ms': elapsedMs,
              'bayn.execution.outcome': outcome,
            }).pipe(
              Effect.andThen(
                log.pipe(
                  Effect.annotateLogs({
                    outcome,
                    elapsedMs,
                    stageTimings: [...stageTimings.values()],
                    ...(Exit.isSuccess(exit)
                      ? {
                          receiptHash: exit.value.receiptHash,
                          nextDelayMs: exit.value.nextDelayMs,
                          ...(exit.value._tag === 'Completed' ? {} : { reason: exit.value.reason }),
                          ...(exit.value.observation.result === 'SUCCESS' &&
                          exit.value.observation.waitReason !== undefined
                            ? { waitReason: exit.value.observation.waitReason }
                            : {}),
                        }
                      : {}),
                  }),
                ),
              ),
            )
          }),
        ),
      ),
      Effect.provideService(ExecutionStageTimings, stageTimings),
    )
  }).pipe(
    Effect.annotateLogs({
      controllerKey: command.controllerKey,
      epoch: command.epoch,
      sequence: command.sequence,
      sourceRevision: command.sourceRevision,
    }),
    withObservedSpan('bayn.execution.advance', {
      'bayn.component': 'execution',
      'bayn.controller.key': command.controllerKey,
      'bayn.controller.epoch': command.epoch,
      'bayn.controller.sequence': command.sequence,
      'bayn.source.revision': command.sourceRevision,
    }),
  )
