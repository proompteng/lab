import { getAppServer } from '~/services/app-server'

export const defaultUserId = 'openwebui'
export const systemFingerprint = Bun.env.CODEX_SYSTEM_FINGERPRINT ?? null
export const serviceTier = 'default'

export const defaultContextWindowMessage =
  "Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying."

let sharedAppServer: ReturnType<typeof getAppServer> | null = null
export const resolveAppServer = () => {
  if (!sharedAppServer) {
    sharedAppServer = getAppServer(Bun.env.CODEX_BIN ?? 'codex', Bun.env.CODEX_CWD ?? process.cwd())
  }
  return sharedAppServer
}

// Track Codex thread IDs per OpenWebUI chat so we can stream multiple turns without re-initializing.
export const threadMap = new Map<string, string>()
// Track last chatId per user for cases where chat_id is omitted on follow-ups.
export const lastChatIdForUser = new Map<string, string>()

// One chat/conversation must have at most one active turn at a time. This guard is cleared only when the
// corresponding stream finishes (success, timeout, abort, or error) to avoid ghost turn events from Codex.
export type ActiveTurn = {
  turnId: string
  conversationId: string
  startedAt: number
  threadId?: string | undefined
  codexTurnId?: string | undefined
}

export const activeTurnByChatId = new Map<string, ActiveTurn>()

export const registerActiveTurn = (chatId: string, turn: ActiveTurn): void => {
  activeTurnByChatId.set(chatId, turn)
}

export const updateActiveTurnCodexIds = (
  chatId: string,
  { threadId, codexTurnId }: { threadId?: string; codexTurnId?: string },
): ActiveTurn | null => {
  const existing = activeTurnByChatId.get(chatId)
  if (!existing) return null
  const updated: ActiveTurn = {
    ...existing,
    threadId: threadId ?? existing.threadId ?? undefined,
    codexTurnId: codexTurnId ?? existing.codexTurnId ?? undefined,
  }
  activeTurnByChatId.set(chatId, updated)
  return updated
}

export const clearActiveTurn = (chatId: string, turnId: string): boolean => {
  const existing = activeTurnByChatId.get(chatId)
  if (!existing || existing.turnId !== turnId) return false
  activeTurnByChatId.delete(chatId)
  return true
}

export const getActiveTurn = (chatId: string): ActiveTurn | null => activeTurnByChatId.get(chatId) ?? null
