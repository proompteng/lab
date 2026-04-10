import { ensureAgentCommsRuntime } from './agent-comms-runtime'
import { startAgentctlGrpcServer } from './agentctl-grpc'
import { startControlPlaneCache } from './control-plane-cache'
import type { JangarRuntimeStartup } from './runtime-profile'
import { startTorghutQuantRuntime } from './torghut-quant-runtime'

type StartupState = {
  agentCommsStarted: boolean
  controlPlaneCacheStarted: boolean
  torghutQuantRuntimeStarted: boolean
  grpcBootAttempted: boolean
  grpcShutdownInstalled: boolean
}

const globalState = globalThis as typeof globalThis & {
  __jangarRuntimeStartup?: StartupState
}

const getState = (): StartupState => {
  if (!globalState.__jangarRuntimeStartup) {
    globalState.__jangarRuntimeStartup = {
      agentCommsStarted: false,
      controlPlaneCacheStarted: false,
      torghutQuantRuntimeStarted: false,
      grpcBootAttempted: false,
      grpcShutdownInstalled: false,
    }
  }

  return globalState.__jangarRuntimeStartup
}

export const ensureRuntimeStartup = (startup: JangarRuntimeStartup) => {
  const state = getState()

  if (startup.agentComms && !state.agentCommsStarted) {
    state.agentCommsStarted = true
    ensureAgentCommsRuntime()
  }

  if (startup.controlPlaneCache && !state.controlPlaneCacheStarted) {
    state.controlPlaneCacheStarted = true
    void startControlPlaneCache()
  }

  if (startup.torghutQuantRuntime && !state.torghutQuantRuntimeStarted) {
    state.torghutQuantRuntimeStarted = true
    startTorghutQuantRuntime()
  }

  if (!startup.agentctlGrpc || state.grpcBootAttempted) return

  state.grpcBootAttempted = true
  const instance = startAgentctlGrpcServer()
  if (!instance) return

  if (state.grpcShutdownInstalled) return
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
