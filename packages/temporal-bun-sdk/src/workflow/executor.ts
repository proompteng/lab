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
import { materializeCommands, type StartChildWorkflowCommandIntent, type WorkflowCommandIntent } from './commands'
import {
  type ActivityResolution,
  createWorkflowContext,
  type NexusOperationResolution,
  type WorkflowCommandContext,
  type WorkflowContext,
  type WorkflowInfo,
  type WorkflowQueryRegistry,
  type WorkflowUpdateRegistry,
} from './context'
import { DeterminismGuard, snapshotToDeterminismState, type WorkflowDeterminismState } from './determinism'
import {
  ContinueAsNewWorkflowError,
  WorkflowBlockedError,
  WorkflowNondeterminismError,
  WorkflowQueryViolationError,
} from './errors'
import type { WorkflowQueryRequest, WorkflowSignalDeliveryInput } from './inbound'
import { runWithWorkflowLogContext, type WorkflowLogContext, type WorkflowLogger } from './log'
import type { WorkflowRegistry } from './registry'

const noopWorkflowLogger: WorkflowLogger = {
  log: () => Effect.void,
}

export interface WorkflowUpdateInvocation {
  readonly protocolInstanceId: string
  readonly requestMessageId: string
  readonly updateId: string
  readonly name: string
  readonly payload: unknown
  readonly identity?: string
  readonly sequencingEventId?: string
}

export type WorkflowUpdateDispatch =
  | {
      readonly type: 'acceptance'
      readonly protocolInstanceId: string
      readonly requestMessageId: string
      readonly updateId: string
      readonly handlerName: string
      readonly identity?: string
      readonly sequencingEventId?: string
    }
  | {
      readonly type: 'rejection'
      readonly protocolInstanceId: string
      readonly requestMessageId: string
      readonly updateId: string
      readonly reason: string
      readonly failure?: unknown
      readonly sequencingEventId?: string
    }
  | {
      readonly type: 'completion'
      readonly protocolInstanceId: string
      readonly updateId: string
      readonly status: 'success'
      readonly result?: unknown
      readonly handlerName: string
      readonly identity?: string
    }
  | {
      readonly type: 'completion'
      readonly protocolInstanceId: string
      readonly updateId: string
      readonly status: 'failure'
      readonly failure: unknown
      readonly handlerName: string
      readonly identity?: string
    }

export interface ExecuteWorkflowInput {
  readonly workflowType: string
  readonly workflowId: string
  readonly runId: string
  readonly namespace: string
  readonly taskQueue: string
  readonly arguments: unknown
  readonly determinismState?: WorkflowDeterminismState
  readonly activityResults?: Map<string, ActivityResolution>
  readonly activityScheduleEventIds?: Map<string, string>
  readonly nexusResults?: Map<string, NexusOperationResolution>
  readonly nexusScheduleEventIds?: Map<string, string>
  readonly pendingChildWorkflows?: ReadonlySet<string>
  readonly signalDeliveries?: readonly WorkflowSignalDeliveryInput[]
  readonly timerResults?: ReadonlySet<string>
  readonly queryRequests?: readonly WorkflowQueryRequest[]
  readonly updates?: readonly WorkflowUpdateInvocation[]
  readonly mode?: 'workflow' | 'query'
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
  readonly updateDispatches?: readonly WorkflowUpdateDispatch[]
}

export interface WorkflowQueryEvaluationResult {
  readonly request: WorkflowQueryRequest
  readonly result: WorkflowQueryResult
}

export interface WorkflowExecutorOptions {
  registry: WorkflowRegistry
  dataConverter: DataConverter
  logger?: WorkflowLogger
}

export class WorkflowExecutor {
  #registry: WorkflowRegistry
  #dataConverter: DataConverter
  #logger: WorkflowLogger

  constructor(options: WorkflowExecutorOptions) {
    this.#registry = options.registry
    this.#dataConverter = options.dataConverter
    this.#logger = options.logger ?? noopWorkflowLogger
  }

