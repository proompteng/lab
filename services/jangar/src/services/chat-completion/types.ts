import type { StreamDelta } from '@proompteng/codex'

export type Message = { role: string; content: unknown }

export type ChatCompletionRequest = {
  messages?: Message[]
  model?: string
  stream?: boolean
  user?: string
  stream_options?: {
    include_usage?: boolean
  }
}

export type TokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

export type PersistMeta = {
  threadId?: string
  turnId?: string
  codexTurnId?: string
  tokenUsage?: TokenUsage | null
  reasoningSummary?: string[]
  usagePersisted?: boolean
}

export type ReasoningPart = { type: 'text'; text: string }

export type StreamOptions = {
  model?: string
  signal: AbortSignal
  onComplete?: (content: string, reasoning: ReasoningPart[], meta: PersistMeta) => Promise<void>
  onFinalize?: (result: {
    outcome: 'succeeded' | 'failed' | 'aborted' | 'timeout' | 'error'
    reason?: string
  }) => void | Promise<void>
  onCodexTurn?: (ids: { threadId: string; codexTurnId?: string }) => void
  chatId: string
  includeUsage?: boolean
  threadId?: string
  appServer?: ReturnType<typeof import('../app-server')['getAppServer']>
  db: Awaited<ReturnType<typeof import('~/services/db')['createDbClient']>>
  conversationId: string
  turnId: string
  userId: string
  startedAt: number
}

export type ToolDelta = Extract<StreamDelta, { type: 'tool' }>

export type NormalizedCodexError = { message: string | null; codexErrorInfo: string | null }
