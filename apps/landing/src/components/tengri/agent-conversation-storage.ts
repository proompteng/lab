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
  try {
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
    // Malformed JSON / unexpected shape — treat as empty so writers can repair storage.
    return []
  }
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
    byId.set(entry.id, mergeSameIdStoredConversations(existing, entry))
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

function pickRicherConversationTitle(left: string, right: string) {
  const leftReal = Boolean(left && left !== 'New conversation')
  const rightReal = Boolean(right && right !== 'New conversation')
  if (leftReal && rightReal) return left.length >= right.length ? left : right
  if (leftReal) return left
  if (rightReal) return right
  return left || right || 'New conversation'
}

/** Prefer the newer same-ID record; on equal updatedAt, keep the richer fields. */
export function mergeSameIdStoredConversations(
  left: StoredConversation,
  right: StoredConversation,
): StoredConversation {
  if (left.updatedAt !== right.updatedAt) {
    const newer = left.updatedAt > right.updatedAt ? left : right
    const older = newer === left ? right : left
    return mergeConversationRegistry([older], newer)[0]!
  }
  const merged: StoredConversation = {
    id: left.id,
    title: pickRicherConversationTitle(left.title, right.title),
    updatedAt: left.updatedAt,
  }
  if (left.unavailable || right.unavailable) merged.unavailable = true
  return merged
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
      // Stamp the transition so it wins the cross-tab merge against a stale persisted record.
      conversation.id === threadId ? { ...conversation, unavailable: true, updatedAt: now } : conversation,
    ),
    storage,
  )
}

export function conversationTitleFromRegistry(current: readonly StoredConversation[], threadId: string) {
  return current.find((conversation) => conversation.id === threadId)?.title || ''
}

/**
 * Sidebar title for a resumed thread. A real (non-default) registry title wins, because the
 * restored transcript is bounded and may have evicted the thread's actual first user message.
 */
export function resolveConversationTitle(registryTitle: string, transcriptTitle: string) {
  const stored = registryTitle.trim()
  if (stored && stored !== 'New conversation') return truncateConversationTitle(stored)
  return truncateConversationTitle(transcriptTitle || stored)
}

/**
 * Promote an accepted first prompt to the sidebar title. Only call this after the turn was
 * accepted, so a failed send (whose draft the user may edit) never becomes authoritative.
 */
export function promoteAcceptedConversationTitle(
  agentId: string,
  threadId: string,
  acceptedText: string,
  current: readonly StoredConversation[],
  now = Date.now(),
  storage?: Storage,
): StoredConversation[] {
  const stored = conversationTitleFromRegistry(current, threadId).trim()
  if (stored && stored !== 'New conversation') return [...current]
  const title = truncateConversationTitle(acceptedText)
  if (title === 'New conversation') return [...current]
  return upsertStoredConversation(agentId, { id: threadId, title, updatedAt: now }, current, storage)
}
