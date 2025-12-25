import { create } from '@bufbuild/protobuf'
import { durationFromMillis } from '../common/duration'
import type { DataConverter } from '../common/payloads'
import { encodeValuesToPayloads } from '../common/payloads/converter'
import {
  CancelTimerCommandAttributesSchema,
  CancelWorkflowExecutionCommandAttributesSchema,
  type Command,
  CommandSchema,
  ContinueAsNewWorkflowExecutionCommandAttributesSchema,
  ModifyWorkflowPropertiesCommandAttributesSchema,
  RecordMarkerCommandAttributesSchema,
  RequestCancelActivityTaskCommandAttributesSchema,
  RequestCancelExternalWorkflowExecutionCommandAttributesSchema,
  ScheduleActivityTaskCommandAttributesSchema,
  SignalExternalWorkflowExecutionCommandAttributesSchema,
  StartChildWorkflowExecutionCommandAttributesSchema,
  StartTimerCommandAttributesSchema,
  UpsertWorkflowSearchAttributesCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import {
  type ActivityType,
  ActivityTypeSchema,
  type Header,
  type Memo,
  type Payload,
  type Payloads,
  PayloadsSchema,
  type RetryPolicy,
  RetryPolicySchema,
  type SearchAttributes,
  WorkflowExecutionSchema,
  type WorkflowType,
  WorkflowTypeSchema,
} from '../proto/temporal/api/common/v1/message_pb'
import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import { TaskQueueSchema } from '../proto/temporal/api/taskqueue/v1/message_pb'
import type { WorkflowCommandIntentId, WorkflowInfo } from './context'
import type { WorkflowRetryPolicyInput } from './determinism'

export type WorkflowCommandKind =
  | 'schedule-activity'
  | 'start-timer'
  | 'start-child-workflow'
  | 'request-cancel-activity'
  | 'cancel-timer'
  | 'signal-external-workflow'
  | 'request-cancel-external-workflow'
  | 'cancel-workflow'
  | 'record-marker'
  | 'upsert-search-attributes'
  | 'modify-workflow-properties'
  | 'continue-as-new'

export interface WorkflowCommandIntentBase {
  readonly id: WorkflowCommandIntentId
  readonly kind: WorkflowCommandKind
  readonly sequence: number
}

export interface ScheduleActivityCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'schedule-activity'
  readonly activityType: string
  readonly activityId: string
  readonly taskQueue: string
  readonly input: unknown[]
  readonly header?: Header
  readonly timeouts: {
    readonly scheduleToCloseTimeoutMs?: number
    readonly scheduleToStartTimeoutMs?: number
    readonly startToCloseTimeoutMs?: number
    readonly heartbeatTimeoutMs?: number
  }
  readonly retry?: WorkflowRetryPolicyInput
  readonly requestEagerExecution?: boolean
}

export interface StartTimerCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'start-timer'
  readonly timerId: string
  readonly timeoutMs: number
}

export interface RequestCancelActivityCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'request-cancel-activity'
  readonly activityId: string
  readonly scheduledEventId?: string
}

export interface CancelTimerCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'cancel-timer'
  readonly timerId: string
  readonly startedEventId?: string
}

export interface StartChildWorkflowCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'start-child-workflow'
  readonly workflowType: string
  readonly workflowId: string
  readonly namespace: string
  readonly taskQueue: string
  readonly input: unknown[]
  readonly timeouts: {
    readonly workflowExecutionTimeoutMs?: number
    readonly workflowRunTimeoutMs?: number
    readonly workflowTaskTimeoutMs?: number
  }
  readonly parentClosePolicy?: number
  readonly workflowIdReusePolicy?: number
  readonly retry?: WorkflowRetryPolicyInput
  readonly cronSchedule?: string
  readonly header?: Header
  readonly memo?: Memo
  readonly searchAttributes?: SearchAttributes
}

export interface SignalExternalWorkflowCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'signal-external-workflow'
  readonly namespace: string
  readonly workflowId: string
  readonly runId?: string
  readonly signalName: string
  readonly input: unknown[]
  readonly childWorkflowOnly: boolean
  readonly header?: Header
}

export interface RequestCancelExternalWorkflowCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'request-cancel-external-workflow'
  readonly namespace: string
  readonly workflowId: string
  readonly runId?: string
  readonly childWorkflowOnly: boolean
  readonly reason?: string
}

export interface CancelWorkflowCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'cancel-workflow'
  readonly details?: unknown[]
}

export interface RecordMarkerCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'record-marker'
  readonly markerName: string
  readonly details?: Record<string, unknown>
  readonly header?: Header
}

export interface UpsertSearchAttributesCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'upsert-search-attributes'
  readonly searchAttributes: Record<string, unknown>
}

export interface ModifyWorkflowPropertiesCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'modify-workflow-properties'
  readonly memo?: Record<string, unknown>
}

export interface ContinueAsNewWorkflowCommandIntent extends WorkflowCommandIntentBase {
  readonly kind: 'continue-as-new'
  readonly workflowType: string
  readonly taskQueue: string
  readonly input: unknown[]
  readonly timeouts: {
    readonly workflowRunTimeoutMs?: number
    readonly workflowTaskTimeoutMs?: number
  }
  readonly backoffStartIntervalMs?: number
  readonly retry?: WorkflowRetryPolicyInput
  readonly memo?: Memo
  readonly searchAttributes?: SearchAttributes
  readonly header?: Header
  readonly cronSchedule?: string
}

export type WorkflowCommandIntent =
  | ScheduleActivityCommandIntent
  | StartTimerCommandIntent
  | RequestCancelActivityCommandIntent
  | CancelTimerCommandIntent
  | StartChildWorkflowCommandIntent
  | SignalExternalWorkflowCommandIntent
  | RequestCancelExternalWorkflowCommandIntent
  | CancelWorkflowCommandIntent
  | RecordMarkerCommandIntent
  | UpsertSearchAttributesCommandIntent
  | ModifyWorkflowPropertiesCommandIntent
  | ContinueAsNewWorkflowCommandIntent

export interface WorkflowCommandMaterializationOptions {
  readonly dataConverter: DataConverter
  readonly workflowInfo?: WorkflowInfo
}

export const materializeCommands = async (
  intents: readonly WorkflowCommandIntent[],
  options: WorkflowCommandMaterializationOptions,
): Promise<Command[]> => {
  const commands: Command[] = []

  for (const intent of intents) {
    switch (intent.kind) {
      case 'schedule-activity': {
        commands.push(await buildScheduleActivityCommand(intent, options))
        break
      }
      case 'start-timer': {
        commands.push(buildStartTimerCommand(intent))
        break
      }
      case 'request-cancel-activity': {
        commands.push(buildRequestCancelActivityCommand(intent))
        break
      }
      case 'cancel-timer': {
        commands.push(buildCancelTimerCommand(intent))
        break
      }
      case 'start-child-workflow': {
        commands.push(await buildStartChildWorkflowCommand(intent, options))
        break
      }
      case 'signal-external-workflow': {
        commands.push(await buildSignalExternalWorkflowCommand(intent, options))
        break
      }
      case 'request-cancel-external-workflow': {
        commands.push(buildRequestCancelExternalWorkflowCommand(intent))
        break
      }
      case 'cancel-workflow': {
        commands.push(await buildCancelWorkflowCommand(intent, options))
        break
      }
      case 'record-marker': {
        commands.push(await buildRecordMarkerCommand(intent, options))
        break
      }
      case 'upsert-search-attributes': {
        commands.push(await buildUpsertSearchAttributesCommand(intent, options))
        break
      }
      case 'modify-workflow-properties': {
        commands.push(await buildModifyWorkflowPropertiesCommand(intent, options))
        break
      }
      case 'continue-as-new': {
        commands.push(await buildContinueAsNewCommand(intent, options))
        break
      }
      default: {
        // Exhaustive check
        const exhaustive: never = intent
        throw new Error(`Unsupported workflow command intent: ${(exhaustive as WorkflowCommandIntent).kind}`)
      }
    }
  }

  return commands
}

const buildScheduleActivityCommand = async (
  intent: ScheduleActivityCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = (await encodeValuesToPayloads(options.dataConverter, intent.input)) ?? []

  const attributes = create(ScheduleActivityTaskCommandAttributesSchema, {
    activityId: intent.activityId,
    activityType: buildActivityType(intent.activityType),
    taskQueue: create(TaskQueueSchema, { name: intent.taskQueue }),
    input: payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    scheduleToCloseTimeout: durationFromMillis(intent.timeouts.scheduleToCloseTimeoutMs),
    scheduleToStartTimeout: durationFromMillis(intent.timeouts.scheduleToStartTimeoutMs),
    startToCloseTimeout: durationFromMillis(intent.timeouts.startToCloseTimeoutMs),
    heartbeatTimeout: durationFromMillis(intent.timeouts.heartbeatTimeoutMs),
    retryPolicy: intent.retry ? buildRetryPolicy(intent.retry) : undefined,
    requestEagerExecution: intent.requestEagerExecution ?? false,
    header: intent.header,
  })

  return create(CommandSchema, {
    commandType: CommandType.SCHEDULE_ACTIVITY_TASK,
    attributes: {
      case: 'scheduleActivityTaskCommandAttributes',
      value: attributes,
    },
  })
}

