export type AgentRunPhaseTone = 'success' | 'danger' | 'warning' | 'neutral'

export type AgentRunConditionSummary = {
  type: string
  status: string
  reason: string
  message: string
  lastTransitionTime: string | null
}

export type AgentRunArtifactSummary = {
  name: string
  key: string | null
  path: string | null
  url: string | null
}

export type AgentRunRuntimeLink = {
  kind: 'Job' | 'Pod' | 'Workflow' | 'Temporal' | 'Runtime'
  name: string
  namespace: string
}

export type AgentRunWorkflowStepSummary = {
  name: string
  phase: string
  attempt: number | null
  startedAt: string | null
  finishedAt: string | null
  nextRetryAt: string | null
  jobRef: AgentRunRuntimeLink | null
  message: string | null
}

export type AgentRunDetailModel = {
  name: string
  namespace: string
  uid: string | null
  generation: number | null
  phase: string
  phaseTone: AgentRunPhaseTone
  reason: string | null
  message: string | null
  agentName: string | null
  providerName: string | null
  implementationSpecName: string | null
  implementationSource: string | null
  inlineImplementationSummary: string | null
  runtimeType: string | null
  runtimeRef: AgentRunRuntimeLink | null
  resourceLinks: AgentRunRuntimeLink[]
  vcs: {
    provider: string | null
    repository: string | null
    baseBranch: string | null
    headBranch: string | null
    mode: string | null
  }
  createdAt: string | null
  startedAt: string | null
  completedAt: string | null
  updatedAt: string | null
  age: string
  duration: string | null
  attemptSummary: string | null
  artifacts: AgentRunArtifactSummary[]
  artifactSummary: string
  conditions: AgentRunConditionSummary[]
  workflowSteps: AgentRunWorkflowStepSummary[]
  statusSummary: string
}

const terminalPhases = new Set(['Succeeded', 'Failed', 'Cancelled'])
const failurePhases = new Set(['Failed', 'Error'])
const pendingPhases = new Set(['Pending', 'Queued', 'Accepted', 'Blocked'])
const runningPhases = new Set(['Running', 'Reconciling', 'Progressing'])

