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

function parseStoredConversations(raw: string | null): StoredConversation[] {
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
}

/** Merge this tab's desired registry with whatever another tab already persisted. */
export function mergePersistedConversationRegistry(
  preferred: readonly StoredConversation[],
  persisted: readonly StoredConversation[],
): StoredConversation[] {
  const byId = new Map<string, StoredConversation>()
  for (const entry of persisted) byId.set(entry.id, entry)
  for (const entry of preferred) {
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, entry)
      continue
    }
    byId.set(entry.id, mergeConversationRegistry([existing], entry)[0]!)
  }
  return [...byId.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, MAX_STORED_CONVERSATIONS)
}

export function readStoredConversations(agentId: string, storage?: Storage): StoredConversation[] {
  try {
    // Resolve localStorage inside the try — accessing the global can throw SecurityError
    // before a default-parameter expression would ever enter this function body.
    const store = storage ?? localStorage
    return parseStoredConversations(store.getItem(conversationsStorageKey(agentId)))
  } catch {
    return []
  }
}

/** Persist best-effort; always returns the registry slice that should stay in React state. */
export function writeStoredConversations(
  agentId: string,
  conversations: readonly StoredConversation[],
  storage?: Storage,
): StoredConversation[] {
  const next = conversations.slice(0, MAX_STORED_CONVERSATIONS)
  try {
    const store = storage ?? localStorage
    const persisted = parseStoredConversations(store.getItem(conversationsStorageKey(agentId)))
    const merged = mergePersistedConversationRegistry(next, persisted)
    store.setItem(conversationsStorageKey(agentId), JSON.stringify(merged))
    return merged
  } catch {
    // Persistence is best-effort; callers keep `next` as the React source of truth.
    return next
  }
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
  storage?: Storage,
): StoredConversation[] {
  return writeStoredConversations(agentId, mergeConversationRegistry(current, next), storage)
}

export function touchStoredConversation(
  agentId: string,
  threadId: string,
  current: readonly StoredConversation[],
  now = Date.now(),
  storage?: Storage,
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
  storage?: Storage,
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
