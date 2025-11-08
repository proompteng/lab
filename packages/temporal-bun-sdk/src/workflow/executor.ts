import { create } from '@bufbuild/protobuf'
import { Effect, Exit } from 'effect'
import * as Cause from 'effect/Cause'
import * as Chunk from 'effect/Chunk'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { DataConverter } from '../common/payloads'
import { encodeValuesToPayloads } from '../common/payloads/converter'
import { encodeErrorToFailure, encodeFailurePayloads } from '../common/payloads/failure'
import {
  type Command,
  CommandSchema,
  CompleteWorkflowExecutionCommandAttributesSchema,
  FailWorkflowExecutionCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import { PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import { materializeCommands, type WorkflowCommandIntent } from './commands'
import {
  createWorkflowContext,
  type ActivityResolution,
  type WorkflowCommandContext,
  type WorkflowInfo,
} from './context'
import { DeterminismGuard, snapshotToDeterminismState, type WorkflowDeterminismState } from './determinism'
import { ContinueAsNewWorkflowError, WorkflowBlockedError, WorkflowNondeterminismError } from './errors'
import type { WorkflowRegistry } from './registry'

export interface ExecuteWorkflowInput {
  readonly workflowType: string
  readonly workflowId: string
  readonly runId: string
  readonly namespace: string
  readonly taskQueue: string
  readonly arguments: unknown
  readonly determinismState?: WorkflowDeterminismState
  readonly activityResults?: Map<string, ActivityResolution>
}

export type WorkflowCompletionStatus = 'completed' | 'failed' | 'continued-as-new' | 'pending'

export interface WorkflowExecutionOutput {
  readonly commands: Command[]
  readonly intents: readonly WorkflowCommandIntent[]
  readonly determinismState: WorkflowDeterminismState
  readonly completion: WorkflowCompletionStatus
  readonly result?: unknown
  readonly failure?: unknown
}

export interface WorkflowExecutorOptions {
  registry: WorkflowRegistry
  dataConverter: DataConverter
}

export class WorkflowExecutor {
  #registry: WorkflowRegistry
  #dataConverter: DataConverter

  constructor(options: WorkflowExecutorOptions) {
    this.#registry = options.registry
    this.#dataConverter = options.dataConverter
  }

  async execute(input: ExecuteWorkflowInput): Promise<WorkflowExecutionOutput> {
    const info: WorkflowInfo = {
      namespace: input.namespace,
      taskQueue: input.taskQueue,
      workflowId: input.workflowId,
      runId: input.runId,
      workflowType: input.workflowType,
    }

    const definition = this.#registry.get(input.workflowType)
    const normalizedArguments = this.#normalizeArguments(input.arguments, definition.decodeArgumentsAsArray)
    const decodedEffect = Schema.decodeUnknown(definition.schema)(normalizedArguments)
    const guard = new DeterminismGuard({ previousState: input.determinismState })

    let lastCommandContext: WorkflowCommandContext | undefined

    const workflowEffect = Effect.flatMap(decodedEffect, (parsed) => {
      const created = createWorkflowContext({
        input: parsed,
        info,
        determinismGuard: guard,
        activityResults: input.activityResults,
      })
      lastCommandContext = created.commandContext
      return Effect.flatMap(definition.handler(created.context), (result) =>
        Effect.sync(() => ({ result, commandContext: created.commandContext })),
      )
    })

    const exit = await Effect.runPromiseExit(workflowEffect)
    const rawSnapshot = guard.snapshot
    const determinismState = snapshotToDeterminismState(rawSnapshot)

    if (Exit.isSuccess(exit)) {
      const commands = await this.#buildSuccessCommands(exit.value.commandContext, exit.value.result)
      return {
        commands,
        intents: exit.value.commandContext.intents,
        determinismState,
        completion: 'completed',
        result: exit.value.result,
      }
    }

    const error = this.#resolveError(exit.cause)

    const continueAsNewError = unwrapWorkflowError(error, ContinueAsNewWorkflowError)
    if (continueAsNewError) {
      const intents = rawSnapshot.commandHistory.map((entry) => entry.intent)
      const commands = await materializeCommands(intents, { dataConverter: this.#dataConverter })
      return {
        commands,
        intents,
        determinismState,
        completion: 'continued-as-new',
      }
    }

    const nondeterminismError = unwrapWorkflowError(error, WorkflowNondeterminismError)
    if (nondeterminismError) {
      throw nondeterminismError
    }

    const blockedError = unwrapWorkflowError(error, WorkflowBlockedError)
    if (blockedError) {
      const contextForPending =
        lastCommandContext ??
        (() => {
          throw new Error('Workflow pending without command context')
        })()
      const pendingCommands = await materializeCommands(contextForPending.intents, {
        dataConverter: this.#dataConverter,
      })
      return {
        commands: pendingCommands,
        intents: contextForPending.intents,
        determinismState,
        completion: 'pending',
      }
    }

    const failureCommands = await this.#buildFailureCommands(error)
    return {
      commands: failureCommands,
      intents: [],
      determinismState,
      completion: 'failed',
      failure: error,
    }
  }

  #resolveError(cause: Cause.Cause<unknown> | undefined): unknown {
    if (cause === undefined) {
      return new Error('Workflow failed')
    }
    const failure = Cause.failureOption(cause)
    if (Option.isSome(failure)) {
      return failure.value
    }
    const defects = Cause.defects(cause)
    if (Chunk.isNonEmpty(defects)) {
      return Chunk.unsafeHead(defects)
    }
    return new Error(Cause.pretty(cause))
  }

  async #buildSuccessCommands(
    commandContext: { intents: readonly WorkflowCommandIntent[] },
    result: unknown,
  ): Promise<Command[]> {
    const commandIntents = commandContext.intents
    const materialized = await materializeCommands(commandIntents, { dataConverter: this.#dataConverter })
    const completionCommands = await this.#buildCompleteCommands(result)
    return [...materialized, ...completionCommands]
  }

  async #buildCompleteCommands(result: unknown): Promise<Command[]> {
    const payloads = await encodeValuesToPayloads(this.#dataConverter, result === undefined ? [] : [result])
    const completionAttributes = create(CompleteWorkflowExecutionCommandAttributesSchema, {
      result: payloads && payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    })

    return [
      create(CommandSchema, {
        commandType: CommandType.COMPLETE_WORKFLOW_EXECUTION,
        attributes: {
          case: 'completeWorkflowExecutionCommandAttributes',
          value: completionAttributes,
        },
      }),
    ]
  }

  async #buildFailureCommands(cause: unknown): Promise<Command[]> {
    const failure = await encodeErrorToFailure(this.#dataConverter, cause)
    const encoded = await encodeFailurePayloads(this.#dataConverter, failure)

    const failAttributes = create(FailWorkflowExecutionCommandAttributesSchema, {
      failure: encoded,
    })

    return [
      create(CommandSchema, {
        commandType: CommandType.FAIL_WORKFLOW_EXECUTION,
        attributes: {
          case: 'failWorkflowExecutionCommandAttributes',
          value: failAttributes,
        },
      }),
    ]
  }

  #normalizeArguments(raw: unknown, expectArray: boolean): unknown {
    if (expectArray) {
      return raw ?? []
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        return undefined
      }
      if (raw.length === 1) {
        return raw[0]
      }
    }
    return raw
  }
}

const unwrapWorkflowError = <T>(error: unknown, ctor: new (...args: any[]) => T): T | undefined => {
  if (error instanceof ctor) {
    return error
  }
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof ctor) {
      return cause
    }
  }
  return undefined
}
