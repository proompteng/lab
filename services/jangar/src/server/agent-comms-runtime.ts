import { createControllerStartupRetry } from '@proompteng/agents/server/controller-startup-retry'

import { startAgentCommsSubscriber } from './agent-comms-subscriber'
import { getAgentsControllerHealth, startAgentsController, stopAgentsController } from './agents-controller'
import {
  startControlPlaneHeartbeatPublisher,
  stopControlPlaneHeartbeatPublisher,
} from './control-plane-heartbeat-publisher'
import { ensureLeaderElectionRuntime, isLeaderElectionRequired } from './leader-election'
import {
  getOrchestrationControllerHealth,
  startOrchestrationController,
  stopOrchestrationController,
} from './orchestration-controller'
import { startPrimitivesReconciler, stopPrimitivesReconciler } from './primitives-reconciler'
import {
  getSupportingControllerHealth,
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from './supporting-primitives-controller'

const agentsControllerStartup = createControllerStartupRetry({
  name: 'agents-controller',
  start: startAgentsController,
  isStarted: () => getAgentsControllerHealth().started,
  isEnabled: () => getAgentsControllerHealth().enabled,
  shouldRetry: (error) => !(error instanceof Error && error.name === 'NamespaceScopeConfigError'),
})

const orchestrationControllerStartup = createControllerStartupRetry({
  name: 'orchestration-controller',
  start: startOrchestrationController,
  isStarted: () => getOrchestrationControllerHealth().started,
  isEnabled: () => getOrchestrationControllerHealth().enabled,
})

const supportingControllerStartup = createControllerStartupRetry({
  name: 'supporting-controller',
  start: startSupportingPrimitivesController,
  isStarted: () => getSupportingControllerHealth().started,
  isEnabled: () => getSupportingControllerHealth().enabled,
})

const startControllerRuntimes = () => {
  agentsControllerStartup.start()
  orchestrationControllerStartup.start()
  supportingControllerStartup.start()
}

const stopControllerRuntimes = () => {
  agentsControllerStartup.cancel()
  orchestrationControllerStartup.cancel()
  supportingControllerStartup.cancel()
  stopAgentsController()
  stopOrchestrationController()
  stopSupportingPrimitivesController()
}

export const ensureControllerRuntimes = () => {
  if (!isLeaderElectionRequired()) {
    stopControlPlaneHeartbeatPublisher()
    startControllerRuntimes()
    startPrimitivesReconciler()
    return
  }

  ensureLeaderElectionRuntime({
    onLeader: () => {
      startControllerRuntimes()
      startPrimitivesReconciler()
      startControlPlaneHeartbeatPublisher()
    },
    onFollower: () => {
      stopControlPlaneHeartbeatPublisher()
      stopControllerRuntimes()
      stopPrimitivesReconciler()
    },
  })
}

export const ensureAgentCommsRuntime = () => {
  void startAgentCommsSubscriber().catch((error) => {
    console.warn('Agent comms subscriber failed to start', error)
  })
}
