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
import { QueryResultType } from '../proto/temporal/api/enums/v1/query_pb'
import { type WorkflowQueryResult, WorkflowQueryResultSchema } from '../proto/temporal/api/query/v1/message_pb'
import { materializeCommands, type WorkflowCommandIntent } from './commands'
import {
  type ActivityResolution,
  createWorkflowContext,
  type WorkflowCommandContext,
  type WorkflowInfo,
  type WorkflowQueryRegistry,
} from './context'
import { DeterminismGuard, snapshotToDeterminismState, type WorkflowDeterminismState } from './determinism'
import { ContinueAsNewWorkflowError, WorkflowBlockedError, WorkflowNondeterminismError } from './errors'
import type { WorkflowQueryRequest, WorkflowSignalDeliveryInput } from './inbound'
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
  readonly signalDeliveries?: readonly WorkflowSignalDeliveryInput[]
  readonly queryRequests?: readonly WorkflowQueryRequest[]
}

export type WorkflowCompletionStatus = 'completed' | 'failed' | 'continued-as-new' | 'pending'

export interface WorkflowExecutionOutput {
  readonly commands: Command[]
  readonly intents: readonly WorkflowCommandIntent[]
  readonly determinismState: WorkflowDeterminismState
  readonly completion: WorkflowCompletionStatus
  readonly result?: unknown
  readonly failure?: unknown
  readonly queryResults: readonly WorkflowQueryEvaluationResult[]
}

export interface WorkflowQueryEvaluationResult {
  readonly request: WorkflowQueryRequest
  readonly result: WorkflowQueryResult
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
    let lastQueryRegistry: WorkflowQueryRegistry | undefined

    const workflowEffect = Effect.flatMap(decodedEffect, (parsed) => {
      const created = createWorkflowContext({
        input: parsed,
        info,
        determinismGuard: guard,
        activityResults: input.activityResults,
        signalDeliveries: input.signalDeliveries,
      })
      lastCommandContext = created.commandContext
      lastQueryRegistry = created.queryRegistry
      return Effect.flatMap(definition.handler(created.context), (result) =>
        Effect.sync(() => ({ result, commandContext: created.commandContext })),
      )
    })

    const exit = await Effect.runPromiseExit(workflowEffect)
    const rawSnapshot = guard.snapshot
    const determinismState = snapshotToDeterminismState(rawSnapshot)
    const queryResults = await this.#evaluateQueryRequests(lastQueryRegistry, input.queryRequests)

    if (Exit.isSuccess(exit)) {
      const commands = await this.#buildSuccessCommands(exit.value.commandContext, exit.value.result)
      return {
        commands,
        intents: exit.value.commandContext.intents,
        determinismState,
        completion: 'completed',
        result: exit.value.result,
        queryResults,
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
        queryResults,
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
        queryResults,
      }
    }

    const failureCommands = await this.#buildFailureCommands(error)
    return {
      commands: failureCommands,
      intents: [],
      determinismState,
      completion: 'failed',
      failure: error,
      queryResults,
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

  async #evaluateQueryRequests(
    registry: WorkflowQueryRegistry | undefined,
    requests: readonly WorkflowQueryRequest[] | undefined,
  ): Promise<WorkflowQueryEvaluationResult[]> {
    if (!requests || requests.length === 0) {
      return []
    }
    if (!registry) {
      throw new Error('Workflow query registry unavailable')
    }
    const results: WorkflowQueryEvaluationResult[] = []
    for (const request of requests) {
      // eslint-disable-next-line no-console
      console.info('[workflow-executor] evaluating query', request.name)
      const evaluation = await Effect.runPromise(registry.evaluate(request))
      const encoded =
        evaluation.status === 'success'
          ? await this.#encodeSuccessfulQueryResult(evaluation.result)
          : await this.#encodeFailedQueryResult(evaluation.error)
      results.push({ request: evaluation.request, result: encoded })
      // eslint-disable-next-line no-console
      console.info('[workflow-executor] query evaluation complete', {
        name: evaluation.request.name,
        source: evaluation.request.source,
        id: evaluation.request.id ?? null,
      })
    }
    return results
  }

  async #encodeSuccessfulQueryResult(value: unknown): Promise<WorkflowQueryResult> {
    const payloads = await encodeValuesToPayloads(this.#dataConverter, value === undefined ? [] : [value])
    const answer = payloads && payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined
    return create(WorkflowQueryResultSchema, {
      resultType: QueryResultType.ANSWERED,
      answer,
      errorMessage: '',
    })
  }

  async #encodeFailedQueryResult(error: unknown): Promise<WorkflowQueryResult> {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'Workflow query failed'))
    const failure = await encodeErrorToFailure(this.#dataConverter, normalized)
    return create(WorkflowQueryResultSchema, {
      resultType: QueryResultType.FAILED,
      errorMessage: normalized.message ?? 'Workflow query failed',
      failure,
    })
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

const unwrapWorkflowError = <T>(error: unknown, ctor: new (...args: unknown[]) => T): T | undefined => {
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
