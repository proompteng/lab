type DesktopCoordinationMessage =
  | { type: 'identity-probe'; desktopId: string; requestId: string }
  | { type: 'identity-present'; desktopId: string; requestId: string }
  | { type: 'agent-deleted'; eventId: string; sourceId: string }

type DesktopCoordinationChannel = {
  available: boolean
  close: () => void
  post: (message: DesktopCoordinationMessage) => void
}

const COORDINATION_ID_PATTERN = /^[0-9a-f]{32}$/
let documentCoordinationId = ''

function newCoordinationId() {
  return crypto.randomUUID().replaceAll('-', '')
}

function currentDocumentCoordinationId() {
  documentCoordinationId ||= newCoordinationId()
  return documentCoordinationId
}

function decodeCoordinationMessage(value: unknown): DesktopCoordinationMessage | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'agent-deleted') {
    return typeof candidate.eventId === 'string' &&
      COORDINATION_ID_PATTERN.test(candidate.eventId) &&
      typeof candidate.sourceId === 'string' &&
      COORDINATION_ID_PATTERN.test(candidate.sourceId)
      ? { type: candidate.type, eventId: candidate.eventId, sourceId: candidate.sourceId }
      : null
  }
  if (candidate.type !== 'identity-probe' && candidate.type !== 'identity-present') return null
  if (
    typeof candidate.desktopId !== 'string' ||
    !COORDINATION_ID_PATTERN.test(candidate.desktopId) ||
    typeof candidate.requestId !== 'string' ||
    !COORDINATION_ID_PATTERN.test(candidate.requestId)
  ) {
    return null
  }
  return { type: candidate.type, desktopId: candidate.desktopId, requestId: candidate.requestId }
}

export function createDesktopCoordinationChannel(
  agentId: string,
  onMessage: (message: DesktopCoordinationMessage) => void,
): DesktopCoordinationChannel {
  const channelName = `tengri-desktop:${agentId}`
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(channelName)
      const handleMessage = (event: MessageEvent<unknown>) => {
        const message = decodeCoordinationMessage(event.data)
        if (message) onMessage(message)
      }
      channel.addEventListener('message', handleMessage)
      return {
        available: true,
        close: () => {
          channel.removeEventListener('message', handleMessage)
          channel.close()
        },
        post: (message) => channel.postMessage(message),
      }
    } catch {
      // Fall through to storage events when BroadcastChannel is unavailable at runtime.
    }
  }

  const storageKey = `tengri:desktop-coordination:${agentId}`
  try {
    const probeKey = `${storageKey}:probe`
    localStorage.setItem(probeKey, '1')
    localStorage.removeItem(probeKey)
  } catch {
    return { available: false, close: () => {}, post: () => {} }
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== storageKey || !event.newValue) return
    try {
      const envelope = JSON.parse(event.newValue) as { message?: unknown }
      const message = decodeCoordinationMessage(envelope.message)
      if (message) onMessage(message)
    } catch {
      // Ignore malformed same-origin coordination messages.
    }
  }
  globalThis.addEventListener('storage', handleStorage)
  return {
    available: true,
    close: () => globalThis.removeEventListener('storage', handleStorage),
    post: (message) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ message, nonce: newCoordinationId() }))
        localStorage.removeItem(storageKey)
      } catch {
        // Cross-tab coordination remains best effort when browser storage becomes unavailable.
      }
    },
  }
}

export function clearDeletedDesktopState(agentId: string) {
  try {
    const exactKeys = new Set([`tengri:desktop:${agentId}`, `tengri:terminal-cleanup:${agentId}`])
    const prefixes = [`tengri:windows:${agentId}:`, `tengri:terminal:${agentId}:`]

    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) exactKeys.add(key)
    }

    for (const key of exactKeys) sessionStorage.removeItem(key)
  } catch {
    // Deleted guest state is still authoritative when session storage is unavailable.
  }
}

export function publishDeletedDesktopState(agentId: string) {
  clearDeletedDesktopState(agentId)
  const channel = createDesktopCoordinationChannel(agentId, () => {})
  channel.post({ type: 'agent-deleted', eventId: newCoordinationId(), sourceId: currentDocumentCoordinationId() })
  setTimeout(channel.close, 1_000)
}

export function subscribeDeletedDesktopState(agentId: string, onDeleted: () => void) {
  const channel = createDesktopCoordinationChannel(agentId, (message) => {
    if (message.type === 'agent-deleted' && message.sourceId !== currentDocumentCoordinationId()) onDeleted()
  })
  return channel.close
}
