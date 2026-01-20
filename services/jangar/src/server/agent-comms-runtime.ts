import { startAgentCommsSubscriber } from '~/server/agent-comms-subscriber'
import { startAgentsController } from '~/server/agents-controller'
import { startPrimitivesReconciler } from '~/server/primitives-reconciler'
import { startSupportingPrimitivesController } from '~/server/supporting-primitives-controller'

export const ensureAgentCommsRuntime = () => {
  void startAgentCommsSubscriber().catch((error) => {
    console.warn('Agent comms subscriber failed to start', error)
  })
  void startAgentsController()
  startPrimitivesReconciler()
  void startSupportingPrimitivesController()
}

ensureAgentCommsRuntime()
