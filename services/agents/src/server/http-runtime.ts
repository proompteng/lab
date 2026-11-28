import wsAdapter from 'crossws/adapters/bun'
import { createApp, defineEventHandler, getRouterParams, toWebHandler } from 'h3'

import type { AgentsServerRouteHandler, AgentsServerRouteLoader } from './server-route'

type AgentsServerRouteDefinition = {
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

type AgentsHttpRuntimeMetrics = {
  enabled: () => boolean
  path: () => string
  render: () => Promise<{ ok: true; body: string } | { ok: false; message: string }>
}

type AgentsHttpRuntimeOptions = {
  routeModules: AgentsServerRouteLoader[]
  enableWebSocket?: boolean
  metrics?: AgentsHttpRuntimeMetrics
}

type WebSocketAdapterOptions = NonNullable<Parameters<typeof wsAdapter>[0]>
type ResolvedWebSocketHooks = NonNullable<WebSocketAdapterOptions['hooks']>
type WebSocketRouteProbeResponse = Response & { crossws?: ResolvedWebSocketHooks }
type WebSocketRequest = Request & {
  context?: Record<string, unknown> & { __agentsResolvedWebSocketHooks?: ResolvedWebSocketHooks }
}

const serverMethods = ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const
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

const getFirstPathSegment = (pathname: string) => pathname.split('/').find(Boolean) ?? null

const getServerRouteRoots = (definitions: AgentsServerRouteDefinition[]) =>
  new Set(
    definitions
      .map(({ routePath }) => getFirstPathSegment(normalizeRoutePath(routePath)))
      .filter((segment): segment is string => segment !== null),
  )

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

const loadServerRoutes = async (routeModules: AgentsServerRouteLoader[]): Promise<AgentsServerRouteDefinition[]> => {
  const definitions: AgentsServerRouteDefinition[] = []

  for (const load of routeModules) {
    const { Route } = await load()
    const routePath = Route.path
    if (!routePath) continue

    const handlers = Route.options.server?.handlers
    if (!handlers || Object.keys(handlers).length === 0) continue

    definitions.push({ routePath, handlers })
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

  const serverRouteDefinitions = await loadServerRoutes(options.routeModules)
  const serverRouteRoots = getServerRouteRoots(serverRouteDefinitions)
  registerServerRoutes(app, serverRouteDefinitions)

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
  const adapter =
    options.enableWebSocket === false
      ? null
      : wsAdapter({
          resolve: (request) => getResolvedWebSocketHooks(request) ?? {},
        })

  return {
    handleRequest,
    async handleUpgrade(request, server) {
      if (!isWebSocketUpgradeRequest(request)) {
        return { kind: 'skip' }
      }
      if (!adapter) {
        return {
          kind: 'response',
          response: new Response('WebSocket upgrades are not available in this runtime', { status: 426 }),
        }
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
    websocket: (adapter?.websocket ?? {}) as Bun.WebSocketHandler<unknown>,
  }
}
