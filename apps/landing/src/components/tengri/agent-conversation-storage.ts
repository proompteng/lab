export type StoredConversation = {
  id: string
  title: string
  updatedAt: number
  unavailable?: boolean
}

export const MAX_STORED_CONVERSATIONS = 50

export function conversationsStorageKey(agentId: string) {
  return `tengri-conversations:${agentId}`
}

export function truncateConversationTitle(value: string) {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title) return 'New conversation'
  return title.length > 48 ? `${title.slice(0, 45).trimEnd()}…` : title
}

export function readStoredConversations(agentId: string, storage: Storage = localStorage): StoredConversation[] {
  try {
    const raw = storage.getItem(conversationsStorageKey(agentId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const candidate = entry as Record<string, unknown>
        if (typeof candidate.id !== 'string' || !candidate.id) return []
        if (typeof candidate.title !== 'string' || !candidate.title.trim()) return []
        if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return []
        const conversation: StoredConversation = {
          id: candidate.id,
          title: candidate.title.trim(),
          updatedAt: candidate.updatedAt,
        }
        if (candidate.unavailable === true) conversation.unavailable = true
        return [conversation]
      })
      .slice(0, MAX_STORED_CONVERSATIONS)
  } catch {
    return []
  }
}

/** Persist best-effort; always returns the in-memory registry slice that should stay in React state. */
export function writeStoredConversations(
  agentId: string,
  conversations: readonly StoredConversation[],
  storage: Storage = localStorage,
): StoredConversation[] {
  const next = conversations.slice(0, MAX_STORED_CONVERSATIONS)
  try {
    storage.setItem(conversationsStorageKey(agentId), JSON.stringify(next))
  } catch {
    // Persistence is best-effort; callers keep `next` as the React source of truth.
  }
  return next
}

export function mergeConversationRegistry(
  current: readonly StoredConversation[],
  next: StoredConversation,
): StoredConversation[] {
  const existing = current.find((conversation) => conversation.id === next.id)
  const preferredTitle =
    next.title && next.title !== 'New conversation'
      ? next.title
      : existing?.title && existing.title !== 'New conversation'
        ? existing.title
        : next.title || existing?.title || 'New conversation'
  const merged: StoredConversation = {
    id: next.id,
    title: preferredTitle,
    updatedAt: next.updatedAt,
  }
  if (next.unavailable) merged.unavailable = true
  return [merged, ...current.filter((conversation) => conversation.id !== next.id)].slice(0, MAX_STORED_CONVERSATIONS)
}

export function upsertStoredConversation(
  agentId: string,
  next: StoredConversation,
  current: readonly StoredConversation[],
  storage: Storage = localStorage,
): StoredConversation[] {
  return writeStoredConversations(agentId, mergeConversationRegistry(current, next), storage)
}

export function touchStoredConversation(
  agentId: string,
  threadId: string,
  current: readonly StoredConversation[],
  now = Date.now(),
  storage: Storage = localStorage,
): StoredConversation[] {
  const existing = current.find((conversation) => conversation.id === threadId)
  const updated: StoredConversation = existing
    ? { id: existing.id, title: existing.title, updatedAt: now, ...(existing.unavailable ? { unavailable: true } : {}) }
    : { id: threadId, title: 'New conversation', updatedAt: now }
  return writeStoredConversations(
    agentId,
    [updated, ...current.filter((conversation) => conversation.id !== threadId)],
    storage,
  )
}

export function markStoredConversationUnavailable(
  agentId: string,
  threadId: string,
  current: readonly StoredConversation[],
  now = Date.now(),
  storage: Storage = localStorage,
): StoredConversation[] {
  if (!current.some((conversation) => conversation.id === threadId)) {
    return writeStoredConversations(
      agentId,
      [{ id: threadId, title: 'Unavailable conversation', updatedAt: now, unavailable: true }, ...current],
      storage,
    )
  }
  return writeStoredConversations(
    agentId,
    current.map((conversation) =>
      conversation.id === threadId ? { ...conversation, unavailable: true } : conversation,
    ),
    storage,
  )
}

export function conversationTitleFromRegistry(current: readonly StoredConversation[], threadId: string) {
  return current.find((conversation) => conversation.id === threadId)?.title || ''
}
