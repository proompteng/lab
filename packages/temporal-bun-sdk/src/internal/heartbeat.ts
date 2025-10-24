import type { ActivityContext } from '../worker'

export interface HeartbeatOptions<TInput = unknown> {
  everyMs?: number
  detailsProvider?: (input: TInput) => unknown | Promise<unknown>
}

export const withHeartbeat = <TInput = unknown, TResult = unknown>(
  handler: (context: ActivityContext, input: TInput) => Promise<TResult>,
  options: HeartbeatOptions<TInput> = {},
): ((context: ActivityContext, input: TInput) => Promise<TResult>) => {
  const interval = Math.max(1, Math.floor(options.everyMs ?? 1000))

  return async (context, input) => {
    const stop = context.scheduleHeartbeat(interval, () => options.detailsProvider?.(input as TInput))
    try {
      return await handler(context, input as TInput)
    } finally {
      stop()
    }
  }
}
