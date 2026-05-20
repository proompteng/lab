import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import wsAdapter from 'crossws/adapters/bun'
import { createApp, defineEventHandler, getRouterParams, toWebHandler } from 'h3'

export type AgentsServerRouteHandler = (args: {
  request: Request
  params: Record<string, string>
}) => Response | Promise<Response>

export type AgentsServerRouteModule = {
  Route?: {
    options?: {
      server?: {
        handlers?: Partial<Record<string, AgentsServerRouteHandler>>
      }
    }
  }
}

export type AgentsServerRouteDefinition = {
  file: string
  routePath: string
  handlers: Partial<Record<string, AgentsServerRouteHandler>>
}

export type AgentsHttpRuntime = {
  handleRequest: (request: Request) => Promise<Response>
  handleUpgrade: (
    request: Request,
    server: Bun.Server<unknown>,
  ) => Promise<{ kind: 'handled' } | { kind: 'response'; response: Response } | { kind: 'skip' }>
  websocket: Bun.WebSocketHandler<unknown>
}

export type AgentsHttpRuntimeMetrics = {
  enabled: () => boolean
  path: () => string
  render: () => Promise<{ ok: true; body: string } | { ok: false; message: string }>
}

export type AgentsHttpRuntimeOptions = {
  routeModules: Record<string, () => Promise<unknown>>
  routeSources: Record<string, string>
  serveClient?: boolean
  clientOutputDirCandidates?: () => string[]
  clientMissingMessage?: string
  metrics?: AgentsHttpRuntimeMetrics
}

type WebSocketAdapterOptions = NonNullable<Parameters<typeof wsAdapter>[0]>
type ResolvedWebSocketHooks = NonNullable<WebSocketAdapterOptions['hooks']>
type WebSocketRouteProbeResponse = Response & { crossws?: ResolvedWebSocketHooks }
type WebSocketRequest = Request & {
  context?: Record<string, unknown> & { __agentsResolvedWebSocketHooks?: ResolvedWebSocketHooks }
}

