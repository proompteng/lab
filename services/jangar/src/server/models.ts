import { Effect } from 'effect'
import { loadChatConfig } from './chat-config'

export const listModels = Effect.gen(function* () {
  const config = yield* loadChatConfig
  const now = Math.floor(Date.now() / 1000)
  return {
    object: 'list' as const,
    data: config.models.map((id) => ({
      id,
      object: 'model' as const,
      owned_by: 'jangar',
      created: now,
      permission: [],
      root: id,
      parent: null,
    })),
  }
})
