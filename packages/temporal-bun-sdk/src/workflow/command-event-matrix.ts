import { CommandType } from '../proto/temporal/api/enums/v1/command_type_pb'
import type { WorkflowCommandKind } from './commands'

export interface WorkflowCommandEventMatrixEntry {
  readonly kind: WorkflowCommandKind
  readonly commandType: CommandType
  readonly commandTypeName: keyof typeof CommandType
  readonly attributesCase: string
  readonly expectedHistoryEventFamilies: readonly string[]
  readonly failureOrCancellationFamilies: readonly string[]
}

export const workflowCommandKinds = [
  'schedule-activity',
  'schedule-nexus-operation',
  'start-timer',
  'request-cancel-activity',
  'request-cancel-nexus-operation',
  'cancel-timer',
  'start-child-workflow',
  'signal-external-workflow',
  'request-cancel-external-workflow',
  'cancel-workflow',
  'record-marker',
  'upsert-search-attributes',
  'modify-workflow-properties',
  'continue-as-new',
] as const satisfies readonly WorkflowCommandKind[]

export const workflowCommandEventMatrix: Record<WorkflowCommandKind, WorkflowCommandEventMatrixEntry> = {
  'schedule-activity': {
    kind: 'schedule-activity',
    commandType: CommandType.SCHEDULE_ACTIVITY_TASK,
    commandTypeName: 'SCHEDULE_ACTIVITY_TASK',
    attributesCase: 'scheduleActivityTaskCommandAttributes',
    expectedHistoryEventFamilies: ['ACTIVITY_TASK_SCHEDULED', 'ACTIVITY_TASK_STARTED', 'ACTIVITY_TASK_COMPLETED'],
    failureOrCancellationFamilies: [
      'ACTIVITY_TASK_FAILED',
      'ACTIVITY_TASK_TIMED_OUT',
      'ACTIVITY_TASK_CANCEL_REQUESTED',
      'ACTIVITY_TASK_CANCELED',
    ],
  },
  'schedule-nexus-operation': {
    kind: 'schedule-nexus-operation',
    commandType: CommandType.SCHEDULE_NEXUS_OPERATION,
    commandTypeName: 'SCHEDULE_NEXUS_OPERATION',
    attributesCase: 'scheduleNexusOperationCommandAttributes',
    expectedHistoryEventFamilies: ['NEXUS_OPERATION_SCHEDULED', 'NEXUS_OPERATION_COMPLETED'],
    failureOrCancellationFamilies: [
      'NEXUS_OPERATION_FAILED',
      'NEXUS_OPERATION_TIMED_OUT',
      'NEXUS_OPERATION_CANCEL_REQUESTED',
      'NEXUS_OPERATION_CANCELED',
    ],
  },
  'start-timer': {
    kind: 'start-timer',
    commandType: CommandType.START_TIMER,
    commandTypeName: 'START_TIMER',
    attributesCase: 'startTimerCommandAttributes',
    expectedHistoryEventFamilies: ['TIMER_STARTED', 'TIMER_FIRED'],
    failureOrCancellationFamilies: ['TIMER_CANCELED'],
  },
  'request-cancel-activity': {
    kind: 'request-cancel-activity',
    commandType: CommandType.REQUEST_CANCEL_ACTIVITY_TASK,
    commandTypeName: 'REQUEST_CANCEL_ACTIVITY_TASK',
    attributesCase: 'requestCancelActivityTaskCommandAttributes',
    expectedHistoryEventFamilies: ['ACTIVITY_TASK_CANCEL_REQUESTED', 'ACTIVITY_TASK_CANCELED'],
    failureOrCancellationFamilies: ['ACTIVITY_TASK_COMPLETED', 'ACTIVITY_TASK_FAILED', 'ACTIVITY_TASK_TIMED_OUT'],
  },
  'request-cancel-nexus-operation': {
    kind: 'request-cancel-nexus-operation',
    commandType: CommandType.REQUEST_CANCEL_NEXUS_OPERATION,
    commandTypeName: 'REQUEST_CANCEL_NEXUS_OPERATION',
    attributesCase: 'requestCancelNexusOperationCommandAttributes',
    expectedHistoryEventFamilies: ['NEXUS_OPERATION_CANCEL_REQUESTED', 'NEXUS_OPERATION_CANCELED'],
    failureOrCancellationFamilies: ['NEXUS_OPERATION_COMPLETED', 'NEXUS_OPERATION_FAILED', 'NEXUS_OPERATION_TIMED_OUT'],
  },
  'cancel-timer': {
    kind: 'cancel-timer',
    commandType: CommandType.CANCEL_TIMER,
    commandTypeName: 'CANCEL_TIMER',
    attributesCase: 'cancelTimerCommandAttributes',
    expectedHistoryEventFamilies: ['TIMER_CANCELED'],
    failureOrCancellationFamilies: ['TIMER_FIRED'],
  },
  'start-child-workflow': {
    kind: 'start-child-workflow',
    commandType: CommandType.START_CHILD_WORKFLOW_EXECUTION,
    commandTypeName: 'START_CHILD_WORKFLOW_EXECUTION',
    attributesCase: 'startChildWorkflowExecutionCommandAttributes',
    expectedHistoryEventFamilies: [
      'START_CHILD_WORKFLOW_EXECUTION_INITIATED',
      'CHILD_WORKFLOW_EXECUTION_STARTED',
      'CHILD_WORKFLOW_EXECUTION_COMPLETED',
    ],
    failureOrCancellationFamilies: [
      'START_CHILD_WORKFLOW_EXECUTION_FAILED',
      'CHILD_WORKFLOW_EXECUTION_FAILED',
      'CHILD_WORKFLOW_EXECUTION_TIMED_OUT',
      'CHILD_WORKFLOW_EXECUTION_CANCELED',
      'CHILD_WORKFLOW_EXECUTION_TERMINATED',
    ],
  },
  'signal-external-workflow': {
    kind: 'signal-external-workflow',
    commandType: CommandType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION,
    commandTypeName: 'SIGNAL_EXTERNAL_WORKFLOW_EXECUTION',
    attributesCase: 'signalExternalWorkflowExecutionCommandAttributes',
    expectedHistoryEventFamilies: [
      'SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED',
      'EXTERNAL_WORKFLOW_EXECUTION_SIGNALED',
    ],
    failureOrCancellationFamilies: ['SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_FAILED'],
  },
  'request-cancel-external-workflow': {
    kind: 'request-cancel-external-workflow',
    commandType: CommandType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION,
    commandTypeName: 'REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION',
    attributesCase: 'requestCancelExternalWorkflowExecutionCommandAttributes',
    expectedHistoryEventFamilies: [
      'REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED',
      'EXTERNAL_WORKFLOW_EXECUTION_CANCEL_REQUESTED',
    ],
    failureOrCancellationFamilies: ['REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_FAILED'],
  },
  'cancel-workflow': {
    kind: 'cancel-workflow',
    commandType: CommandType.CANCEL_WORKFLOW_EXECUTION,
    commandTypeName: 'CANCEL_WORKFLOW_EXECUTION',
    attributesCase: 'cancelWorkflowExecutionCommandAttributes',
    expectedHistoryEventFamilies: ['WORKFLOW_EXECUTION_CANCELED'],
    failureOrCancellationFamilies: [],
  },
  'record-marker': {
    kind: 'record-marker',
    commandType: CommandType.RECORD_MARKER,
    commandTypeName: 'RECORD_MARKER',
    attributesCase: 'recordMarkerCommandAttributes',
    expectedHistoryEventFamilies: ['MARKER_RECORDED'],
    failureOrCancellationFamilies: [],
  },
  'upsert-search-attributes': {
    kind: 'upsert-search-attributes',
    commandType: CommandType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES,
    commandTypeName: 'UPSERT_WORKFLOW_SEARCH_ATTRIBUTES',
    attributesCase: 'upsertWorkflowSearchAttributesCommandAttributes',
    expectedHistoryEventFamilies: ['UPSERT_WORKFLOW_SEARCH_ATTRIBUTES'],
    failureOrCancellationFamilies: [],
  },
  'modify-workflow-properties': {
    kind: 'modify-workflow-properties',
    commandType: CommandType.MODIFY_WORKFLOW_PROPERTIES,
    commandTypeName: 'MODIFY_WORKFLOW_PROPERTIES',
    attributesCase: 'modifyWorkflowPropertiesCommandAttributes',
    expectedHistoryEventFamilies: ['WORKFLOW_PROPERTIES_MODIFIED'],
    failureOrCancellationFamilies: [],
  },
  'continue-as-new': {
    kind: 'continue-as-new',
    commandType: CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
    commandTypeName: 'CONTINUE_AS_NEW_WORKFLOW_EXECUTION',
    attributesCase: 'continueAsNewWorkflowExecutionCommandAttributes',
    expectedHistoryEventFamilies: ['WORKFLOW_EXECUTION_CONTINUED_AS_NEW'],
    failureOrCancellationFamilies: ['WORKFLOW_TASK_FAILED'],
  },
}