  async execute(input: ExecuteWorkflowInput): Promise<WorkflowExecutionOutput> {
    const info: WorkflowInfo = {
      namespace: input.namespace,
      taskQueue: input.taskQueue,
      workflowId: input.workflowId,
      runId: input.runId,
      workflowType: input.workflowType,
    }

    const executionMode = input.mode ?? 'workflow'

    const definition = this.#registry.get(input.workflowType)
    const normalizedArguments = this.#normalizeArguments(input.arguments, definition.decodeArgumentsAsArray)
    const decodedEffect = Schema.decodeUnknown(definition.schema)(normalizedArguments)
    const guard = new DeterminismGuard({ previousState: input.determinismState, mode: executionMode })
    const logContext: WorkflowLogContext = {
      info,
      guard,
      logger: this.#logger,
    }

    let lastCommandContext: WorkflowCommandContext | undefined
    let lastQueryRegistry: WorkflowQueryRegistry | undefined
    let lastWorkflowContext: WorkflowContext<unknown> | undefined
    let lastUpdateRegistry: WorkflowUpdateRegistry | undefined
    let blockedFromUpdates: WorkflowBlockedError | undefined

    const workflowEffect = Effect.flatMap(decodedEffect, (parsed) => {
      const created = createWorkflowContext({
        input: parsed,
        info,
        determinismGuard: guard,
        activityResults: input.activityResults,
        activityScheduleEventIds: input.activityScheduleEventIds,
        nexusResults: input.nexusResults,
        nexusScheduleEventIds: input.nexusScheduleEventIds,
        signalDeliveries: input.signalDeliveries,
        timerResults: input.timerResults,
        updates: definition.updates,
      })
      lastCommandContext = created.commandContext
      lastQueryRegistry = created.queryRegistry
      lastWorkflowContext = created.context
      lastUpdateRegistry = created.updateRegistry
      return Effect.flatMap(definition.handler(created.context), (result) =>
        Effect.sync(() => ({
          result,
          context: created.context,
          commandContext: created.commandContext,
          updateRegistry: created.updateRegistry,
        })),
      )
    })

    const exit = await runWithWorkflowLogContext(logContext, async () => await Effect.runPromiseExit(workflowEffect))
    const updatesToProcess = input.updates ?? []
    let updateDispatches: WorkflowUpdateDispatch[] = []

    if (updatesToProcess.length > 0) {
      const contextForUpdates = Exit.isSuccess(exit) ? exit.value.context : lastWorkflowContext
      const registryForUpdates = Exit.isSuccess(exit) ? exit.value.updateRegistry : lastUpdateRegistry
      if (!contextForUpdates || !registryForUpdates) {
        throw new Error('Workflow update context unavailable after execution')
      }
      try {
        updateDispatches = await runWithWorkflowLogContext(
          logContext,
          async () =>
            await this.#processWorkflowUpdates({
              context: contextForUpdates,
              registry: registryForUpdates,
              updates: updatesToProcess,
              guard,
            }),
        )
      } catch (error) {
        if (error instanceof WorkflowBlockedError) {
          blockedFromUpdates = error
        } else {
          throw error
        }
      }
    }

    const queryResults = await runWithWorkflowLogContext(
      logContext,
      async () => await this.#evaluateQueryRequests(lastQueryRegistry, input.queryRequests),
    )

    if (executionMode !== 'query') {
      guard.assertReplayComplete()
    }

    if (Exit.isSuccess(exit)) {
      const determinismState = snapshotToDeterminismState(guard.snapshot)
      if (executionMode === 'query') {
        return {
          commands: [],
          intents: [],
          determinismState,
          completion: 'completed',
          result: exit.value.result,
          queryResults,
        }
      }

      const pendingChildStarts = this.#resolvePendingChildStarts(
        input.pendingChildWorkflows,
        exit.value.commandContext.intents,
      )
      if (pendingChildStarts.size > 0) {
        const commands = await materializeCommands(exit.value.commandContext.intents, {
          dataConverter: this.#dataConverter,
          workflowInfo: info,
        })
        return {
          commands,
          intents: exit.value.commandContext.intents,
          determinismState,
          completion: 'pending',
          queryResults,
          ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
        }
      }

      const commands = await this.#buildSuccessCommands(exit.value.commandContext, exit.value.result, info)
      return {
        commands,
        intents: exit.value.commandContext.intents,
        determinismState,
        completion: 'completed',
        result: exit.value.result,
        queryResults,
        ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
      }
    }

    const error = this.#resolveError(exit.cause)

    const continueAsNewError = unwrapWorkflowError(error, ContinueAsNewWorkflowError)
    if (continueAsNewError) {
      if (executionMode === 'query') {
        throw new WorkflowQueryViolationError('Workflow query cannot request continue-as-new')
      }
      const rawSnapshot = guard.snapshot
      const continueContext = lastCommandContext
      const intents = continueContext?.intents ?? rawSnapshot.commandHistory.map((entry) => entry.intent)
      const pendingChildStarts = this.#resolvePendingChildStarts(input.pendingChildWorkflows, intents)
      if (pendingChildStarts.size > 0) {
        const filteredIntents = intents.filter((intent) => intent.kind !== 'continue-as-new')
        const commands = await materializeCommands(filteredIntents, {
          dataConverter: this.#dataConverter,
          workflowInfo: info,
        })
        const determinismState = filterDeterminismState(
          snapshotToDeterminismState(rawSnapshot),
          (intent) => intent.kind !== 'continue-as-new',
        )
        return {
          commands,
          intents: filteredIntents,
          determinismState,
          completion: 'pending',
          queryResults,
          ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
        }
      }

      const commands = await materializeCommands(intents, { dataConverter: this.#dataConverter, workflowInfo: info })
      return {
        commands,
        intents,
        determinismState: snapshotToDeterminismState(rawSnapshot),
        completion: 'continued-as-new',
        queryResults,
        ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
      }
    }

    const nondeterminismError = unwrapWorkflowError(error, WorkflowNondeterminismError)
    if (nondeterminismError) {
      throw nondeterminismError
    }

    const blockedError = unwrapWorkflowError(error, WorkflowBlockedError) ?? blockedFromUpdates
    if (blockedError) {
      const contextForPending =
        lastCommandContext ??
        (() => {
          throw new Error('Workflow pending without command context')
        })()
      const pendingCommands = await materializeCommands(contextForPending.intents, {
        dataConverter: this.#dataConverter,
        workflowInfo: info,
      })
      if (executionMode === 'query') {
        return {
          commands: [],
          intents: contextForPending.intents,
          determinismState: snapshotToDeterminismState(guard.snapshot),
          completion: 'pending',
          queryResults,
          ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
        }
      }
      return {
        commands: pendingCommands,
        intents: contextForPending.intents,
        determinismState: snapshotToDeterminismState(guard.snapshot),
        completion: 'pending',
        queryResults,
        ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
      }
    }

    if (executionMode === 'query') {
      return {
        commands: [],
        intents: [],
        determinismState: snapshotToDeterminismState(guard.snapshot),
        completion: 'failed',
        failure: error,
        queryResults,
      }
    }

    const failureCommands = await this.#buildFailureCommands(error)
    return {
      commands: failureCommands,
      intents: [],
      determinismState: snapshotToDeterminismState(guard.snapshot),
      completion: 'failed',
      failure: error,
      queryResults,
      ...(updateDispatches.length > 0 ? { updateDispatches } : {}),
    }
  }

  async #processWorkflowUpdates({
    context,
    registry,
    updates,
    guard,
  }: {
    context: WorkflowContext<unknown>
    registry: WorkflowUpdateRegistry
    updates: readonly WorkflowUpdateInvocation[]
    guard: DeterminismGuard
  }): Promise<WorkflowUpdateDispatch[]> {
    if (!updates.length) {
      return []
    }

    const dispatches: WorkflowUpdateDispatch[] = []

    for (const invocation of updates) {
      const messageId = invocation.requestMessageId
      guard.recordUpdate({
        updateId: invocation.updateId,
        stage: 'admitted',
        handlerName: invocation.name,
        identity: invocation.identity,
        messageId,
      })

      const registered = registry.get(invocation.name) ?? registry.getDefault()
      if (!registered) {
        const failure = new Error(`Workflow update handler "${invocation.name}" was not found`)
        dispatches.push({
          type: 'rejection',
          protocolInstanceId: invocation.protocolInstanceId,
          requestMessageId: invocation.requestMessageId,
          updateId: invocation.updateId,
          reason: 'handler-not-found',
          failure,
          sequencingEventId: invocation.sequencingEventId,
        })
        guard.recordUpdate({
          updateId: invocation.updateId,
          stage: 'rejected',
          handlerName: invocation.name,
          identity: invocation.identity,
          failureMessage: failure.message,
          messageId,
        })
        continue
      }

      let decodedInput: unknown
      try {
        decodedInput = await Effect.runPromise(Schema.decodeUnknown(registered.input)(invocation.payload))
      } catch (error) {
        const failure = this.#normalizeUpdateError(error)
        dispatches.push({
          type: 'rejection',
          protocolInstanceId: invocation.protocolInstanceId,
          requestMessageId: invocation.requestMessageId,
          updateId: invocation.updateId,
          reason: 'invalid-input',
          failure,
          sequencingEventId: invocation.sequencingEventId,
        })
        guard.recordUpdate({
          updateId: invocation.updateId,
          stage: 'rejected',
          handlerName: registered.name,
          identity: invocation.identity,
          failureMessage: failure.message,
          messageId,
        })
        continue
      }

      if (registered.validator) {
        try {
          registered.validator(decodedInput as never)
        } catch (error) {
          const failure = this.#normalizeUpdateError(error)
          dispatches.push({
            type: 'rejection',
            protocolInstanceId: invocation.protocolInstanceId,
            requestMessageId: invocation.requestMessageId,
            updateId: invocation.updateId,
            reason: 'validation-failed',
            failure,
            sequencingEventId: invocation.sequencingEventId,
          })
          guard.recordUpdate({
            updateId: invocation.updateId,
            stage: 'rejected',
            handlerName: registered.name,
            identity: invocation.identity,
            failureMessage: failure.message,
            messageId,
          })
          continue
        }
      }

      dispatches.push({
        type: 'acceptance',
        protocolInstanceId: invocation.protocolInstanceId,
        requestMessageId: invocation.requestMessageId,
        updateId: invocation.updateId,
        handlerName: registered.name,
        identity: invocation.identity,
        sequencingEventId: invocation.sequencingEventId,
      })
      guard.recordUpdate({
        updateId: invocation.updateId,
        stage: 'accepted',
        handlerName: registered.name,
        identity: invocation.identity,
        sequencingEventId: invocation.sequencingEventId,
        messageId,
      })

      const priorCompletion = guard.getUpdateCompletion(invocation.updateId)
      if (priorCompletion) {
        // Re-run the handler to rebuild workflow state during replay, but avoid emitting duplicate protocol messages.
        await Effect.runPromiseExit(registered.handler(context as never, decodedInput as never))
        guard.recordUpdate(priorCompletion)
        continue
      }

      const executionExit = await Effect.runPromiseExit(registered.handler(context as never, decodedInput as never))
      if (Exit.isSuccess(executionExit)) {
        dispatches.push({
          type: 'completion',
          protocolInstanceId: invocation.protocolInstanceId,
          updateId: invocation.updateId,
          status: 'success',
          result: executionExit.value,
          handlerName: registered.name,
          identity: invocation.identity,
        })
        guard.recordUpdate({
          updateId: invocation.updateId,
          stage: 'completed',
          handlerName: registered.name,
          identity: invocation.identity,
          outcome: 'success',
          messageId,
        })
      } else {
        const failure = this.#resolveError(executionExit.cause)
        if (failure instanceof WorkflowBlockedError) {
          continue
        }
        dispatches.push({
          type: 'completion',
          protocolInstanceId: invocation.protocolInstanceId,
          updateId: invocation.updateId,
          status: 'failure',
          failure,
          handlerName: registered.name,
          identity: invocation.identity,
        })
        guard.recordUpdate({
          updateId: invocation.updateId,
          stage: 'completed',
          handlerName: registered.name,
          identity: invocation.identity,
          outcome: 'failure',
          failureMessage: failure instanceof Error ? failure.message : String(failure),
          messageId,
        })
      }
    }

    return dispatches
  }

  #normalizeUpdateError(error: unknown): Error {
    if (error instanceof Error) {
      return error
    }
    if (typeof error === 'string') {
      return new Error(error)
    }
    return new Error('Workflow update failed validation')
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
    workflowInfo: WorkflowInfo,
  ): Promise<Command[]> {
    const commandIntents = commandContext.intents
    const materialized = await materializeCommands(commandIntents, {
      dataConverter: this.#dataConverter,
      workflowInfo,
    })
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
    if (process.env.CODEX_DEBUG_QUERY_REGISTRY === '1') {
      console.log(
        'query registry handlers',
        registry.list().map((handler) => handler.handle.name),
        'requests',
        requests.map((request) => request.name),
      )
    }
    const results: WorkflowQueryEvaluationResult[] = []
    for (const request of requests) {
      const evaluation = await Effect.runPromise(registry.evaluate(request))
      const encoded =
        evaluation.status === 'success'
          ? await this.#encodeSuccessfulQueryResult(evaluation.result)
          : await this.#encodeFailedQueryResult(evaluation.error)
      results.push({ request: evaluation.request, result: encoded })
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

  #resolvePendingChildStarts(
    pendingFromHistory: ReadonlySet<string> | undefined,
    intents: readonly WorkflowCommandIntent[],
  ): Set<string> {
    const pending = new Set(pendingFromHistory ?? [])
    for (const intent of intents) {
      if (intent.kind !== 'start-child-workflow') {
        continue
      }
      pending.add((intent as StartChildWorkflowCommandIntent).workflowId)
    }
    return pending
  }
}

const filterDeterminismState = (
  state: WorkflowDeterminismState,
  predicate: (intent: WorkflowCommandIntent) => boolean,
): WorkflowDeterminismState => ({
  ...state,
  commandHistory: state.commandHistory.filter((entry) => predicate(entry.intent)),
})

const unwrapWorkflowError = <T>(error: unknown, ctor: unknown): T | undefined => {
  if (typeof ctor !== 'function') {
    return undefined
  }
  const ctorFn = ctor as new (...args: unknown[]) => T
  if (error instanceof ctorFn) {
    return error as T
  }
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof ctorFn) {
      return cause as T
    }
  }
  return undefined
}
