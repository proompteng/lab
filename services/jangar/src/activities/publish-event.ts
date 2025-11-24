import type { PublishEventInput } from '../types/activities'

export const publishEventActivity = async (_input: PublishEventInput): Promise<void> => {
  // TODO(jng-030b): emit SSE/log events to subscribers
}
