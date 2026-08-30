export type TerminalSession = {
  id: string
  label: string
  worktreePath: string | null
  worktreeName: string | null
  createdAt: string | null
  attached: boolean
  status: 'creating' | 'ready' | 'error' | 'closed'
  errorMessage?: string | null
  reconnectToken?: string | null
}

type TerminalSessionsResponse = { ok: true; sessions: TerminalSession[] } | { ok: false; message?: string }

type TerminalCreateResponse = { ok: true; session: TerminalSession } | { ok: false; message?: string }

const readErrorMessage = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message || fallback
  }
  return fallback
}

export const fetchTerminalSessions = async (options: { showClosed?: boolean } = {}) => {
  const response = await fetch(options.showClosed ? '/api/terminals?includeClosed=1' : '/api/terminals')
  const payload = (await response.json().catch(() => null)) as TerminalSessionsResponse | null

  if (!response.ok || !payload || !payload.ok) {
    return { ok: false as const, error: readErrorMessage(payload, 'Unable to load sessions.') }
  }

  return { ok: true as const, sessions: payload.sessions }
}

export const createTerminalSession = async () => {
  const response = await fetch('/api/terminals?create=1')
  const payload = (await response.json().catch(() => null)) as TerminalCreateResponse | null

  if (!response.ok || !payload || !payload.ok) {
    return { ok: false as const, error: readErrorMessage(payload, 'Unable to create session.') }
  }

  return { ok: true as const, session: payload.session }
}

export const deleteTerminalSession = async (sessionId: string) => {
  const response = await fetch(`/api/terminals/${encodeURIComponent(sessionId)}/delete`, {
    method: 'POST',
  })
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null

  if (!response.ok || !payload?.ok) {
    return { ok: false as const, error: readErrorMessage(payload, 'Unable to delete session.') }
  }

  return { ok: true as const }
}
