import { ConvexHttpClient } from 'convex/browser'

type TokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

type PersistMeta = {
  threadId?: string
  turnId?: string
  tokenUsage?: TokenUsage | null
  reasoningSummary?: string[]
}

export interface DbClient {
  upsertConversation: (input: {
    conversationId: string
    threadId?: string
    modelProvider?: string
    clientName?: string
    at: number
  }) => Promise<string>
  upsertTurn: (input: {
    turnId: string
    conversationId: string
    chatId?: string
    userId?: string
    model?: string
    serviceTier?: string
    status: string
    error?: string
    path?: string
    turnNumber?: number
    startedAt: number
    endedAt?: number
  }) => Promise<string>
  appendMessage: (input: {
    turnId: string
    role: string
    content: string
    rawContent?: unknown
    createdAt: number
  }) => Promise<string>
  appendReasoning: (input: {
    turnId: string
    itemId: string
    summaryText?: string[]
    rawContent?: unknown
    position?: number
    createdAt: number
  }) => Promise<string>
  appendUsage: (input: {
    turnId: string
    totalInputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
    totalTokens?: number
    modelContextWindow?: number
    source?: string
    capturedAt: number
  }) => Promise<string>
  appendRateLimit: (input: {
    turnId: string
    scope: string
    usedPercent?: number
    windowMinutes?: number
    resetsAt?: number
    balance?: string
    unlimited?: boolean
    hasCredits?: boolean
    capturedAt: number
  }) => Promise<string>
  upsertCommand: (input: {
    callId: string
    turnId: string
    command: string[]
    cwd?: string
    source?: string
    parsedCmd?: unknown
    status?: string
    startedAt: number
    endedAt?: number
    exitCode?: number
    durationMs?: number
    stdout?: string
    stderr?: string
    aggregatedOutput?: string
    chunked: boolean
  }) => Promise<string>
  appendCommandChunk: (input: {
    callId: string
    stream: string
    seq: number
    chunkBase64: string
    encoding?: string
    createdAt: number
  }) => Promise<string>
  appendEvent: (input: {
    conversationId: string
    turnId?: string
    method: string
    payload: unknown
    receivedAt: number
  }) => Promise<string>
  appendAssistantMessageWithMeta: (turnId: string, content: string, meta?: PersistMeta) => Promise<string>
}

const getEnv = () => {
  const convexUrl =
    Bun.env.CONVEX_URL ??
    Bun.env.CONVEX_DEPLOYMENT ??
    Bun.env.CONVEX_SITE_ORIGIN ??
    Bun.env.CONVEX_SELF_HOSTED_URL ??
    // When running `bun run dev:all`, Convex often binds to the port written to VITE_CONVEX_URL.
    Bun.env.VITE_CONVEX_URL ??
    'http://127.0.0.1:3210'

  const adminKey = Bun.env.CONVEX_ADMIN_KEY ?? Bun.env.CONVEX_DEPLOY_KEY

  const skipUrlCheck = convexUrl.includes('127.0.0.1') || convexUrl.includes('/http') || convexUrl.startsWith('http://')

  return { convexUrl, adminKey, skipUrlCheck }
}

const createClient = () => {
  const { convexUrl, adminKey, skipUrlCheck } = getEnv()
  const client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: skipUrlCheck })
  if (adminKey) {
    // @ts-expect-error setAdminAuth exists at runtime but may not be in browser typings
    client.setAdminAuth(adminKey)
  }
  return client
}

export const createDbClient = async (): Promise<DbClient> => {
  const convex = createClient()
  const mutate = (name: string, args: Record<string, unknown>) => convex.mutation(name as never, args as never)
  const now = () => Date.now()

  const upsertConversation: DbClient['upsertConversation'] = (input) =>
    mutate('app:upsertConversation', input) as unknown as Promise<string>

  const upsertTurn: DbClient['upsertTurn'] = (input) => mutate('app:upsertTurn', input) as unknown as Promise<string>

  const appendMessage: DbClient['appendMessage'] = (input) =>
    mutate('app:appendMessage', input) as unknown as Promise<string>

  const appendReasoning: DbClient['appendReasoning'] = (input) =>
    mutate('app:appendReasoningSection', input) as unknown as Promise<string>

  const appendUsage: DbClient['appendUsage'] = (input) =>
    mutate('app:appendUsageSnapshot', input) as unknown as Promise<string>

  const appendRateLimit: DbClient['appendRateLimit'] = (input) =>
    mutate('app:appendRateLimit', input) as unknown as Promise<string>

  const upsertCommand: DbClient['upsertCommand'] = (input) =>
    mutate('app:upsertCommand', input) as unknown as Promise<string>

  const appendCommandChunk: DbClient['appendCommandChunk'] = (input) =>
    mutate('app:appendCommandChunk', input) as unknown as Promise<string>

  const appendEvent: DbClient['appendEvent'] = (input) => mutate('app:appendEvent', input) as unknown as Promise<string>

  const appendAssistantMessageWithMeta: DbClient['appendAssistantMessageWithMeta'] = (turnId, content, meta) =>
    appendMessage({ turnId, role: 'assistant', content, rawContent: meta, createdAt: now() })

  return {
    upsertConversation,
    upsertTurn,
    appendMessage,
    appendReasoning,
    appendUsage,
    appendRateLimit,
    upsertCommand,
    appendCommandChunk,
    appendEvent,
    appendAssistantMessageWithMeta,
  }
}
