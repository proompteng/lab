import { ConvexHttpClient } from 'convex/browser'
import type { OrchestrationState, TurnSnapshot, WorkerTaskResult } from '../types/orchestration'

export interface DbClient {
  upsertOrchestration: (state: OrchestrationState) => Promise<void>
  appendTurn: (orchestrationId: string, snapshot: TurnSnapshot) => Promise<void>
  appendWorkerResult: (orchestrationId: string, result: WorkerTaskResult) => Promise<void>
  getState: (orchestrationId: string) => Promise<OrchestrationState | null>
}

let client: ConvexHttpClient | null = null

const getEnv = () => {
  const convexUrl =
    Bun.env.CONVEX_URL ??
    Bun.env.CONVEX_DEPLOYMENT ??
    Bun.env.CONVEX_SITE_ORIGIN ??
    Bun.env.CONVEX_SELF_HOSTED_URL ??
    'http://127.0.0.1:3210'

  const adminKey = Bun.env.CONVEX_ADMIN_KEY ?? Bun.env.CONVEX_DEPLOY_KEY

  const skipUrlCheck = convexUrl.includes('127.0.0.1') || convexUrl.includes('/http') || convexUrl.startsWith('http://')

  return { convexUrl, adminKey, skipUrlCheck }
}

const getClient = () => {
  if (client) return client
  const { convexUrl, adminKey, skipUrlCheck } = getEnv()
  client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: skipUrlCheck })
  if (adminKey) {
    client.setAuth(adminKey)
  }
  return client
}

const toUnixMs = (iso: string) => new Date(iso).getTime()

export const createDbClient = async (): Promise<DbClient> => {
  const convex = getClient()

  const mutate = (name: string, args: Record<string, unknown>) => convex.mutation(name as never, args as never)
  const query = async <T>(name: string, args: Record<string, unknown>) =>
    (await convex.query(name as never, args as never)) as T

  const upsertOrchestration = async (state: OrchestrationState) => {
    await mutate('orchestrations:upsert', {
      state: {
        ...state,
        createdAt: toUnixMs(state.createdAt),
        updatedAt: toUnixMs(state.updatedAt),
      },
    })
  }

  const appendTurn = async (orchestrationId: string, snapshot: TurnSnapshot) => {
    await mutate('orchestrations:appendTurn', {
      orchestrationId,
      snapshot: {
        ...snapshot,
        createdAt: toUnixMs(snapshot.createdAt),
      },
    })
  }

  const appendWorkerResult = async (orchestrationId: string, result: WorkerTaskResult) => {
    await mutate('orchestrations:recordWorkerPr', { orchestrationId, result })
  }

  const getState = async (orchestrationId: string): Promise<OrchestrationState | null> => {
    type ConvexTurn = Omit<TurnSnapshot, 'createdAt'> & { createdAt: number }
    type ConvexState = Omit<OrchestrationState, 'turns' | 'createdAt' | 'updatedAt'> & {
      turns: ConvexTurn[]
      createdAt: number
      updatedAt: number
    }

    const response = await query<ConvexState | null>('orchestrations:getState', { orchestrationId })
    if (!response) {
      return null
    }
    return {
      ...response,
      turns: response.turns.map((turn) => ({
        ...turn,
        createdAt: new Date(turn.createdAt).toISOString(),
      })),
      createdAt: new Date(response.createdAt).toISOString(),
      updatedAt: new Date(response.updatedAt).toISOString(),
    }
  }

  return {
    upsertOrchestration,
    appendTurn,
    appendWorkerResult,
    getState,
  }
}
