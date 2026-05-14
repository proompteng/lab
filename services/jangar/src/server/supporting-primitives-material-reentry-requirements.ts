import { asRecord, asString } from '~/server/primitives-http'
import {
  normalizeLabelValue,
  SWARM_REQUIREMENT_LABEL_CHANNEL,
  SWARM_REQUIREMENT_LABEL_FROM,
  SWARM_REQUIREMENT_LABEL_TO,
  SWARM_REQUIREMENT_LABEL_TYPE,
} from '~/server/supporting-primitives-swarm-config'

export type MaterialReentryRequirementSignal = {
  signalName: string
  sourceSwarm: string
  targetSwarm: string
  targetStage: 'implement'
  channel: string
  description: string
  priority: string
  dedupeKey: string
  payload: Record<string, unknown>
}

type MaterialReentryRequirementSignalPublisherInput = {
  kube: { apply: (resource: Record<string, unknown>) => Promise<unknown> }
  materialReentryRequirementSignals: MaterialReentryRequirementSignal[]
  namespace: string
  swarmName: string
  existingSignalNames: Set<string>
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const readMaterialReentryRequirementSignal = (value: unknown): MaterialReentryRequirementSignal | null => {
  const record = asRecord(value)
  if (!record) return null
  if (asString(record.dispatch_kind) !== 'swarm_requirement_signal') return null
  const signalName = asString(record.signal_name)
  const sourceSwarm = asString(record.source_swarm)
  const targetSwarm = asString(record.target_swarm)
  const targetStage = asString(record.target_stage)
  const channel = asString(record.channel)
  const description = asString(record.description)
  const payload = asRecord(record.payload)
  if (
    !signalName ||
    !sourceSwarm ||
    !targetSwarm ||
    targetStage !== 'implement' ||
    !channel ||
    !description ||
    !payload
  ) {
    return null
  }

  return {
    signalName,
    sourceSwarm,
    targetSwarm,
    targetStage,
    channel,
    description,
    priority: asString(record.priority) ?? 'normal',
    dedupeKey: asString(record.dedupe_key) ?? signalName,
    payload,
  }
}

export const readMaterialReentryRequirementSignals = (status: Record<string, unknown>) => {
  const clearinghouse = asRecord(status.material_reentry_clearinghouse)
  if (!clearinghouse) return []
  const directDispatches = asArray(clearinghouse.implementer_dispatches).map(readMaterialReentryRequirementSignal)
  const receiptDispatches = asArray(clearinghouse.action_receipts)
    .map(asRecord)
    .map((receipt) => readMaterialReentryRequirementSignal(receipt?.implementer_dispatch))
  const byName = new Map<string, MaterialReentryRequirementSignal>()
  for (const signal of [...directDispatches, ...receiptDispatches]) {
    if (signal) byName.set(signal.signalName, signal)
  }
  return [...byName.values()]
}

const materialReentrySignalResource = (
  dispatch: MaterialReentryRequirementSignal,
  namespace: string,
): Record<string, unknown> => ({
  apiVersion: 'signals.proompteng.ai/v1alpha1',
  kind: 'Signal',
  metadata: {
    name: dispatch.signalName,
    namespace,
    labels: {
      [SWARM_REQUIREMENT_LABEL_TYPE]: 'requirement',
      [SWARM_REQUIREMENT_LABEL_FROM]: normalizeLabelValue(dispatch.sourceSwarm),
      [SWARM_REQUIREMENT_LABEL_TO]: normalizeLabelValue(dispatch.targetSwarm),
      [SWARM_REQUIREMENT_LABEL_CHANNEL]: 'nats',
      priority: normalizeLabelValue(dispatch.priority),
    },
    annotations: {
      'swarm.proompteng.ai/material-reentry-dispatch': dispatch.dedupeKey,
    },
  },
  spec: {
    channel: dispatch.channel,
    description: dispatch.description,
    priority: dispatch.priority,
    payload: {
      ...dispatch.payload,
      material_reentry_dispatch_dedupe_key: dispatch.dedupeKey,
    },
  },
})

const summarizePublishError = (error: unknown) => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return String(error)
}

export const publishMaterialReentryRequirementSignals = async (
  input: MaterialReentryRequirementSignalPublisherInput,
) => {
  const publishedSignals: Record<string, unknown>[] = []
  let publishErrors = 0
  for (const dispatch of input.materialReentryRequirementSignals) {
    if (dispatch.targetSwarm !== input.swarmName || dispatch.targetStage !== 'implement') continue
    if (input.existingSignalNames.has(dispatch.signalName)) continue
    const signal = materialReentrySignalResource(dispatch, input.namespace)
    try {
      await input.kube.apply(signal)
      publishedSignals.push(signal)
      input.existingSignalNames.add(dispatch.signalName)
    } catch (error) {
      publishErrors += 1
      console.warn('[jangar] failed to publish material reentry requirement signal', {
        swarm: input.swarmName,
        namespace: input.namespace,
        signal: dispatch.signalName,
        error: summarizePublishError(error),
      })
    }
  }
  return { publishedSignals, publishErrors }
}
