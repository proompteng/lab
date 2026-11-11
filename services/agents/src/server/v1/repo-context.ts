import { parseRepoContextInput, type AgentsFetch } from '@proompteng/agent-contracts'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { createPostgresMemoriesStore, type MemoriesStore } from '../memory-notes-store'
import { retrieveRepoContext } from '../repo-context'

export const postRepoContextHandler = async (
  request: Request,
  dependencies: { storeFactory?: () => MemoriesStore; fetch?: AgentsFetch } = {},
) => {
  let payload: Record<string, unknown>
  try {
    payload = await parseJsonBody(request)
  } catch {
    return errorResponse('invalid JSON body', 400)
  }
  const parsed = parseRepoContextInput(payload)
  if (!parsed.ok) return errorResponse(parsed.message, 400)
  let store: MemoriesStore | undefined
  try {
    const retrieve: MemoriesStore['retrieve'] = async (input) => {
      store = (dependencies.storeFactory ?? createPostgresMemoriesStore)()
      return store.retrieve(input)
    }
    return okResponse(
      await retrieveRepoContext(parsed.value, { retrieve }, { fetch: dependencies.fetch, signal: request.signal }),
    )
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error), 500)
  } finally {
    await store?.close()
  }
}
