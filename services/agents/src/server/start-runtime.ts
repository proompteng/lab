import { createAgentsControlPlaneRuntime } from './control-plane'

type AgentsStartRuntime = Awaited<ReturnType<typeof createAgentsControlPlaneRuntime>>

let runtimePromise: Promise<AgentsStartRuntime> | null = null

export const getAgentsStartRuntime = () => {
  runtimePromise ??= createAgentsControlPlaneRuntime({ enableWebSocket: false })
  return runtimePromise
}

export const delegateAgentsRuntimeRequest = async (request: Request) => {
  const runtime = await getAgentsStartRuntime()
  return runtime.handleHttpRequest(request)
}
