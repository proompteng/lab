import type { JangarRuntimeStartup } from './runtime-profile'
import { startTorghutQuantRuntime } from './torghut-quant-runtime'
import { startWhitepaperFinalizeConsumer } from './whitepaper-finalize-consumer'

type StartupState = {
  torghutQuantRuntimeStarted: boolean
  whitepaperFinalizeConsumerStarted: boolean
}

const globalState = globalThis as typeof globalThis & {
  __jangarRuntimeStartup?: StartupState
}

const getState = (): StartupState => {
  if (!globalState.__jangarRuntimeStartup) {
    globalState.__jangarRuntimeStartup = {
      torghutQuantRuntimeStarted: false,
      whitepaperFinalizeConsumerStarted: false,
    }
  }

  return globalState.__jangarRuntimeStartup
}

export const ensureRuntimeStartup = (startup: JangarRuntimeStartup) => {
  const state = getState()

  if (startup.torghutQuantRuntime && !state.torghutQuantRuntimeStarted) {
    state.torghutQuantRuntimeStarted = true
    startTorghutQuantRuntime()
  }

  if (startup.whitepaperFinalizeConsumer && !state.whitepaperFinalizeConsumerStarted) {
    state.whitepaperFinalizeConsumerStarted = true
    startWhitepaperFinalizeConsumer()
  }
}
