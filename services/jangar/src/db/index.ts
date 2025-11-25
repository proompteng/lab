import { ConvexHttpClient } from 'convex/browser'
import type {
  AppendMessageInput,
  ChatMessage,
  ChatSession,
  CreateWorkOrderInput,
  WorkOrder,
  WorkOrderStatus,
} from '../types/persistence'

export interface DbClient {
  createWorkOrder: (input: CreateWorkOrderInput) => Promise<string>
  updateWorkOrderStatus: (id: string, status: WorkOrderStatus) => Promise<void>
  updateWorkOrderResult: (id: string, prUrl?: string) => Promise<void>
  listWorkOrders: (sessionId: string) => Promise<WorkOrder[]>
  getWorkOrder: (id: string) => Promise<WorkOrder | null>
  appendMessage: (input: AppendMessageInput) => Promise<string>
  listMessages: (sessionId: string) => Promise<ChatMessage[]>
  createSession: (userId: string, title: string) => Promise<string>
  updateSessionLastMessage: (sessionId: string, at: number) => Promise<void>
  getSession: (sessionId: string) => Promise<ChatSession | null>
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

export const createDbClient = async (): Promise<DbClient> => {
  const convex = getClient()

  const mutate = (name: string, args: Record<string, unknown>) => convex.mutation(name as never, args as never)
  const query = async <T>(name: string, args: Record<string, unknown>) =>
    (await convex.query(name as never, args as never)) as T

  const now = () => Date.now()

  const createSession = async (userId: string, title: string) => {
    const createdAt = now()
    return mutate('chat:createSession', { userId, title, createdAt }) as unknown as Promise<string>
  }

  const updateSessionLastMessage = async (sessionId: string, at: number) => {
    await mutate('chat:updateLastMessage', { sessionId, at })
  }

  const getSession = async (sessionId: string) => query<ChatSession | null>('chat:getSession', { sessionId })

  const appendMessage = async (input: AppendMessageInput) => {
    const createdAt = now()
    return mutate('chat:appendMessage', { ...input, createdAt }) as unknown as Promise<string>
  }

  const listMessages = async (sessionId: string) => query<ChatMessage[]>('chat:listMessages', { sessionId })

  const createWorkOrder = async (input: CreateWorkOrderInput) => {
    const createdAt = now()
    return mutate('workOrders:create', {
      ...input,
      status: input.status ?? 'submitted',
      createdAt,
    }) as unknown as Promise<string>
  }

  const updateWorkOrderStatus = async (id: string, status: WorkOrderStatus) => {
    await mutate('workOrders:updateStatus', { workOrderId: id, status, at: now() })
  }

  const updateWorkOrderResult = async (id: string, prUrl?: string) => {
    await mutate('workOrders:updateResult', { workOrderId: id, prUrl, updatedAt: now() })
  }

  const listWorkOrders = async (sessionId: string) => query<WorkOrder[]>('workOrders:listBySession', { sessionId })

  const getWorkOrder = async (id: string) => query<WorkOrder | null>('workOrders:get', { workOrderId: id })

  return {
    createWorkOrder,
    updateWorkOrderStatus,
    updateWorkOrderResult,
    listWorkOrders,
    getWorkOrder,
    appendMessage,
    listMessages,
    createSession,
    updateSessionLastMessage,
    getSession,
  }
}
