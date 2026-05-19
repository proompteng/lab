import { asRecord, asString, readNested } from './primitives'

export const AGENTS_RESOURCE_LABELS = {
  deliveryId: {
    canonical: 'agents.proompteng.ai/delivery-id',
    legacy: 'jangar.proompteng.ai/delivery-id',
  },
  orchestrationRun: {
    canonical: 'agents.proompteng.ai/orchestration-run',
    legacy: 'jangar.proompteng.ai/orchestration-run',
  },
  orchestrationStep: {
    canonical: 'agents.proompteng.ai/orchestration-step',
    legacy: 'jangar.proompteng.ai/orchestration-step',
  },
  toolRun: {
    canonical: 'agents.proompteng.ai/tool-run',
    legacy: 'jangar.proompteng.ai/tool-run',
  },
} as const

type AgentsResourceLabel = keyof typeof AGENTS_RESOURCE_LABELS

const buildCompatibleLabel = (label: AgentsResourceLabel, value: string): Record<string, string> => {
  const keys = AGENTS_RESOURCE_LABELS[label]
  return {
    [keys.canonical]: value,
  }
}

export const buildDeliveryIdLabels = (deliveryId: string): Record<string, string> =>
  buildCompatibleLabel('deliveryId', deliveryId)

export const buildOrchestrationChildLabels = (runName: string, stepName: string): Record<string, string> => ({
  ...buildCompatibleLabel('orchestrationRun', runName),
  ...buildCompatibleLabel('orchestrationStep', stepName),
})

export const buildToolRunJobLabels = (runName: string): Record<string, string> =>
  buildCompatibleLabel('toolRun', runName)

export const readCompatibleLabel = (
  resource: Record<string, unknown>,
  label: AgentsResourceLabel,
): string | undefined => {
  const labels = asRecord(readNested(resource, ['metadata', 'labels']))
  const keys = AGENTS_RESOURCE_LABELS[label]
  return asString(labels?.[keys.canonical]) ?? asString(labels?.[keys.legacy]) ?? undefined
}

export const readDeliveryIdLabel = (resource: Record<string, unknown>) => readCompatibleLabel(resource, 'deliveryId')

export const readOrchestrationRunLabel = (resource: Record<string, unknown>) =>
  readCompatibleLabel(resource, 'orchestrationRun')

export const readToolRunLabel = (resource: Record<string, unknown>) => readCompatibleLabel(resource, 'toolRun')
