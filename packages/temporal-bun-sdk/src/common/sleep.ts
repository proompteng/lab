import { Effect } from 'effect'

export const sleep = (ms: number): Promise<void> => Effect.runPromise(Effect.sleep(ms))
