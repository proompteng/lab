import {
  createResourceWatchStarter,
  resetKubectlWatchCompatibilityCacheForTests,
  type WatchHandle,
  type WatchOptions,
} from '@proompteng/agents/server/kube-watch'

import {
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from './control-plane-watch-reliability'
import { startKubernetesWatch } from './kubernetes-watch-client'
import { recordKubeWatchError, recordKubeWatchEvent, recordKubeWatchRestart } from './metrics'
import { buildKubernetesResourceCollectionPath, getNativeKubeClients } from './primitives-kube'

export { resetKubectlWatchCompatibilityCacheForTests }
export type { WatchHandle, WatchOptions }

export const startResourceWatch = createResourceWatchStarter({
  buildWatchPath: buildKubernetesResourceCollectionPath,
  defaultLogPrefix: '[jangar][watch]',
  getKubeConfig: () => getNativeKubeClients().kubeConfig,
  recordError: (labels) => {
    recordKubeWatchError(labels)
    recordWatchReliabilityError(labels)
  },
  recordEvent: (labels) => {
    recordKubeWatchEvent(labels)
    recordWatchReliabilityEvent({
      resource: labels.resource,
      namespace: labels.namespace,
    })
  },
  recordRestart: (labels) => {
    recordKubeWatchRestart(labels)
    recordWatchReliabilityRestart(labels)
  },
  startKubernetesWatch,
})
