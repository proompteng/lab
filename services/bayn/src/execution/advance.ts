import { Data, Effect } from 'effect'

import type { CycleRunnerError } from '../cycle/runner'
import { CycleState } from '../cycle/model'
import type { CycleNotDueReason, CycleRunResult } from '../cycle/runner/model'
import { canonicalHashV1Result } from '../hash'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { withObservedSpan } from '../telemetry'

type AdvanceCycleResult =
  | Pick<Extract<CycleRunResult, { readonly outcome: 'RECOVERED' }>, 'outcome' | 'action'>
  | {
      readonly outcome: Extract<CycleRunResult, { readonly outcome: 'ACQUIRED' | 'REACQUIRED' | 'RESUMED' }>['outcome']
      readonly readiness: {
        readonly outcome: Extract<
          CycleRunResult,
          { readonly outcome: 'ACQUIRED' | 'REACQUIRED' | 'RESUMED' }
        >['readiness']['outcome']
      }
    }
  | {
      readonly outcome: 'ALREADY_TERMINAL'
      readonly cycle: Pick<Extract<CycleRunResult, { readonly outcome: 'ALREADY_TERMINAL' }>['cycle'], 'state'>
    }
  | {
      readonly outcome: Exclude<
        CycleRunResult['outcome'],
        'ACQUIRED' | 'ALREADY_TERMINAL' | 'REACQUIRED' | 'RECOVERED' | 'RESUMED'
      >
    }

interface AdvancePass {
  readonly observation: AutonomousCyclePassObservation
  readonly result?: AdvanceCycleResult
  readonly nextDelayMs?: number
}

export interface AdvanceExecutionCommand {
  readonly controllerKey: string
  readonly epoch: number
  readonly sequence: number
  readonly issuedAt: string
  readonly sourceRevision: string
}

export type ExecutionBlocker =
  | { readonly _tag: 'NoPublication' }
  | { readonly _tag: 'NotDue'; readonly reason?: CycleNotDueReason }
  | { readonly _tag: 'RecoveryWaiting' }
  | { readonly _tag: 'CycleBlocked' }
  | {
      readonly _tag: 'PassFailure'
      readonly operation: CycleRunnerError['operation']
      readonly failure: CycleRunnerError['failure']
    }

export type AdvanceOutcome =
  | {
      readonly _tag: 'Completed'
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

export class TransientExecutionFailure extends Data.TaggedError('TransientExecutionFailure')<{
  readonly operation: 'advance' | 'receipt-hash'
  readonly message: string
  readonly cause: unknown
}> {}

type UnhashedAdvanceOutcome =
  | { readonly _tag: 'Completed' }
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
  if (observation.outcome === 'NO_PUBLICATION') {
    return { _tag: 'Blocked', reason: { _tag: 'NoPublication' } }
  }
  if (observation.outcome === 'NOT_DUE') {
    return {
      _tag: 'Blocked',
      reason: {
        _tag: 'NotDue',
        ...(observation.notDueReason === undefined ? {} : { reason: observation.notDueReason }),
      },
    }
  }
  if (result?.outcome === 'RECOVERED' && result.action === 'WAITING') {
    return { _tag: 'Blocked', reason: { _tag: 'RecoveryWaiting' } }
  }
  if (result?.outcome === 'RECOVERED' && result.action === 'BLOCKED') {
    return { _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } }
  }
  if (result?.outcome === 'ALREADY_TERMINAL' && result.cycle.state === CycleState.Blocked) {
    return { _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } }
  }
  if (result !== undefined && 'readiness' in result && result.readiness.outcome === 'BLOCKED') {
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
    schemaVersion: 'bayn.execution-advance-receipt.v1',
    controllerKey: command.controllerKey,
    epoch: command.epoch,
    sequence: command.sequence,
    issuedAt: command.issuedAt,
    sourceRevision: command.sourceRevision,
    outcome: outcome._tag,
    blocker: outcome._tag === 'Blocked' ? outcome.reason : null,
    observation:
      observation.result === 'SUCCESS'
        ? {
            result: observation.result,
            outcome: observation.outcome,
            observedAt: observation.observedAt,
            ...(observation.notDueReason === undefined ? {} : { notDueReason: observation.notDueReason }),
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
            ...('readiness' in result ? { readinessOutcome: result.readiness.outcome } : {}),
          },
    nextDelayMs,
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
  driver.advance.pipe(
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
            observation: advance.observation,
          }),
        ),
      )
    }),
    Effect.tap((outcome) =>
      Effect.logInfo('Bayn execution advance completed').pipe(
        Effect.annotateLogs({
          controllerKey: command.controllerKey,
          epoch: command.epoch,
          sequence: command.sequence,
          sourceRevision: command.sourceRevision,
          outcome: outcome._tag,
          receiptHash: outcome.receiptHash,
        }),
      ),
    ),
    withObservedSpan('bayn.execution.advance', {
      'bayn.component': 'execution',
      'bayn.controller.key': command.controllerKey,
      'bayn.controller.epoch': command.epoch,
      'bayn.controller.sequence': command.sequence,
      'bayn.source.revision': command.sourceRevision,
    }),
  )
