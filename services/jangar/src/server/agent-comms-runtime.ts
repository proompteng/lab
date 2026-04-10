import { startAgentCommsSubscriber } from './agent-comms-subscriber'
import { startAgentsController, stopAgentsController } from './agents-controller'
import {
  startControlPlaneHeartbeatPublisher,
  stopControlPlaneHeartbeatPublisher,
} from './control-plane-heartbeat-publisher'
import { ensureLeaderElectionRuntime, isLeaderElectionRequired } from './leader-election'
import { startOrchestrationController, stopOrchestrationController } from './orchestration-controller'
import { startPrimitivesReconciler, stopPrimitivesReconciler } from './primitives-reconciler'
import {
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from './supporting-primitives-controller'

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
