import { createServer as createViteServer } from 'vite'

import { JANGAR_RUNTIME_PROFILES } from './runtime-profile'
import { ensureRuntimeStartup } from './runtime-startup'

type JangarRuntime = Awaited<ReturnType<typeof import('./app').createJangarRuntime>>

const port = Number.parseInt(process.env.PORT ?? process.env.JANGAR_API_PORT ?? '3001', 10)
const hostname = process.env.HOST?.trim() || '127.0.0.1'
const runtimeProfile = JANGAR_RUNTIME_PROFILES.viteDevApi

ensureRuntimeStartup(runtimeProfile.startup)

const vite = await createViteServer({
  configFile: './vite.server.config.ts',
  appType: 'custom',
  server: {
    middlewareMode: true,
  },
})

let runtimePromise: Promise<JangarRuntime> | null = null
let currentRuntime: JangarRuntime | null = null

const loadRuntime = async () => {
  runtimePromise ??= vite
    .ssrLoadModule('/src/server/app.ts')
    .then((module) => module.createJangarRuntime({ serveClient: runtimeProfile.serveClient }))
  currentRuntime = await runtimePromise
  return currentRuntime
}

vite.watcher.on('change', () => {
  runtimePromise = null
})

const server = Bun.serve({
  port,
  hostname,
  websocket: {
    close(ws, code, reason) {
      currentRuntime?.websocket.close?.(ws, code, reason)
    },
    drain(ws) {
      currentRuntime?.websocket.drain?.(ws)
    },
    message(ws, message) {
      currentRuntime?.websocket.message?.(ws, message)
    },
    open(ws) {
      currentRuntime?.websocket.open?.(ws)
    },
  },
  async fetch(request, bunServer) {
    const runtime = await loadRuntime()
    const upgrade = await runtime.handleUpgrade(request, bunServer)
    if (upgrade.kind === 'handled') {
      return
    }
    if (upgrade.kind === 'response') {
      return upgrade.response
    }

    return runtime.handleRequest(request)
  },
})

const shutdown = async () => {
  await vite.close()
  server.stop(true)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

console.log(`[jangar-dev] api server listening on http://${server.hostname}:${server.port}`)
