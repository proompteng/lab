import { RESOURCE_MAP } from './kube-types'

export type AgentPrimitiveKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'VersionControlProvider'
  | 'Memory'
  | 'Tool'
  | 'ToolRun'
  | 'ApprovalPolicy'
  | 'Budget'
  | 'Signal'
  | 'SignalDelivery'
  | 'Schedule'
  | 'Swarm'
  | 'Artifact'
  | 'Workspace'
  | 'SecretBinding'
  | 'Orchestration'
  | 'OrchestrationRun'

export type ControlPlaneRuntimeResourceKind = 'Deployment' | 'Job' | 'Pod'

export type ControlPlaneResourceKind = AgentPrimitiveKind | ControlPlaneRuntimeResourceKind

type PrimitiveKindConfig<TKind extends ControlPlaneResourceKind = ControlPlaneResourceKind> = {
  kind: TKind
  resource: string
}

type ListPrimitiveKindsOptions = {
  includeSwarm?: boolean
}

const AGENT_PRIMITIVE_KIND_CONFIG: Array<PrimitiveKindConfig<AgentPrimitiveKind>> = [
  { kind: 'Agent', resource: RESOURCE_MAP.Agent },
  { kind: 'AgentRun', resource: RESOURCE_MAP.AgentRun },
  { kind: 'AgentProvider', resource: RESOURCE_MAP.AgentProvider },
  { kind: 'ImplementationSpec', resource: RESOURCE_MAP.ImplementationSpec },
  { kind: 'ImplementationSource', resource: RESOURCE_MAP.ImplementationSource },
  { kind: 'VersionControlProvider', resource: RESOURCE_MAP.VersionControlProvider },
  { kind: 'Memory', resource: RESOURCE_MAP.Memory },
  { kind: 'Tool', resource: RESOURCE_MAP.Tool },
  { kind: 'ToolRun', resource: RESOURCE_MAP.ToolRun },
  { kind: 'ApprovalPolicy', resource: RESOURCE_MAP.ApprovalPolicy },
  { kind: 'Budget', resource: RESOURCE_MAP.Budget },
  { kind: 'Signal', resource: RESOURCE_MAP.Signal },
  { kind: 'SignalDelivery', resource: RESOURCE_MAP.SignalDelivery },
  { kind: 'Schedule', resource: RESOURCE_MAP.Schedule },
  { kind: 'Swarm', resource: RESOURCE_MAP.Swarm },
  { kind: 'Artifact', resource: RESOURCE_MAP.Artifact },
  { kind: 'Workspace', resource: RESOURCE_MAP.Workspace },
  { kind: 'SecretBinding', resource: RESOURCE_MAP.SecretBinding },
  { kind: 'Orchestration', resource: RESOURCE_MAP.Orchestration },
  { kind: 'OrchestrationRun', resource: RESOURCE_MAP.OrchestrationRun },
]

const RUNTIME_RESOURCE_KIND_CONFIG: Array<PrimitiveKindConfig<ControlPlaneRuntimeResourceKind>> = [
  { kind: 'Deployment', resource: RESOURCE_MAP.Deployment },
  { kind: 'Job', resource: RESOURCE_MAP.Job },
  { kind: 'Pod', resource: RESOURCE_MAP.Pod },
]

const KIND_LOOKUP = new Map(
  [...AGENT_PRIMITIVE_KIND_CONFIG, ...RUNTIME_RESOURCE_KIND_CONFIG].flatMap((entry) => [
    [entry.kind.toLowerCase(), entry],
    [entry.kind.replace(/\s+/g, '').toLowerCase(), entry],
  ]),
)

export function resolvePrimitiveKind(raw: AgentPrimitiveKind): PrimitiveKindConfig<AgentPrimitiveKind> | null
export function resolvePrimitiveKind(raw?: string | null): PrimitiveKindConfig | null
export function resolvePrimitiveKind(raw?: string | null): PrimitiveKindConfig | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return null
  return KIND_LOOKUP.get(normalized) ?? null
}

export const listPrimitiveKinds = (options: ListPrimitiveKindsOptions = {}) =>
  AGENT_PRIMITIVE_KIND_CONFIG.filter((entry) => entry.kind !== 'Swarm' || options.includeSwarm === true).map(
    (entry) => entry.kind,
  )
