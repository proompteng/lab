import { AsyncLocalStorage } from 'node:async_hooks'
import { Effect } from 'effect'

import type { LogFields, Logger, LogLevel } from '../observability/logger'
import type { WorkflowInfo } from './context'
import type { DeterminismGuard } from './determinism'

export type WorkflowLogger = Logger

export type WorkflowLogContext = {
  readonly info: WorkflowInfo
  readonly guard: DeterminismGuard
  readonly logger: WorkflowLogger
}

const workflowLogStorage = new AsyncLocalStorage<WorkflowLogContext>()

export const runWithWorkflowLogContext = async <T>(context: WorkflowLogContext, fn: () => Promise<T> | T): Promise<T> =>
  await workflowLogStorage.run(context, async () => await fn())

export const currentWorkflowLogContext = (): WorkflowLogContext | undefined => workflowLogStorage.getStore()

export const runOutsideWorkflowLogContext = <T>(fn: () => T): T => workflowLogStorage.exit(fn)

const requireWorkflowLogContext = (): WorkflowLogContext => {
  const context = currentWorkflowLogContext()
  if (!context) {
    throw new Error('Workflow log context unavailable')
  }
  return context
}

const baseFieldsForInfo = (info: WorkflowInfo): LogFields => ({
  namespace: info.namespace,
  taskQueue: info.taskQueue,
  workflowId: info.workflowId,
  runId: info.runId,
  workflowType: info.workflowType,
  sdkComponent: 'workflow',
})

const emitLog = (level: LogLevel, message: string, fields?: LogFields): void => {
  const context = requireWorkflowLogContext()
  if (!context.guard.recordLog()) {
    return
  }
  const baseFields = baseFieldsForInfo(context.info)
  const mergedFields = fields ? { ...fields, ...baseFields } : baseFields
  runOutsideWorkflowLogContext(() => {
    void Effect.runPromise(context.logger.log(level, message, mergedFields))
  })
}

export const log = {
  debug: (message: string, fields?: LogFields) => emitLog('debug', message, fields),
  info: (message: string, fields?: LogFields) => emitLog('info', message, fields),
  warn: (message: string, fields?: LogFields) => emitLog('warn', message, fields),
  error: (message: string, fields?: LogFields) => emitLog('error', message, fields),
}
