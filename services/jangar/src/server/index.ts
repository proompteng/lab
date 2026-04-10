import { bootRuntimeProfile } from './runtime-boot'
import { JANGAR_RUNTIME_PROFILES } from './runtime-profile'

const port = Number.parseInt(process.env.PORT ?? process.env.JANGAR_PORT ?? '3000', 10)
const hostname = process.env.HOST?.trim() || '0.0.0.0'
const runtimeProfile = JANGAR_RUNTIME_PROFILES.httpServer

bootRuntimeProfile(runtimeProfile)

const { createJangarRuntime } = await import('./app')
const runtime = await createJangarRuntime({ serveClient: runtimeProfile.serveClient })

const server = Bun.serve({
  port,
  hostname,
  websocket: runtime.websocket,
  async fetch(request, bunServer) {
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

console.log(`[jangar] listening on http://${server.hostname}:${server.port}`)
