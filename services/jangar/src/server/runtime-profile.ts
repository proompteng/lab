export type JangarRuntimeStartup = {
  torghutQuantRuntime: boolean
  whitepaperFinalizeConsumer: boolean
}

export type JangarRuntimeProfileName = 'http-server' | 'vite-dev-api' | 'test'

export type JangarRuntimeProfile = {
  name: JangarRuntimeProfileName
  serveClient: boolean
  startup: JangarRuntimeStartup
}

const fullStartup: JangarRuntimeStartup = {
  torghutQuantRuntime: true,
  whitepaperFinalizeConsumer: true,
}

export const JANGAR_RUNTIME_PROFILES = {
  httpServer: {
    name: 'http-server',
    serveClient: true,
    startup: fullStartup,
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
  const requested = normalizeProfileName(env.JANGAR_SERVER_PROFILE)
  if (requested === 'vite-dev-api') return JANGAR_RUNTIME_PROFILES.viteDevApi
  if (requested === 'test') return JANGAR_RUNTIME_PROFILES.test

  return JANGAR_RUNTIME_PROFILES.httpServer
}
