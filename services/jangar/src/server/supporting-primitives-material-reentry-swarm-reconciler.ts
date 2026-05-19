import { fetchControlPlaneResourcesFromAgentsService } from '~/server/agents-service-proxy'
import { resolveSupportingPrimitivesConfig } from '~/server/supporting-primitives-config'

export const MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS = 30_000

type SwarmEventHandler = (namespace: string, event: { type?: string; object?: Record<string, unknown> }) => void
type SwarmLister = (namespace: string) => Promise<Record<string, unknown>[]>

type MaterialReentrySwarmReconcileInput = {
  canReconcile: () => boolean
  listSwarms?: SwarmLister
  namespaces: string[]
  queueResourceTask: (namespace: string, key: string, task: () => Promise<void>) => void
  reconcileSwarm: (swarm: Record<string, unknown>, namespace: string) => Promise<void>
}

let materialReentrySwarmReconcileHandle: NodeJS.Timeout | null = null

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const listSwarmsFromAgentsService: SwarmLister = async (namespace) => {
  const result = await fetchControlPlaneResourcesFromAgentsService({ kind: 'Swarm', namespace, limit: 500 })
  if (!result.ok) {
    throw new Error(`Agents service Swarm resource list failed (${result.status}): ${result.error ?? 'unknown error'}`)
  }
  return listItems(result.body)
}

const queueMaterialReentrySwarmReconciles = (input: MaterialReentrySwarmReconcileInput) => {
  if (!input.canReconcile()) return
  const listSwarms = input.listSwarms ?? listSwarmsFromAgentsService
  for (const namespace of input.namespaces) {
    input.queueResourceTask(namespace, `${namespace}/Swarm/material-reentry-scan`, async () => {
      const swarms = await listSwarms(namespace)
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
  options: { listSwarms?: SwarmLister; intervalMs?: number } = {},
) => {
  const listSwarms = options.listSwarms ?? listSwarmsFromAgentsService
  const intervalMs = Math.max(5_000, Math.trunc(options.intervalMs ?? MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS))
  for (const namespace of namespaces) {
    const scan = async () => {
      try {
        const swarms = await listSwarms(namespace)
        for (const swarm of swarms) {
          onEvent(namespace, { type: 'SYNC', object: swarm })
        }
      } catch (error) {
        console.warn('[jangar] swarm Agents service poll failed', error)
      }
    }
    void scan()
    const interval = setInterval(() => void scan(), intervalMs)
    const maybeNodeInterval = interval as ReturnType<typeof setInterval> & { unref?: () => void }
    maybeNodeInterval.unref?.()
    handles.push({ stop: () => clearInterval(interval) })
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
