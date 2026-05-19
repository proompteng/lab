export type JangarRuntimeStartup = {
  controlPlaneCache: boolean
  torghutQuantRuntime: boolean
  whitepaperFinalizeConsumer: boolean
}

export type JangarRuntimeProfileName =
  | 'http-server'
  | 'agents-control-plane'
  | 'agents-controllers'
  | 'vite-dev-api'
  | 'test'

export type JangarRuntimeProfile = {
  name: JangarRuntimeProfileName
  serveClient: boolean
  startup: JangarRuntimeStartup
}

const fullStartup: JangarRuntimeStartup = {
  controlPlaneCache: true,
  torghutQuantRuntime: true,
  whitepaperFinalizeConsumer: true,
}

const agentsControlPlaneStartup: JangarRuntimeStartup = {
  controlPlaneCache: true,
  torghutQuantRuntime: false,
  whitepaperFinalizeConsumer: false,
}

const controllersStartup: JangarRuntimeStartup = {
  controlPlaneCache: false,
  torghutQuantRuntime: false,
  whitepaperFinalizeConsumer: false,
}

export const JANGAR_RUNTIME_PROFILES = {
  httpServer: {
    name: 'http-server',
    serveClient: true,
    startup: fullStartup,
  },
  agentsControlPlane: {
    name: 'agents-control-plane',
    serveClient: false,
    startup: agentsControlPlaneStartup,
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
      controlPlaneCache: false,
      torghutQuantRuntime: false,
      whitepaperFinalizeConsumer: false,
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

  if (requested === 'agents-control-plane' || requested === 'control-plane' || requested === 'api') {
    return JANGAR_RUNTIME_PROFILES.agentsControlPlane
  }

  if (requested === 'agents-controllers' || requested === 'controller' || requested === 'controllers') {
    return JANGAR_RUNTIME_PROFILES.agentsControllers
  }

  return JANGAR_RUNTIME_PROFILES.httpServer
}
