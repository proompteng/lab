import { getAppServer } from '../../lib/app-server'

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
