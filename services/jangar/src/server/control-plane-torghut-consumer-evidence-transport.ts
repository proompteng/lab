type JsonRouteResult = {
  ok: boolean
  statusCode: number | null
  payload: Record<string, unknown> | null
}

export const requestJson = async (url: string, timeoutMs: number): Promise<JsonRouteResult> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: response.ok, statusCode: response.status, payload: null }
    }
    return { ok: response.ok, statusCode: response.status, payload: payload as Record<string, unknown> }
  } catch {
    return { ok: false, statusCode: null, payload: null }
  } finally {
    clearTimeout(timeout)
  }
}

export const compactConsumerEvidenceEndpoint = (endpoint: string): string => {
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, '')
    if (path.endsWith('/trading/consumer-evidence') && !url.searchParams.has('view')) {
      url.searchParams.set('view', 'summary')
      return url.toString()
    }
  } catch {
    return endpoint
  }
  return endpoint
}
