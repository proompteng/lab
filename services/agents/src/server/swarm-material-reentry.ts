import {
  buildMaterialReentryRequirementSignalResources,
  readMaterialReentryRequirementSignals,
} from '@proompteng/agent-contracts/swarm-material-reentry'

import { RESOURCE_MAP, type KubernetesClient } from './kube-types'
import { asRecord, asString } from './primitives'

export type SwarmMaterialReentryReconcileResult = {
  plannedSignals: Record<string, unknown>[]
  appliedSignals: Record<string, unknown>[]
  applyErrors: number
}

const emptyResult = (): SwarmMaterialReentryReconcileResult => ({
  plannedSignals: [],
  appliedSignals: [],
  applyErrors: 0,
})

const listItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const summarizeError = (error: unknown) => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return String(error)
}

export const reconcileMaterialReentryRequirementSignals = async (
  kube: KubernetesClient,
  swarm: Record<string, unknown>,
  namespace: string,
): Promise<SwarmMaterialReentryReconcileResult> => {
  const swarmName = asString(asRecord(swarm.metadata)?.name)
  if (!swarmName) return emptyResult()

  const status = asRecord(swarm.status) ?? {}
  const materialReentryRequirementSignals = readMaterialReentryRequirementSignals(status)
  if (materialReentryRequirementSignals.length === 0) return emptyResult()

  const existingSignals = listItems(await kube.list(RESOURCE_MAP.Signal, namespace))
  const plannedSignals = buildMaterialReentryRequirementSignalResources({
    namespace,
    swarmName,
    existingSignals,
    materialReentryRequirementSignals,
  })
  const appliedSignals: Record<string, unknown>[] = []
  let applyErrors = 0

  for (const signal of plannedSignals) {
    try {
      const applied = await kube.apply(signal)
      appliedSignals.push(applied)
    } catch (error) {
      applyErrors += 1
      console.warn('[agents] failed to publish material reentry requirement signal', {
        namespace,
        swarm: swarmName,
        signal: asString(asRecord(signal.metadata)?.name) ?? 'unknown',
        error: summarizeError(error),
      })
    }
  }

  return { plannedSignals, appliedSignals, applyErrors }
}
