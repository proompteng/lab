import { installJangarEnvCompatibility } from './env-compat'
import { bootRuntimeProfile } from './runtime-boot'
import { resolveRuntimeServiceName } from './runtime-identity'
import { resolveJangarRuntimeProfile } from './runtime-profile'
import { resolveHttpServerListenConfig } from './runtime-entry-config'

installJangarEnvCompatibility()

const { port, hostname, idleTimeoutSeconds } = resolveHttpServerListenConfig()
const runtimeProfile = resolveJangarRuntimeProfile()

bootRuntimeProfile(runtimeProfile)

const { createJangarRuntime } = await import('./app')
const runtime = await createJangarRuntime({ serveClient: runtimeProfile.serveClient })

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: idleTimeoutSeconds,
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

console.log(
  `[${resolveRuntimeServiceName()}] ${runtimeProfile.name} listening on http://${server.hostname}:${server.port}`,
)
