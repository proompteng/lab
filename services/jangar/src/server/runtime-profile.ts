export type JangarRuntimeStartup = {
  agentComms: boolean
  controlPlaneCache: boolean
  torghutQuantRuntime: boolean
  agentctlGrpc: boolean
}

export type JangarRuntimeProfileName = 'http-server' | 'vite-dev-api' | 'test'

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
      agentComms: false,
      controlPlaneCache: false,
      torghutQuantRuntime: false,
      agentctlGrpc: false,
    },
  },
} as const satisfies Record<string, JangarRuntimeProfile>
