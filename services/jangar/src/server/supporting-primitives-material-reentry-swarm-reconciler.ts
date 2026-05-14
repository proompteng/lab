import { startResourceWatch } from '~/server/kube-watch'
import type { KubernetesClient } from '~/server/primitives-kube'
import { RESOURCE_MAP } from '~/server/primitives-kube'
import { resolveSupportingPrimitivesConfig } from '~/server/supporting-primitives-config'

export const MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS = 30_000

type SwarmEventHandler = (namespace: string, event: { type?: string; object?: Record<string, unknown> }) => void

type MaterialReentrySwarmReconcileInput = {
  canReconcile: () => boolean
  kube: Pick<KubernetesClient, 'list'>
  namespaces: string[]
  queueResourceTask: (namespace: string, key: string, task: () => Promise<void>) => void
  reconcileSwarm: (swarm: Record<string, unknown>, namespace: string) => Promise<void>
}

let materialReentrySwarmReconcileHandle: NodeJS.Timeout | null = null

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const queueMaterialReentrySwarmReconciles = (input: MaterialReentrySwarmReconcileInput) => {
  if (!input.canReconcile()) return
  for (const namespace of input.namespaces) {
    input.queueResourceTask(namespace, `${namespace}/Swarm/material-reentry-scan`, async () => {
      const swarms = listItems(await input.kube.list(RESOURCE_MAP.Swarm, namespace))
      for (const swarm of swarms) {
        await input.reconcileSwarm(swarm, namespace)
      }
    })
  }
}

export const startSwarmWatchers = (
  namespaces: string[],
  handles: Array<{ stop: () => void }>,
  onEvent: SwarmEventHandler,
) => {
  for (const namespace of namespaces) {
    handles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.Swarm,
        namespace,
        onEvent: (event) => onEvent(namespace, event),
        onError: (error) => console.warn('[jangar] swarm watch failed', error),
      }),
    )
  }
}

export const startMaterialReentrySwarmReconcileLoop = (input: MaterialReentrySwarmReconcileInput) => {
  stopMaterialReentrySwarmReconcileLoop()
  const config = resolveSupportingPrimitivesConfig(process.env)
  if (!config.materialReentryRequirementSignals) return

  materialReentrySwarmReconcileHandle = setInterval(() => {
    queueMaterialReentrySwarmReconciles(input)
  }, MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS)
}

export const stopMaterialReentrySwarmReconcileLoop = () => {
  if (!materialReentrySwarmReconcileHandle) return
  clearInterval(materialReentrySwarmReconcileHandle)
  materialReentrySwarmReconcileHandle = null
}
