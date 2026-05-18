export type JangarRuntimeStartup = {
  agentComms: boolean
  controlPlaneCache: boolean
  torghutQuantRuntime: boolean
  agentctlGrpc: boolean
}

export type JangarRuntimeProfileName = 'http-server' | 'agents-controllers' | 'vite-dev-api' | 'test'

export type JangarRuntimeProfile = {
  name: JangarRuntimeProfileName
  serveClient: boolean
  startup: JangarRuntimeStartup
}

const fullStartup: JangarRuntimeStartup = {
  agentComms: true,
  controlPlaneCache: true,
  torghutQuantRuntime: true,
  agentctlGrpc: true,
}

const controllersStartup: JangarRuntimeStartup = {
  agentComms: true,
  controlPlaneCache: false,
  torghutQuantRuntime: false,
  agentctlGrpc: false,
}

export const JANGAR_RUNTIME_PROFILES = {
  httpServer: {
    name: 'http-server',
    serveClient: true,
    startup: fullStartup,
  },
  agentsControllers: {
    name: 'agents-controllers',
    serveClient: false,
    startup: controllersStartup,
  },
  viteDevApi: {
    name: 'vite-dev-api',
    serveClient: false,
    startup: fullStartup,
  },
  test: {
    name: 'test',
    serveClient: false,
    startup: {
      agentComms: false,
      controlPlaneCache: false,
      torghutQuantRuntime: false,
      agentctlGrpc: false,
    },
  },
} as const satisfies Record<string, JangarRuntimeProfile>

const normalizeProfileName = (value: string | undefined | null) => {
  const normalized = value?.trim().toLowerCase().replace(/_/g, '-')
  return normalized && normalized.length > 0 ? normalized : undefined
}

export const resolveJangarRuntimeProfile = (
  env: Record<string, string | undefined> = process.env,
): JangarRuntimeProfile => {
  const requested = normalizeProfileName(env.AGENTS_SERVER_PROFILE) ?? normalizeProfileName(env.JANGAR_SERVER_PROFILE)

  if (requested === 'agents-controllers' || requested === 'controller' || requested === 'controllers') {
    return JANGAR_RUNTIME_PROFILES.agentsControllers
  }

  return JANGAR_RUNTIME_PROFILES.httpServer
}