const buildStartTimerCommand = (intent: StartTimerCommandIntent): Command => {
  const attributes = create(StartTimerCommandAttributesSchema, {
    timerId: intent.timerId,
    startToFireTimeout: durationFromMillis(intent.timeoutMs),
  })

  return create(CommandSchema, {
    commandType: CommandType.START_TIMER,
    attributes: {
      case: 'startTimerCommandAttributes',
      value: attributes,
    },
  })
}

const buildRequestCancelActivityCommand = (intent: RequestCancelActivityCommandIntent): Command => {
  const attributes = create(RequestCancelActivityTaskCommandAttributesSchema, {
    scheduledEventId: intent.scheduledEventId ? BigInt(intent.scheduledEventId) : 0n,
  })

  return create(CommandSchema, {
    commandType: CommandType.REQUEST_CANCEL_ACTIVITY_TASK,
    attributes: {
      case: 'requestCancelActivityTaskCommandAttributes',
      value: attributes,
    },
  })
}

const buildCancelTimerCommand = (intent: CancelTimerCommandIntent): Command => {
  const attributes = create(CancelTimerCommandAttributesSchema, {
    timerId: intent.timerId,
  })

  return create(CommandSchema, {
    commandType: CommandType.CANCEL_TIMER,
    attributes: {
      case: 'cancelTimerCommandAttributes',
      value: attributes,
    },
  })
}

const buildStartChildWorkflowCommand = async (
  intent: StartChildWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = (await encodeValuesToPayloads(options.dataConverter, intent.input)) ?? []
  const namespace =
    options.workflowInfo && intent.namespace === options.workflowInfo.namespace ? undefined : intent.namespace
  const taskQueue =
    options.workflowInfo && intent.taskQueue === options.workflowInfo.taskQueue ? undefined : intent.taskQueue

  const attributes = create(StartChildWorkflowExecutionCommandAttributesSchema, {
    workflowId: intent.workflowId,
    workflowType: buildWorkflowType(intent.workflowType),
    ...(taskQueue ? { taskQueue: create(TaskQueueSchema, { name: taskQueue }) } : {}),
    ...(namespace ? { namespace } : {}),
    input: payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    workflowExecutionTimeout: durationFromMillis(intent.timeouts.workflowExecutionTimeoutMs),
    workflowRunTimeout: durationFromMillis(intent.timeouts.workflowRunTimeoutMs),
    workflowTaskTimeout: durationFromMillis(intent.timeouts.workflowTaskTimeoutMs),
    parentClosePolicy: intent.parentClosePolicy ?? 0,
    workflowIdReusePolicy: intent.workflowIdReusePolicy ?? 0,
    retryPolicy: intent.retry ? buildRetryPolicy(intent.retry) : undefined,
    cronSchedule: intent.cronSchedule ?? '',
    header: intent.header,
    memo: intent.memo,
    searchAttributes: intent.searchAttributes,
  })

  return create(CommandSchema, {
    commandType: CommandType.START_CHILD_WORKFLOW_EXECUTION,
    attributes: {
      case: 'startChildWorkflowExecutionCommandAttributes',
      value: attributes,
    },
  })
}

const buildSignalExternalWorkflowCommand = async (
  intent: SignalExternalWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = (await encodeValuesToPayloads(options.dataConverter, intent.input)) ?? []

  const execution = create(WorkflowExecutionSchema, {
    workflowId: intent.workflowId,
    runId: intent.runId ?? '',
  })

  const attributes = create(SignalExternalWorkflowExecutionCommandAttributesSchema, {
    namespace: intent.namespace,
    execution,
    signalName: intent.signalName,
    input: payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    control: '',
    childWorkflowOnly: intent.childWorkflowOnly,
    header: intent.header,
  })

  return create(CommandSchema, {
    commandType: CommandType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION,
    attributes: {
      case: 'signalExternalWorkflowExecutionCommandAttributes',
      value: attributes,
    },
  })
}

const buildRequestCancelExternalWorkflowCommand = (intent: RequestCancelExternalWorkflowCommandIntent): Command => {
  const attributes = create(RequestCancelExternalWorkflowExecutionCommandAttributesSchema, {
    namespace: intent.namespace,
    workflowId: intent.workflowId,
    runId: intent.runId ?? '',
    control: '',
    childWorkflowOnly: intent.childWorkflowOnly,
    reason: intent.reason ?? '',
  })

  return create(CommandSchema, {
    commandType: CommandType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION,
    attributes: {
      case: 'requestCancelExternalWorkflowExecutionCommandAttributes',
      value: attributes,
    },
  })
}

