import {
  submitSignalResourceToAgentsService,
  type AgentsSignalResourceSubmitInput,
} from '@proompteng/agent-contracts/control-plane-resources-client'
import { asRecord, asString } from '~/server/primitives-http'
import { hashNameSuffix, makeHashedName } from '~/server/supporting-primitives-naming'
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
  materialReentryRequirementSignals: MaterialReentryRequirementSignal[]
  namespace: string
  swarmName: string
  existingSignalNames: Set<string>
  existingDedupeKeys?: Set<string>
  submitResource?: (input: AgentsSignalResourceSubmitInput) => Promise<unknown>
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])
export const MATERIAL_REENTRY_DISPATCH_ANNOTATION = 'swarm.proompteng.ai/material-reentry-dispatch'

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
  const byDedupeKey = new Map<string, MaterialReentryRequirementSignal>()
  for (const signal of [...directDispatches, ...receiptDispatches]) {
    if (signal) byDedupeKey.set(signal.dedupeKey, signal)
  }
  return [...byDedupeKey.values()]
}

const materialReentrySignalName = (dispatch: MaterialReentryRequirementSignal) =>
  makeHashedName(`material-reentry-${dispatch.targetSwarm}`, hashNameSuffix(dispatch.dedupeKey))

const materialReentrySignalResource = (
  dispatch: MaterialReentryRequirementSignal,
  namespace: string,
): Record<string, unknown> => {
  const name = materialReentrySignalName(dispatch)
  return {
    apiVersion: 'signals.proompteng.ai/v1alpha1',
    kind: 'Signal',
    metadata: {
      name,
      namespace,
      labels: {
        [SWARM_REQUIREMENT_LABEL_TYPE]: 'requirement',
        [SWARM_REQUIREMENT_LABEL_FROM]: normalizeLabelValue(dispatch.sourceSwarm),
        [SWARM_REQUIREMENT_LABEL_TO]: normalizeLabelValue(dispatch.targetSwarm),
        [SWARM_REQUIREMENT_LABEL_CHANNEL]: 'nats',
        priority: normalizeLabelValue(dispatch.priority),
      },
      annotations: {
        [MATERIAL_REENTRY_DISPATCH_ANNOTATION]: dispatch.dedupeKey,
        'swarm.proompteng.ai/material-reentry-source-signal': dispatch.signalName,
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
  }
}

const summarizePublishError = (error: unknown) => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return String(error)
}

export const publishMaterialReentryRequirementSignals = async (
  input: MaterialReentryRequirementSignalPublisherInput,
) => {
  const publishedSignals: Record<string, unknown>[] = []
  let publishErrors = 0
  const dedupeKeys = new Set(input.existingDedupeKeys ?? [])
  const submitResource = input.submitResource ?? submitSignalResourceToAgentsService
  for (const dispatch of input.materialReentryRequirementSignals) {
    if (dispatch.targetSwarm !== input.swarmName || dispatch.targetStage !== 'implement') continue
    const signalName = materialReentrySignalName(dispatch)
    if (input.existingSignalNames.has(signalName)) continue
    if (dedupeKeys.has(dispatch.dedupeKey)) continue
    const signal = materialReentrySignalResource(dispatch, input.namespace)
    try {
      await submitResource({ deliveryId: dispatch.dedupeKey, resource: signal })
      publishedSignals.push(signal)
      input.existingSignalNames.add(signalName)
      dedupeKeys.add(dispatch.dedupeKey)
    } catch (error) {
      publishErrors += 1
      console.warn('[jangar] failed to publish material reentry requirement signal', {
        swarm: input.swarmName,
        namespace: input.namespace,
        signal: signalName,
        error: summarizePublishError(error),
      })
    }
  }
  return { publishedSignals, publishErrors }
}
