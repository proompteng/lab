import { AsyncLocalStorage } from 'node:async_hooks'

export type ActivityInfo = {
  activityId: string
  activityType: string
  workflowNamespace: string
  workflowType: string
  workflowId: string
  runId: string
  taskQueue: string
  attempt: number
  isLocal: boolean
  heartbeatTimeoutMs?: number
  scheduleToCloseTimeoutMs?: number
  startToCloseTimeoutMs?: number
  scheduledTime?: Date
  startedTime?: Date
  currentAttemptScheduledTime?: Date
  lastHeartbeatDetails: unknown[]
}

export interface ActivityContext {
  readonly info: ActivityInfo
  readonly cancellationSignal: AbortSignal
  readonly isCancellationRequested: boolean
  heartbeat(...details: unknown[]): void
  throwIfCancelled(): void
}

const activityContextStorage = new AsyncLocalStorage<ActivityContext>()

export const runWithActivityContext = async <T>(context: ActivityContext, fn: () => Promise<T> | T): Promise<T> => {
  return await activityContextStorage.run(context, async () => await fn())
}

export const currentActivityContext = (): ActivityContext | undefined => {
  return activityContextStorage.getStore()
}
