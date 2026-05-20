import { type AgentsSwarmRequirementSignalSubmitInput, buildSwarmRequirementSignalResource } from './signals-client'
import { asRecord, asString, hashNameSuffix, makeHashedName } from './swarm-analysis'

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

export type MaterialReentryRequirementSignalPlanInput = {
  materialReentryRequirementSignals: MaterialReentryRequirementSignal[]
  namespace: string
  swarmName: string
  existingSignals?: Record<string, unknown>[]
  existingSignalNames?: Set<string>
  existingDedupeKeys?: Set<string>
}

export const MATERIAL_REENTRY_DISPATCH_ANNOTATION = 'swarm.proompteng.ai/material-reentry-dispatch'
export const MATERIAL_REENTRY_SOURCE_SIGNAL_ANNOTATION = 'swarm.proompteng.ai/material-reentry-source-signal'

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
  const byDedupeKey = new Map<string, MaterialReentryRequirementSignal>()
  for (const signal of [...directDispatches, ...receiptDispatches]) {
    if (signal) byDedupeKey.set(signal.dedupeKey, signal)
  }
  return [...byDedupeKey.values()]
}

export const materialReentrySignalName = (dispatch: MaterialReentryRequirementSignal) =>
  makeHashedName(`material-reentry-${dispatch.targetSwarm}`, hashNameSuffix(dispatch.dedupeKey))

export const materialReentrySignalInput = (
  dispatch: MaterialReentryRequirementSignal,
  namespace: string,
): AgentsSwarmRequirementSignalSubmitInput => {
  const name = materialReentrySignalName(dispatch)
  return {
    deliveryId: dispatch.dedupeKey,
    name,
    namespace,
    sourceSwarm: dispatch.sourceSwarm,
    targetSwarm: dispatch.targetSwarm,
    channel: dispatch.channel,
    description: dispatch.description,
    priority: dispatch.priority,
    annotations: {
      [MATERIAL_REENTRY_DISPATCH_ANNOTATION]: dispatch.dedupeKey,
      [MATERIAL_REENTRY_SOURCE_SIGNAL_ANNOTATION]: dispatch.signalName,
    },
    payload: {
      ...dispatch.payload,
      material_reentry_dispatch_dedupe_key: dispatch.dedupeKey,
    },
  }
}

const metadataRecord = (resource: Record<string, unknown>) => asRecord(resource.metadata) ?? {}

const signalName = (resource: Record<string, unknown>) => asString(metadataRecord(resource).name)

const signalDedupeKey = (resource: Record<string, unknown>) =>
  asString(asRecord(metadataRecord(resource).annotations)?.[MATERIAL_REENTRY_DISPATCH_ANNOTATION])

export const planMaterialReentryRequirementSignalInputs = (
  input: MaterialReentryRequirementSignalPlanInput,
): AgentsSwarmRequirementSignalSubmitInput[] => {
  const plannedSignals: AgentsSwarmRequirementSignalSubmitInput[] = []
  const signalNames = new Set(input.existingSignalNames ?? [])
  const dedupeKeys = new Set(input.existingDedupeKeys ?? [])
  for (const existingSignal of input.existingSignals ?? []) {
    const name = signalName(existingSignal)
    if (name) signalNames.add(name)
    const dedupeKey = signalDedupeKey(existingSignal)
    if (dedupeKey) dedupeKeys.add(dedupeKey)
  }

  for (const dispatch of input.materialReentryRequirementSignals) {
    if (dispatch.targetSwarm !== input.swarmName || dispatch.targetStage !== 'implement') continue
    const name = materialReentrySignalName(dispatch)
    if (signalNames.has(name)) continue
    if (dedupeKeys.has(dispatch.dedupeKey)) continue
    const signal = materialReentrySignalInput(dispatch, input.namespace)
    plannedSignals.push(signal)
    signalNames.add(name)
    dedupeKeys.add(dispatch.dedupeKey)
  }

  return plannedSignals
}

export const buildMaterialReentryRequirementSignalResources = (input: MaterialReentryRequirementSignalPlanInput) =>
  planMaterialReentryRequirementSignalInputs(input).map(buildSwarmRequirementSignalResource)
