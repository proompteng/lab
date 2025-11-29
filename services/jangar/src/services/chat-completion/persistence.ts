import { createDbClient } from '~/services/db'
import { serviceTier } from './state'
import { buildUsagePayload } from './utils'
import type { NormalizedCodexError, ToolDelta, TokenUsage } from './types'

export const persistAssistant = async (
  turnId: string,
  content: string,
  meta?: { threadId?: string; turnId?: string; tokenUsage?: TokenUsage | null; reasoningSummary?: string[] },
) => {
  try {
    const db = await createDbClient()
    await db.appendAssistantMessageWithMeta(turnId, content, meta)
  } catch (error) {
    console.warn('[jangar] convex persistence failed for assistant message', error)
  }
}

export const persistFailedTurn = async (
  db: Awaited<ReturnType<typeof createDbClient>>,
  {
    turnId,
    conversationId,
    chatId,
    userId,
    model,
    startedAt,
  }: {
    turnId: string
    conversationId: string
    chatId: string
    userId: string
    model?: string | null
    startedAt: number
  },
  errorMessage: string,
  eventMethod: string = 'turn/error',
) => {
  try {
    await db.upsertTurn({
      turnId,
      conversationId,
      chatId,
      userId,
      model: model ?? '',
      serviceTier,
      status: 'failed',
      error: errorMessage,
      startedAt,
      endedAt: Date.now(),
    })
    await db.appendEvent({
      conversationId,
      turnId,
      method: eventMethod,
      payload: { error: errorMessage },
      receivedAt: Date.now(),
    })
  } catch (persistError) {
    console.error('[jangar] failed to persist turn error', persistError)
  }
}

export const persistToolDelta = async (
  db: Awaited<ReturnType<typeof createDbClient>>,
  turnId: string,
  conversationId: string,
  delta: ToolDelta,
) => {
  const callId = delta.id ?? `tool-${crypto.randomUUID()}`
  const now = Date.now()

  await db.appendEvent({
    conversationId,
    turnId,
    method: 'tool',
    payload: delta,
    receivedAt: now,
  })

  if (delta.status === 'started') {
    await db.upsertCommand({
      callId,
      turnId,
      command: [delta.title],
      source: delta.toolKind,
      parsedCmd: delta.detail ? { detail: delta.detail } : undefined,
      status: 'started',
      startedAt: now,
      chunked: true,
    })
    return
  }

  if (delta.status === 'delta' && delta.detail) {
    const seq = (commandSeq.get(callId) ?? 0) + 1
    commandSeq.set(callId, seq)
    await db.appendCommandChunk({
      callId,
      stream: delta.toolKind === 'command' ? 'stdout' : 'stdout',
      seq,
      chunkBase64: Buffer.from(delta.detail).toString('base64'),
      createdAt: now,
    })
    await db.upsertCommand({
      callId,
      turnId,
      command: [delta.title],
      source: delta.toolKind,
      status: 'running',
      startedAt: now,
      chunked: true,
    })
    return
  }

  // completed/failed/etc.
  await db.upsertCommand({
    callId,
    turnId,
    command: [delta.title],
    source: delta.toolKind,
    status: delta.status,
    startedAt: now,
    endedAt: now,
    chunked: true,
  })
}

const commandSeq = new Map<string, number>()

export const parseCodexError = (error: unknown): NormalizedCodexError | null => {
  const candidates: Array<unknown> = [error]

  if (error instanceof Error) {
    candidates.push(error.message)
    if (error.cause) candidates.push(error.cause)
  }

  const tryParse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>
      } catch {
        return null
      }
    }
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
    return null
  }

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (!parsed) continue

    const nestedError = parsed.error as { message?: string; codexErrorInfo?: string } | undefined
    const codexErrorInfo =
      typeof parsed.codexErrorInfo === 'string'
        ? parsed.codexErrorInfo
        : typeof nestedError?.codexErrorInfo === 'string'
          ? nestedError.codexErrorInfo
          : null
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof nestedError?.message === 'string'
          ? nestedError.message
          : null

    if (codexErrorInfo || message) return { message, codexErrorInfo }
  }

  return null
}

export const buildContextWindowExceededResponse = (message: string) =>
  new Response(
    JSON.stringify({
      error: {
        message,
        type: 'invalid_request_error',
        code: 'context_window_exceeded',
      },
    }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
  )

export const persistFailedTurnEvent = (
  db: Awaited<ReturnType<typeof createDbClient>>,
  turnId: string,
  conversationId: string,
  payload: unknown,
  method: string,
) =>
  db.appendEvent({
    conversationId,
    turnId,
    method,
    payload,
    receivedAt: Date.now(),
  })

export { buildUsagePayload } from './utils'
