import { startAgentCommsSubscriber } from '~/server/agent-comms-subscriber'
import { startAgentsController, stopAgentsController } from '~/server/agents-controller'
import {
  startControlPlaneHeartbeatPublisher,
  stopControlPlaneHeartbeatPublisher,
} from '~/server/control-plane-heartbeat-publisher'
import { ensureLeaderElectionRuntime, isLeaderElectionRequired } from '~/server/leader-election'
import { startOrchestrationController, stopOrchestrationController } from '~/server/orchestration-controller'
import { startPrimitivesReconciler, stopPrimitivesReconciler } from '~/server/primitives-reconciler'
import {
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from '~/server/supporting-primitives-controller'

export const ensureAgentCommsRuntime = () => {
  void startAgentCommsSubscriber().catch((error) => {
    console.warn('Agent comms subscriber failed to start', error)
  })

  if (!isLeaderElectionRequired()) {
    stopControlPlaneHeartbeatPublisher()
    void startAgentsController()
    void startOrchestrationController()
    void startSupportingPrimitivesController()
    startPrimitivesReconciler()
    return
  }

  ensureLeaderElectionRuntime({
    onLeader: () => {
      void startAgentsController()
      void startOrchestrationController()
      void startSupportingPrimitivesController()
      startPrimitivesReconciler()
      startControlPlaneHeartbeatPublisher()
    },
    onFollower: () => {
      stopControlPlaneHeartbeatPublisher()
      stopAgentsController()
      stopOrchestrationController()
      stopSupportingPrimitivesController()
      stopPrimitivesReconciler()
    },
  })
}