const buildCancelWorkflowCommand = async (
  intent: CancelWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = (await encodeValuesToPayloads(options.dataConverter, intent.details ?? [])) ?? []
  const detailsPayloads = payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined
  const attributes = create(CancelWorkflowExecutionCommandAttributesSchema, {
    details: detailsPayloads,
  })

  return create(CommandSchema, {
    commandType: CommandType.CANCEL_WORKFLOW_EXECUTION,
    attributes: {
      case: 'cancelWorkflowExecutionCommandAttributes',
      value: attributes,
    },
  })
}

const buildContinueAsNewCommand = async (
  intent: ContinueAsNewWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = (await encodeValuesToPayloads(options.dataConverter, intent.input)) ?? []

  const attributes = create(ContinueAsNewWorkflowExecutionCommandAttributesSchema, {
    workflowType: buildWorkflowType(intent.workflowType),
    taskQueue: create(TaskQueueSchema, { name: intent.taskQueue }),
    input: payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    workflowRunTimeout: durationFromMillis(intent.timeouts.workflowRunTimeoutMs),
    workflowTaskTimeout: durationFromMillis(intent.timeouts.workflowTaskTimeoutMs),
    backoffStartInterval: durationFromMillis(intent.backoffStartIntervalMs),
    retryPolicy: intent.retry ? buildRetryPolicy(intent.retry) : undefined,
    cronSchedule: intent.cronSchedule ?? '',
    header: intent.header,
    memo: intent.memo,
    searchAttributes: intent.searchAttributes,
  })

  return create(CommandSchema, {
    commandType: CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
    attributes: {
      case: 'continueAsNewWorkflowExecutionCommandAttributes',
      value: attributes,
    },
  })
}

const buildRecordMarkerCommand = async (
  intent: RecordMarkerCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const details: Record<string, Payloads> = {}

  if (intent.details) {
    for (const [key, value] of Object.entries(intent.details)) {
      const payloads = await encodeValuesToPayloads(options.dataConverter, [value])
      if (payloads && payloads.length > 0) {
        details[key] = create(PayloadsSchema, { payloads })
      }
    }
  }

  const attributes = create(RecordMarkerCommandAttributesSchema, {
    markerName: intent.markerName,
    details,
    header: intent.header,
  })

  return create(CommandSchema, {
    commandType: CommandType.RECORD_MARKER,
    attributes: {
      case: 'recordMarkerCommandAttributes',
      value: attributes,
    },
  })
}

const buildUpsertSearchAttributesCommand = async (
  intent: UpsertSearchAttributesCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const searchAttributes: Record<string, Payload> = {}

  for (const [key, raw] of Object.entries(intent.searchAttributes)) {
    if (raw === undefined) {
      continue
    }
    const payloads = await encodeValuesToPayloads(options.dataConverter, [raw])
    const payload = payloads?.[0]
    if (payload) {
      searchAttributes[key] = payload
    }
  }

  const attributes = create(UpsertWorkflowSearchAttributesCommandAttributesSchema, {
    searchAttributes: Object.keys(searchAttributes).length > 0 ? { indexedFields: searchAttributes } : undefined,
  })

  return create(CommandSchema, {
    commandType: CommandType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES,
    attributes: {
      case: 'upsertWorkflowSearchAttributesCommandAttributes',
      value: attributes,
    },
  })
}

const buildModifyWorkflowPropertiesCommand = async (
  intent: ModifyWorkflowPropertiesCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const memoFields: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(intent.memo ?? {})) {
    memoFields[key] = value ?? undefined
  }

  const encodedMemo: Record<string, Payload> = {}
  for (const [key, value] of Object.entries(memoFields)) {
    const payloads = await encodeValuesToPayloads(options.dataConverter, [value])
    if (payloads && payloads.length > 0 && payloads[0]) {
      encodedMemo[key] = payloads[0]
    }
  }

  const attributes = create(ModifyWorkflowPropertiesCommandAttributesSchema, {
    upsertedMemo: Object.keys(encodedMemo).length > 0 ? { fields: encodedMemo } : undefined,
  })

  return create(CommandSchema, {
    commandType: CommandType.MODIFY_WORKFLOW_PROPERTIES,
    attributes: {
      case: 'modifyWorkflowPropertiesCommandAttributes',
      value: attributes,
    },
  })
}

const buildRetryPolicy = (input: WorkflowRetryPolicyInput): RetryPolicy =>
  create(RetryPolicySchema, {
    initialInterval: durationFromMillis(input.initialIntervalMs),
    backoffCoefficient: input.backoffCoefficient ?? 2,
    maximumInterval: durationFromMillis(input.maximumIntervalMs),
    maximumAttempts: input.maximumAttempts ?? 0,
    nonRetryableErrorTypes: input.nonRetryableErrorTypes ?? [],
  })

const buildActivityType = (name: string): ActivityType => create(ActivityTypeSchema, { name })

const buildWorkflowType = (name: string): WorkflowType => create(WorkflowTypeSchema, { name })
