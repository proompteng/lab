type EnvSource = Record<string, string | undefined>

const DEFAULT_AGENTS_SERVICE_BASE_URL = 'http://agents.agents.svc.cluster.local'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const resolveAgentsServiceBaseUrl = (env: EnvSource = process.env) =>
  (
    normalizeNonEmpty(env.AGENTS_SERVICE_BASE_URL) ??
    normalizeNonEmpty(env.JANGAR_AGENTS_SERVICE_BASE_URL) ??
    DEFAULT_AGENTS_SERVICE_BASE_URL
  ).replace(/\/+$/, '')

const copyHeaders = (source: Headers, omit: Set<string>) => {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!omit.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  return headers
}

export const buildAgentsServiceProxyUrl = (request: Request, path: string, env: EnvSource = process.env) => {
  const requestUrl = new URL(request.url)
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`)
  targetUrl.search = requestUrl.search
  return targetUrl
}

export const proxyAgentsServiceRequest = async (request: Request, path: string, env: EnvSource = process.env) => {
  const method = request.method.toUpperCase()
  const targetUrl = buildAgentsServiceProxyUrl(request, path, env)
  const requestHeaders = copyHeaders(request.headers, HOP_BY_HOP_HEADERS)
  requestHeaders.set('x-jangar-agents-proxy', 'true')

  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()
  const upstream = await fetch(targetUrl, {
    body,
    headers: requestHeaders,
    method,
  })

  return new Response(upstream.body, {
    headers: copyHeaders(upstream.headers, HOP_BY_HOP_HEADERS),
    status: upstream.status,
    statusText: upstream.statusText,
  })
}

export const __test__ = {
  DEFAULT_AGENTS_SERVICE_BASE_URL,
}
