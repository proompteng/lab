import { resolveTerminalBackendConfig } from '~/server/terminals-config'

export const terminalBackendUrl = resolveTerminalBackendConfig().backendUrl

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
  const timeoutMs = timeoutOverride === undefined ? resolveTerminalBackendConfig().timeoutMs : timeoutOverride
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
