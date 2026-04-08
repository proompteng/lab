import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import wsAdapter from 'crossws/adapters/bun'
import { createApp, defineEventHandler, getRouterParams, toWebHandler } from 'h3'

import { getPrometheusMetricsPath, isPrometheusMetricsEnabled, renderPrometheusMetrics } from './metrics'
import { ensureRuntimeStartup } from './runtime-startup'

type ServerRouteHandler = (args: { request: Request; params: Record<string, string> }) => Response | Promise<Response>

type ServerRouteModule = {
  Route?: {
    options?: {
      server?: {
        handlers?: Partial<Record<string, ServerRouteHandler>>
      }
    }
  }
}

type ServerRouteDefinition = {
  file: string
  routePath: string
  handlers: Partial<Record<string, ServerRouteHandler>>
}

type JangarRuntime = {
  handleRequest: (request: Request) => Promise<Response>
  handleUpgrade: (
    request: Request,
    server: Bun.Server<unknown>,
  ) => Promise<{ kind: 'handled' } | { kind: 'response'; response: Response } | { kind: 'skip' }>
  websocket: Bun.WebSocketHandler<unknown>
}

const serverRouteModules = import.meta.glob([
  '../routes/api/**/*.{ts,tsx}',
  '../routes/v1/**/*.{ts,tsx}',
  '../routes/openai/**/*.{ts,tsx}',
  '../routes/health.tsx',
  '../routes/ready.tsx',
  '../routes/mcp.ts',
  '!../routes/**/*.test.{ts,tsx}',
  '!../routes/**/*.spec.{ts,tsx}',
])
const serverRouteSources = import.meta.glob(
  [
    '../routes/api/**/*.{ts,tsx}',
    '../routes/v1/**/*.{ts,tsx}',
    '../routes/openai/**/*.{ts,tsx}',
    '../routes/health.tsx',
    '../routes/ready.tsx',
    '../routes/mcp.ts',
    '!../routes/**/*.test.{ts,tsx}',
    '!../routes/**/*.spec.{ts,tsx}',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>

const serverRoutePattern = /createFileRoute\(\s*(['"`])([^'"`]+)\1\s*\)/
const serverMethods = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'] as const

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

const getClientOutputDir = () => resolve(fileURLToPath(new URL('../../.output/public/', import.meta.url)))

const resolveStaticFile = async (pathname: string) => {
  const clientDir = getClientOutputDir()
  const decodedPath = decodeURIComponent(pathname)

  if (decodedPath === '/') {
    const indexPath = resolve(clientDir, 'index.html')
    return (await hasRegularFile(indexPath)) ? indexPath : null
  }

  const target = resolve(clientDir, `.${decodedPath}`)
  if (!target.startsWith(clientDir)) return null
  if (await hasRegularFile(target)) return target

  return null
}

const serveClientResponse = async (request: Request) => {
  const { pathname } = new URL(request.url)
  const staticFile = await resolveStaticFile(pathname)
  if (staticFile) {
    const file = Bun.file(staticFile)
    return new Response(file, {
      headers: file.type ? { 'content-type': file.type } : undefined,
    })
  }

  const indexPath = resolve(getClientOutputDir(), 'index.html')
  if (!(await hasRegularFile(indexPath))) {
    return new Response('Client build output missing. Run `bun run build` for services/jangar.', { status: 503 })
  }

  return new Response(Bun.file(indexPath), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

const loadServerRoutes = async (): Promise<ServerRouteDefinition[]> => {
  const definitions: ServerRouteDefinition[] = []

  for (const [file, source] of Object.entries(serverRouteSources)) {
    if (file.includes('.test.') || file.includes('.spec.')) continue
    if (!source.includes('server:')) continue

    const load = serverRouteModules[file]
    if (!load) continue

    const match = serverRoutePattern.exec(source)
    const routePath = match?.[2]
    if (!routePath) continue

    const module = (await load()) as ServerRouteModule
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

const registerServerRoutes = async (app: ReturnType<typeof createApp>) => {
  const definitions = await loadServerRoutes()

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

export const createJangarRuntime = async (options: { serveClient?: boolean } = {}): Promise<JangarRuntime> => {
  ensureRuntimeStartup()

  const app = createApp()

  app.use(
    defineEventHandler(async (event) => {
      if (!isPrometheusMetricsEnabled()) return

      const request = getEventRequest(event)
      const url = new URL(request.url)
      if (url.pathname !== getPrometheusMetricsPath()) return

      const rendered = await renderPrometheusMetrics()
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

  await registerServerRoutes(app)

  if (options.serveClient !== false) {
    const serveClient = defineEventHandler((event) => serveClientResponse(getEventRequest(event)))
    app.get('/**', serveClient)
    app.head('/**', serveClient)
  }

  const handleRequest = toWebHandler(app)
  const appWithWebsocket = app as typeof app & { websocket: Parameters<typeof wsAdapter>[0] }
  const adapter = wsAdapter(appWithWebsocket.websocket)

  return {
    handleRequest,
    async handleUpgrade(request, server) {
      if (!isWebSocketUpgradeRequest(request)) {
        return { kind: 'skip' }
      }

      const response = await adapter.handleUpgrade(request, server)
      if (response) {
        return { kind: 'response', response }
      }

      return { kind: 'handled' }
    },
    websocket: adapter.websocket,
  }
}
