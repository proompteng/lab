import { createAgentsControlPlaneRuntime } from './control-plane'

let runtimePromise: ReturnType<typeof createAgentsControlPlaneRuntime> | undefined

export const delegateAgentsRuntimeRequest = async (request: Request) => {
  runtimePromise ??= createAgentsControlPlaneRuntime({ enableWebSocket: false })
  const runtime = await runtimePromise
  return runtime.handleHttpRequest(request)
}