const serverRoutePattern = /createFileRoute\(\s*(['"`])([^'"`]+)\1\s*\)/
const serverMethods = ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const
const defaultClientOutputDirCandidates = () => [resolve(process.cwd(), '.output/public')]
const defaultCorsAllowedMethods = 'DELETE, GET, OPTIONS, PATCH, POST, PUT'
const defaultCorsAllowedHeaders = 'accept, authorization, content-type, idempotency-key'
const corsMaxAgeSeconds = '86400'

const isWebSocketUpgradeRequest = (request: Request) => request.headers.get('upgrade')?.toLowerCase() === 'websocket'

const getEventRequest = (event: { req: Request }) => event.req

const normalizeRoutePath = (routePath: string) => {
  if (routePath === '/') return '/'

  const trimmed = routePath.trim()
  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : '/'
}

const toH3RoutePath = (routePath: string) => {
  const normalized = normalizeRoutePath(routePath)
  if (normalized === '/') return '/'

  return normalized
    .split('/')
    .map((segment) => {
      if (!segment) return segment
      if (segment === '$') return '**'
      if (segment.startsWith('$')) return `:${segment.slice(1)}`
      return segment
    })
    .join('/')
}

const getRegistrationPaths = (routePath: string) => {
  const h3RoutePath = toH3RoutePath(routePath)
  if (h3RoutePath === '/') return ['/']
  return Array.from(new Set([h3RoutePath, `${h3RoutePath}/`]))
}

const hasRegularFile = async (path: string) => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const isPathInsideDirectory = (rootDir: string, targetPath: string) => {
  const relativePath = relative(rootDir, targetPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const getFirstPathSegment = (pathname: string) => pathname.split('/').find(Boolean) ?? null

const getServerRouteRoots = (definitions: AgentsServerRouteDefinition[]) =>
  new Set(
    definitions
      .map(({ routePath }) => getFirstPathSegment(normalizeRoutePath(routePath)))
      .filter((segment): segment is string => segment !== null),
  )

const shouldServeClientPath = (pathname: string, serverRouteRoots: ReadonlySet<string>) => {
  const firstSegment = getFirstPathSegment(pathname)
  return firstSegment === null || !serverRouteRoots.has(firstSegment)
}

const isCorsManagedPath = (pathname: string) => pathname === '/v1' || pathname.startsWith('/v1/')

const resolveCorsAllowedOrigins = () => {
  const configured = process.env.AGENTS_CORS_ALLOWED_ORIGINS
  const values = configured?.split(',') ?? []
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
}

const resolveCorsOrigin = (request: Request, allowedOrigins: ReadonlySet<string>) => {
  const origin = request.headers.get('origin')?.trim()
  if (!origin || !allowedOrigins.has(origin)) return null
  return origin
}

const isCorsManagedRequest = (request: Request, serverRouteRoots: ReadonlySet<string>) => {
  const { pathname } = new URL(request.url)
  if (!isCorsManagedPath(pathname)) return false
  const firstSegment = getFirstPathSegment(pathname)
  return firstSegment !== null && serverRouteRoots.has(firstSegment)
}

const withCorsHeaders = (response: Response, request: Request, allowedOrigins: ReadonlySet<string>) => {
  const origin = resolveCorsOrigin(request, allowedOrigins)
  if (!origin) return response

  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', defaultCorsAllowedMethods)
  headers.set('access-control-allow-headers', defaultCorsAllowedHeaders)
  headers.set('access-control-max-age', corsMaxAgeSeconds)
  headers.append('vary', 'Origin')
  headers.append('vary', 'Access-Control-Request-Headers')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const isCorsPreflightRequest = (request: Request) =>
  request.method.toUpperCase() === 'OPTIONS' &&
  request.headers.has('origin') &&
  request.headers.has('access-control-request-method')

const corsPreflightResponse = (request: Request, allowedOrigins: ReadonlySet<string>) =>
  withCorsHeaders(new Response(null, { status: 204 }), request, allowedOrigins)

const getResolvedWebSocketHooks = (request: Request) =>
  (request as WebSocketRequest).context?.__agentsResolvedWebSocketHooks

const storeResolvedWebSocketHooks = (request: Request, hooks: ResolvedWebSocketHooks) => {
  const websocketRequest = request as WebSocketRequest
  websocketRequest.context = {
    ...websocketRequest.context,
    __agentsResolvedWebSocketHooks: hooks,
  }
}

const resolveClientIndexPath = async (getClientOutputDirCandidates: () => string[]) => {
  for (const clientDir of getClientOutputDirCandidates()) {
    const indexPath = resolve(clientDir, 'index.html')
    if (await hasRegularFile(indexPath)) return indexPath
  }

  return null
}

const resolveStaticFile = async (pathname: string, getClientOutputDirCandidates: () => string[]) => {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  for (const clientDir of getClientOutputDirCandidates()) {
    if (decodedPath === '/') {
      const indexPath = resolve(clientDir, 'index.html')
      if (await hasRegularFile(indexPath)) return indexPath
      continue
    }

    const target = resolve(clientDir, `.${decodedPath}`)
    if (!isPathInsideDirectory(clientDir, target)) continue
    if (await hasRegularFile(target)) return target
  }

  return null
}

const serveClientResponse = async (
  request: Request,
  getClientOutputDirCandidates: () => string[],
  clientMissingMessage: string,
) => {
  const { pathname } = new URL(request.url)
  const staticFile = await resolveStaticFile(pathname, getClientOutputDirCandidates)
  if (staticFile) {
    const file = Bun.file(staticFile)
    return new Response(file, {
      headers: file.type ? { 'content-type': file.type } : undefined,
    })
  }

  const indexPath = await resolveClientIndexPath(getClientOutputDirCandidates)
  if (!indexPath) {
    return new Response(clientMissingMessage, { status: 503 })
  }

  return new Response(Bun.file(indexPath), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

const loadServerRoutes = async (
  routeModules: AgentsHttpRuntimeOptions['routeModules'],
  routeSources: AgentsHttpRuntimeOptions['routeSources'],
): Promise<AgentsServerRouteDefinition[]> => {
  const definitions: AgentsServerRouteDefinition[] = []

  for (const [file, source] of Object.entries(routeSources)) {
    if (file.includes('.test.') || file.includes('.spec.')) continue
    if (!source.includes('server:')) continue

    const load = routeModules[file]
    if (!load) continue

    const match = serverRoutePattern.exec(source)
    const routePath = match?.[2]
    if (!routePath) continue

    const module = (await load()) as AgentsServerRouteModule
    const handlers = module.Route?.options?.server?.handlers
    if (!handlers || Object.keys(handlers).length === 0) continue

    definitions.push({
      file,
      routePath,
      handlers,
    })
  }

  return definitions
}

const registerServerRoutes = (app: ReturnType<typeof createApp>, definitions: AgentsServerRouteDefinition[]) => {
  for (const definition of definitions) {
    for (const method of serverMethods) {
      const handler = definition.handlers[method]
      if (!handler) continue

      const wrappedHandler = defineEventHandler((event) =>
        handler({
          request: getEventRequest(event),
          params: getRouterParams(event, { decode: true }),
        }),
      )

      for (const path of getRegistrationPaths(definition.routePath)) {
        switch (method) {
          case 'DELETE':
            app.delete(path, wrappedHandler)
            break
          case 'GET':
            app.get(path, wrappedHandler)
            break
          case 'OPTIONS':
            app.options(path, wrappedHandler)
            break
          case 'PATCH':
            app.patch(path, wrappedHandler)
            break
          case 'POST':
            app.post(path, wrappedHandler)
            break
          case 'PUT':
            app.put(path, wrappedHandler)
            break
        }
      }
    }
  }
}

export const createAgentsHttpRuntime = async (options: AgentsHttpRuntimeOptions): Promise<AgentsHttpRuntime> => {
  const app = createApp()
  const getClientOutputDirCandidates = options.clientOutputDirCandidates ?? defaultClientOutputDirCandidates
  const clientMissingMessage =
    options.clientMissingMessage ?? 'Client build output missing. Run the owning service build before serving client.'

  if (options.metrics) {
    app.use(
      defineEventHandler(async (event) => {
        if (!options.metrics?.enabled()) return

        const request = getEventRequest(event)
        const url = new URL(request.url)
        if (url.pathname !== options.metrics.path()) return

        const rendered = await options.metrics.render()
        if (!rendered.ok) {
          return new Response(JSON.stringify({ ok: false, message: rendered.message }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }

        return new Response(rendered.body, {
          status: 200,
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        })
      }),
    )
  }

  const serverRouteDefinitions = await loadServerRoutes(options.routeModules, options.routeSources)
  const serverRouteRoots = getServerRouteRoots(serverRouteDefinitions)
  registerServerRoutes(app, serverRouteDefinitions)

  if (options.serveClient === true) {
    const serveClient = defineEventHandler((event) => {
      const request = getEventRequest(event)
      const { pathname } = new URL(request.url)
      if (!shouldServeClientPath(pathname, serverRouteRoots)) {
        return new Response('Not Found', { status: 404 })
      }
      return serveClientResponse(request, getClientOutputDirCandidates, clientMissingMessage)
    })
    app.get('/**', serveClient)
    app.head('/**', serveClient)
  }

  const rawHandleRequest = toWebHandler(app)
  const corsAllowedOrigins = resolveCorsAllowedOrigins()
  const handleRequest = async (request: Request) => {
    if (isCorsManagedRequest(request, serverRouteRoots) && isCorsPreflightRequest(request)) {
      return corsPreflightResponse(request, corsAllowedOrigins)
    }

    const response = await rawHandleRequest(request)
    if (!isCorsManagedRequest(request, serverRouteRoots)) return response
    return withCorsHeaders(response, request, corsAllowedOrigins)
  }
  const adapter = wsAdapter({
    resolve: (request) => getResolvedWebSocketHooks(request) ?? {},
  })

  return {
    handleRequest,
    async handleUpgrade(request, server) {
      if (!isWebSocketUpgradeRequest(request)) {
        return { kind: 'skip' }
      }

      const upgradeProbeResponse = (await handleRequest(request)) as WebSocketRouteProbeResponse
      const routeHooks = upgradeProbeResponse.crossws
      if (!routeHooks) {
        return { kind: 'response', response: upgradeProbeResponse }
      }

      storeResolvedWebSocketHooks(request, routeHooks)

      const response = await adapter.handleUpgrade(request, server)
      if (response) {
        return { kind: 'response', response }
      }

      return { kind: 'handled' }
    },
    websocket: adapter.websocket,
  }
}

export const __private = {
  getRegistrationPaths,
  getServerRouteRoots,
  isPathInsideDirectory,
  loadServerRoutes,
  normalizeRoutePath,
  shouldServeClientPath,
  toH3RoutePath,
}
