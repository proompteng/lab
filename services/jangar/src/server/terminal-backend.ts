const DEFAULT_BACKEND_TIMEOUT_MS = 15_000

const rawBackendUrl = process.env.JANGAR_TERMINAL_BACKEND_URL?.trim()
export const terminalBackendUrl = rawBackendUrl && rawBackendUrl.length > 0 ? rawBackendUrl : null

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const backendTimeoutMs = parseNumber(process.env.JANGAR_TERMINAL_BACKEND_TIMEOUT_MS, DEFAULT_BACKEND_TIMEOUT_MS)

export const isTerminalBackendProxyEnabled = () => Boolean(terminalBackendUrl)

export const buildTerminalBackendUrl = (path: string, query?: URLSearchParams) => {
  if (!terminalBackendUrl) {
    throw new Error('Terminal backend URL is not configured')
  }
  const url = new URL(path, terminalBackendUrl)
  if (query) {
    url.search = query.toString()
  }
  return url.toString()
}

export const fetchTerminalBackend = async (path: string, init: RequestInit = {}, timeoutOverride?: number) => {
  const timeoutMs = timeoutOverride === undefined ? backendTimeoutMs : timeoutOverride
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs)
  }
  try {
    const response = await fetch(buildTerminalBackendUrl(path), {
      ...init,
      signal: controller.signal,
    })
    return response
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export const fetchTerminalBackendJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetchTerminalBackend(path, init)
  const payload = (await response.json().catch(() => null)) as T | null
  if (!response.ok || payload === null) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload ? (payload as { message?: string }).message : null
    throw new Error(message ?? `Terminal backend error (${response.status})`)
  }
  return payload
}
