import { setTimeout as sleep } from 'node:timers/promises'
import type { ActivityContext } from '../../src/worker'
import { withHeartbeat } from '../../src/internal/heartbeat'

export interface SlowGreetInput {
  name: string
  delayMs?: number
}

const BASE_DELAY_MS = 3000
const HEARTBEAT_INTERVAL_MS = 500

const slowGreetHandler = async (context: ActivityContext, input: SlowGreetInput): Promise<string> => {
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? BASE_DELAY_MS))
  const start = Date.now()
  const deadline = start + delayMs

  while (Date.now() < deadline) {
    await context.throwIfCancelled()
    const remaining = Math.max(0, deadline - Date.now())
    await sleep(Math.min(HEARTBEAT_INTERVAL_MS, remaining))
  }

  return `Hello, ${input.name}!`
}

export const slowGreet = withHeartbeat(slowGreetHandler, {
  everyMs: HEARTBEAT_INTERVAL_MS,
  detailsProvider: (input: SlowGreetInput) => ({ message: `Greeting ${input.name}` }),
})
