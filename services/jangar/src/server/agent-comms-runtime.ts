import { startAgentCommsSubscriber } from '~/server/agent-comms-subscriber'
import { startPrimitivesReconciler } from '~/server/primitives-reconciler'

export const ensureAgentCommsRuntime = () => {
  void startAgentCommsSubscriber().catch((error) => {
    console.warn('Agent comms subscriber failed to start', error)
  })
  startPrimitivesReconciler()
}

ensureAgentCommsRuntime()
