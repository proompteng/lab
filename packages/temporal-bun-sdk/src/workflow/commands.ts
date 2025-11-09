import { create } from '@bufbuild/protobuf'
import { durationFromMillis } from '../common/duration'
import type { DataConverter } from '../common/payloads'
import { encodeValuesToPayloads } from '../common/payloads/converter'
import {
  type Command,
  CommandSchema,
  ContinueAsNewWorkflowExecutionCommandAttributesSchema,
  ScheduleActivityTaskCommandAttributesSchema,
  SignalExternalWorkflowExecutionCommandAttributesSchema,
  StartChildWorkflowExecutionCommandAttributesSchema,
  StartTimerCommandAttributesSchema,
} from '../proto/temporal/api/command/v1/message_pb'
import {
  type ActivityType,
  ActivityTypeSchema,
  type Header,
  type Memo,
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
import type { WorkflowCommandIntentId } from './context'
import type { WorkflowRetryPolicyInput } from './determinism'

export type WorkflowCommandKind =
  | 'schedule-activity'
  | 'start-timer'
  | 'start-child-workflow'
  | 'signal-external-workflow'
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
  | StartChildWorkflowCommandIntent
  | SignalExternalWorkflowCommandIntent
  | ContinueAsNewWorkflowCommandIntent

export interface WorkflowCommandMaterializationOptions {
  readonly dataConverter: DataConverter
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
      case 'start-child-workflow': {
        commands.push(await buildStartChildWorkflowCommand(intent, options))
        break
      }
      case 'signal-external-workflow': {
        commands.push(await buildSignalExternalWorkflowCommand(intent, options))
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
  const payloads = await encodeValuesToPayloads(options.dataConverter, intent.input)

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

const buildStartChildWorkflowCommand = async (
  intent: StartChildWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = await encodeValuesToPayloads(options.dataConverter, intent.input)

  const attributes = create(StartChildWorkflowExecutionCommandAttributesSchema, {
    namespace: intent.namespace,
    workflowId: intent.workflowId,
    workflowType: buildWorkflowType(intent.workflowType),
    taskQueue: create(TaskQueueSchema, { name: intent.taskQueue }),
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
  const payloads = await encodeValuesToPayloads(options.dataConverter, intent.input)

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

const buildContinueAsNewCommand = async (
  intent: ContinueAsNewWorkflowCommandIntent,
  options: WorkflowCommandMaterializationOptions,
): Promise<Command> => {
  const payloads = await encodeValuesToPayloads(options.dataConverter, intent.input)

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

export { durationFromMillis }