export const isAgentRunDetailKind = (kind: string | null | undefined) => {
  const normalized = kind?.trim().toLowerCase()
  return normalized === 'agent-run' || normalized === 'agentrun' || normalized === 'agentruns'
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const refName = (value: unknown) => asString(asRecord(value)?.name)

const readSource = (source: Record<string, unknown> | null) => {
  if (!source) return null
  const provider = asString(source.provider)
  const externalId = asString(source.externalId)
  const url = asString(source.url)
  return [provider, externalId || url].filter(Boolean).join(' · ') || null
}

const readImplementationSource = (spec: Record<string, unknown>) => {
  const inline = asRecord(asRecord(spec.implementation)?.inline)
  const source = readSource(asRecord(inline?.source))
  const summary = asString(inline?.summary) ?? asString(inline?.description)
  return { source, summary }
}

const readPhase = (status: Record<string, unknown>) => {
  const explicit = asString(status.phase)
  if (explicit) return explicit
  const conditions = asArray(status.conditions)
    .map((entry) => asRecord(entry))
    .filter(Boolean)
  if (conditions.some((condition) => condition?.type === 'Succeeded' && condition.status === 'True')) return 'Succeeded'
  if (conditions.some((condition) => condition?.type === 'Failed' && condition.status === 'True')) return 'Failed'
  if (conditions.some((condition) => condition?.type === 'Progressing' && condition.status === 'True')) return 'Running'
  return 'Unknown'
}

export const phaseTone = (phase: string): AgentRunPhaseTone => {
  if (phase === 'Succeeded') return 'success'
  if (failurePhases.has(phase)) return 'danger'
  if (pendingPhases.has(phase)) return 'warning'
  return runningPhases.has(phase) ? 'neutral' : 'neutral'
}

export const badgeVariantForPhase = (phase: string): 'secondary' | 'destructive' | 'outline' => {
  if (phase === 'Succeeded') return 'secondary'
  if (failurePhases.has(phase)) return 'destructive'
  return 'outline'
}

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export const formatRelativeAge = (value: string | null | undefined, now = Date.now()) => {
  if (!value) return '-'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '-'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const durationBetween = (startedAt: string | null, completedAt: string | null) => {
  if (!startedAt || !completedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return formatDuration(end - start)
}

const readConditions = (status: Record<string, unknown>): AgentRunConditionSummary[] =>
  asArray(status.conditions)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((condition) => ({
      type: asString(condition.type) ?? 'Unknown',
      status: asString(condition.status) ?? 'Unknown',
      reason: asString(condition.reason) ?? '-',
      message: asString(condition.message) ?? '',
      lastTransitionTime: asString(condition.lastTransitionTime),
    }))

const readArtifacts = (status: Record<string, unknown>): AgentRunArtifactSummary[] =>
  asArray(status.artifacts)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((artifact) => ({
      name: asString(artifact.name) ?? 'artifact',
      key: asString(artifact.key),
      path: asString(artifact.path),
      url: asString(artifact.url),
    }))

const runtimeKind = (type: string | null | undefined): AgentRunRuntimeLink['kind'] => {
  if (type === 'job') return 'Job'
  if (type === 'workflow') return 'Workflow'
  if (type === 'temporal') return 'Temporal'
  return 'Runtime'
}

const readRuntimeRef = (status: Record<string, unknown>, namespace: string): AgentRunRuntimeLink | null => {
  const runtimeRef = asRecord(status.runtimeRef)
  const name = asString(runtimeRef?.name) ?? asString(runtimeRef?.workflowId)
  if (!name) return null
  const type = asString(runtimeRef?.type)
  return {
    kind: runtimeKind(type),
    name,
    namespace: asString(runtimeRef?.namespace) ?? namespace,
  }
}

const readJobRef = (value: unknown, namespace: string): AgentRunRuntimeLink | null => {
  const ref = asRecord(value)
  const name = asString(ref?.name)
  if (!name) return null
  return { kind: 'Job', name, namespace: asString(ref?.namespace) ?? namespace }
}

const readWorkflowSteps = (status: Record<string, unknown>, namespace: string): AgentRunWorkflowStepSummary[] => {
  const workflow = asRecord(status.workflow)
  return asArray(workflow?.steps)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((step) => ({
      name: asString(step.name) ?? 'step',
      phase: asString(step.phase) ?? 'Unknown',
      attempt: asNumber(step.attempt),
      startedAt: asString(step.startedAt),
      finishedAt: asString(step.finishedAt),
      nextRetryAt: asString(step.nextRetryAt),
      jobRef: readJobRef(step.jobRef, namespace),
      message: asString(step.message),
    }))
}

const resourceLinksFrom = (runtimeRef: AgentRunRuntimeLink | null, workflowSteps: AgentRunWorkflowStepSummary[]) => {
  const links = new Map<string, AgentRunRuntimeLink>()
  const add = (link: AgentRunRuntimeLink | null) => {
    if (!link) return
    links.set(`${link.kind}/${link.namespace}/${link.name}`, link)
  }
  add(runtimeRef)
  workflowSteps.forEach((step) => add(step.jobRef))
  return [...links.values()]
}

const readAttemptSummary = (status: Record<string, unknown>, workflowSteps: AgentRunWorkflowStepSummary[]) => {
  const directAttempt = asNumber(status.attempt) ?? asNumber(asRecord(status.runner)?.attempt)
  if (directAttempt !== null) return `Attempt ${directAttempt}`
  const attempts = workflowSteps.map((step) => step.attempt).filter((attempt): attempt is number => attempt !== null)
  if (attempts.length === 0) return null
  const maxAttempt = Math.max(...attempts)
  const retrying = workflowSteps.filter((step) => step.nextRetryAt).length
  return retrying > 0 ? `Max attempt ${maxAttempt}; ${retrying} retry scheduled` : `Max attempt ${maxAttempt}`
}

const artifactSummary = (artifacts: AgentRunArtifactSummary[]) => {
  if (artifacts.length === 0) return 'No artifacts reported'
  const linked = artifacts.filter((artifact) => artifact.url || artifact.key || artifact.path).length
  return `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}${linked > 0 ? `, ${linked} with location` : ''}`
}

const statusSummary = (phase: string, reason: string | null, message: string | null) => {
  if (message) return message
  if (reason) return reason
  if (phase === 'Unknown') return 'The controller has not reported a phase yet.'
  if (terminalPhases.has(phase)) return `AgentRun ${phase.toLowerCase()}.`
  return `AgentRun is ${phase.toLowerCase()}.`
}

export const extractAgentRunDetail = (resource: Record<string, unknown>, now = Date.now()): AgentRunDetailModel => {
  const metadata = asRecord(resource.metadata) ?? {}
  const spec = asRecord(resource.spec) ?? {}
  const status = asRecord(resource.status) ?? {}
  const namespace = asString(metadata.namespace) ?? 'agents'
  const name = asString(metadata.name) ?? 'unknown'
  const phase = readPhase(status)
  const startedAt = asString(status.startedAt)
  const completedAt = asString(status.finishedAt)
  const workflowSteps = readWorkflowSteps(status, namespace)
  const runtimeRef = readRuntimeRef(status, namespace)
  const artifacts = readArtifacts(status)
  const implementation = readImplementationSource(spec)
  const vcs = asRecord(status.vcs) ?? asRecord(spec.vcsPolicy) ?? {}
  const conditions = readConditions(status)
  const runner = asRecord(status.runner)

  return {
    name,
    namespace,
    uid: asString(metadata.uid),
    generation: asNumber(metadata.generation),
    phase,
    phaseTone: phaseTone(phase),
    reason: asString(status.reason),
    message: asString(status.message),
    agentName: refName(spec.agentRef),
    providerName: asString(runner?.provider) ?? asString(vcs.provider),
    implementationSpecName: refName(spec.implementationSpecRef),
    implementationSource: implementation.source,
    inlineImplementationSummary: implementation.summary,
    runtimeType: asString(asRecord(spec.runtime)?.type) ?? asString(asRecord(status.runtimeRef)?.type),
    runtimeRef,
    resourceLinks: resourceLinksFrom(runtimeRef, workflowSteps),
    vcs: {
      provider: asString(vcs.provider),
      repository: asString(vcs.repository),
      baseBranch: asString(vcs.baseBranch),
      headBranch: asString(vcs.headBranch),
      mode: asString(vcs.mode),
    },
    createdAt: asString(metadata.creationTimestamp),
    startedAt,
    completedAt,
    updatedAt: asString(status.updatedAt),
    age: formatRelativeAge(asString(metadata.creationTimestamp), now),
    duration: durationBetween(startedAt, completedAt),
    attemptSummary: readAttemptSummary(status, workflowSteps),
    artifacts,
    artifactSummary: artifactSummary(artifacts),
    conditions,
    workflowSteps,
    statusSummary: statusSummary(phase, asString(status.reason), asString(status.message)),
  }
}
