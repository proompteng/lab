import { ensureAgentCommsRuntime } from './agent-comms-runtime'
import { startAgentctlGrpcServer } from './agentctl-grpc'
import { startControlPlaneCache } from './control-plane-cache'
import { startTorghutQuantRuntime } from './torghut-quant-runtime'

type StartupState = {
  started: boolean
  grpcShutdownInstalled: boolean
}

const globalState = globalThis as typeof globalThis & {
  __jangarRuntimeStartup?: StartupState
}

const getState = (): StartupState => {
  if (!globalState.__jangarRuntimeStartup) {
    globalState.__jangarRuntimeStartup = {
      started: false,
      grpcShutdownInstalled: false,
    }
  }

  return globalState.__jangarRuntimeStartup
}

export const ensureRuntimeStartup = () => {
  const state = getState()
  if (state.started) return

  state.started = true

  ensureAgentCommsRuntime()
  void startControlPlaneCache()
  startTorghutQuantRuntime()

  const instance = startAgentctlGrpcServer()
  if (!instance || state.grpcShutdownInstalled) return

  state.grpcShutdownInstalled = true
  const shutdown = () => {
    instance.server.tryShutdown((error) => {
      if (error) {
        console.error('[jangar] agentctl grpc shutdown failed', error)
      }
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
