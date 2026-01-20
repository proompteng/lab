import { RESOURCE_MAP } from '~/server/primitives-kube'

export type AgentPrimitiveKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'Memory'
  | 'ApprovalPolicy'
  | 'Budget'
  | 'SecretBinding'
  | 'Signal'
  | 'SignalDelivery'
  | 'Schedule'
  | 'Artifact'
  | 'Workspace'

type PrimitiveKindConfig = {
  kind: AgentPrimitiveKind
  resource: string
}

const PRIMITIVE_KIND_CONFIG: PrimitiveKindConfig[] = [
  { kind: 'Agent', resource: RESOURCE_MAP.Agent },
  { kind: 'AgentRun', resource: RESOURCE_MAP.AgentRun },
  { kind: 'AgentProvider', resource: RESOURCE_MAP.AgentProvider },
  { kind: 'ImplementationSpec', resource: RESOURCE_MAP.ImplementationSpec },
  { kind: 'ImplementationSource', resource: RESOURCE_MAP.ImplementationSource },
  { kind: 'Memory', resource: RESOURCE_MAP.Memory },
  { kind: 'ApprovalPolicy', resource: RESOURCE_MAP.ApprovalPolicy },
  { kind: 'Budget', resource: RESOURCE_MAP.Budget },
  { kind: 'SecretBinding', resource: RESOURCE_MAP.SecretBinding },
  { kind: 'Signal', resource: RESOURCE_MAP.Signal },
  { kind: 'SignalDelivery', resource: RESOURCE_MAP.SignalDelivery },
  { kind: 'Schedule', resource: RESOURCE_MAP.Schedule },
  { kind: 'Artifact', resource: RESOURCE_MAP.Artifact },
  { kind: 'Workspace', resource: RESOURCE_MAP.Workspace },
]

const KIND_LOOKUP = new Map(
  PRIMITIVE_KIND_CONFIG.flatMap((entry) => [
    [entry.kind.toLowerCase(), entry],
    [entry.kind.replace(/\s+/g, '').toLowerCase(), entry],
  ]),
)

export const resolvePrimitiveKind = (raw?: string | null) => {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return null
  return KIND_LOOKUP.get(normalized) ?? null
}

export const listPrimitiveKinds = () => PRIMITIVE_KIND_CONFIG.map((entry) => entry.kind)
