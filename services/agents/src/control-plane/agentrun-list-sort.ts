import type { PrimitiveResourceSummary } from './api-client'

type JsonObject = Record<string, unknown>

export const agentRunSortKeys = ['name', 'phase', 'agent', 'source', 'namespace', 'createdAt'] as const
export type AgentRunSortKey = (typeof agentRunSortKeys)[number]
export type AgentRunSortDirection = 'asc' | 'desc'

export type AgentRunListSearchState = {
  sort?: AgentRunSortKey
  direction?: AgentRunSortDirection
  namespace?: string
  phase?: string
  status?: string
  runtime?: string
  labelSelector?: string
  label_selector?: string
  limit?: number
  page?: number
  search?: string
  q?: string
}

export const defaultAgentRunSort = {
  sort: 'createdAt' as AgentRunSortKey,
  direction: 'desc' as AgentRunSortDirection,
}

const asRecord = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}

const stringValue = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const optionalString = (value: unknown) => {
  const string = stringValue(value)
  return string.length > 0 ? string : undefined
}

const parseNumber = (value: unknown) => {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
}

const parseSortKey = (value: unknown): AgentRunSortKey => {
  const sort = stringValue(value)
  if (sort === 'status') return 'phase'
  if (sort === 'age' || sort === 'creationTimestamp') return 'createdAt'
  if (sort === 'implementation' || sort === 'implementationSpec') return 'source'
  return agentRunSortKeys.includes(sort as AgentRunSortKey) ? (sort as AgentRunSortKey) : defaultAgentRunSort.sort
}

const parseDirection = (value: unknown): AgentRunSortDirection => {
  const direction = stringValue(value).toLowerCase()
  return direction === 'asc' || direction === 'desc' ? direction : defaultAgentRunSort.direction
}

export const parseAgentRunListSearch = (search: Record<string, unknown>): AgentRunListSearchState => ({
  sort: parseSortKey(search.sort),
  direction: parseDirection(search.direction),
  namespace: optionalString(search.namespace),
  phase: optionalString(search.phase),
  status: optionalString(search.status),
  runtime: optionalString(search.runtime),
  labelSelector: optionalString(search.labelSelector),
  label_selector: optionalString(search.label_selector),
  limit: parseNumber(search.limit),
  page: parseNumber(search.page),
  search: optionalString(search.search),
  q: optionalString(search.q),
})

export const nextAgentRunSortSearch = (
  current: AgentRunListSearchState,
  sort: AgentRunSortKey,
): AgentRunListSearchState => ({
  ...current,
  sort,
  direction: current.sort === sort && (current.direction ?? defaultAgentRunSort.direction) === 'asc' ? 'desc' : 'asc',
})

export const resourceName = (resource: PrimitiveResourceSummary) => stringValue(resource.metadata.name)

export const resourceNamespace = (resource: PrimitiveResourceSummary) =>
  stringValue(resource.metadata.namespace) || 'agents'

export const resourceCreationTimestamp = (resource: PrimitiveResourceSummary) =>
  stringValue(resource.metadata.creationTimestamp)

export const resourcePhase = (resource: PrimitiveResourceSummary) =>
  stringValue(resource.status.phase) || stringValue(resource.status.status)

export const agentRunAgentName = (resource: PrimitiveResourceSummary) => {
  const spec = asRecord(resource.spec)
  const agentRef = asRecord(spec.agentRef)
  return stringValue(agentRef.name)
}

export const agentRunImplementationSource = (resource: PrimitiveResourceSummary) => {
  const spec = asRecord(resource.spec)
  const implementationSpecRef = asRecord(spec.implementationSpecRef)
  const implementationSpecName = stringValue(implementationSpecRef.name)
  if (implementationSpecName) return implementationSpecName

  const implementation = asRecord(spec.implementation)
  const inline = asRecord(implementation.inline)
  const source = asRecord(inline.source)
  const provider = stringValue(source.provider)
  const externalId = stringValue(source.externalId)
  const url = stringValue(source.url)
  const summary = stringValue(inline.summary)

  if (provider && externalId) return `${provider}:${externalId}`
  if (provider && url) return `${provider}:${url}`
  if (provider) return provider
  if (summary) return `inline:${summary}`
  return inline && Object.keys(inline).length > 0 ? 'inline' : ''
}

export const formatAgentRunImplementationSource = (resource: PrimitiveResourceSummary) => {
  const spec = asRecord(resource.spec)
  const implementationSpecRef = asRecord(spec.implementationSpecRef)
  const implementationSpecName = stringValue(implementationSpecRef.name)
  if (implementationSpecName) return implementationSpecName

  const implementation = asRecord(spec.implementation)
  const inline = asRecord(implementation.inline)
  const source = asRecord(inline.source)
  const provider = stringValue(source.provider)
  const externalId = stringValue(source.externalId)
  const url = stringValue(source.url)

  if (provider && externalId) return `${provider} / ${externalId}`
  if (provider && url) return `${provider} / ${url}`
  if (provider) return provider
  return inline && Object.keys(inline).length > 0 ? 'inline' : ''
}

const sortValue = (resource: PrimitiveResourceSummary, sort: AgentRunSortKey) => {
  switch (sort) {
    case 'name':
      return resourceName(resource)
    case 'phase':
      return resourcePhase(resource)
    case 'agent':
      return agentRunAgentName(resource)
    case 'source':
      return agentRunImplementationSource(resource)
    case 'namespace':
      return resourceNamespace(resource)
    case 'createdAt':
      return resourceCreationTimestamp(resource)
  }
}

const timestampValue = (value: string) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const compareStrings = (left: string, right: string, direction: AgentRunSortDirection) => {
  const leftMissing = left.length === 0
  const rightMissing = right.length === 0
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1
  const compared = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  return direction === 'asc' ? compared : -compared
}

const compareTimestamps = (left: string, right: string, direction: AgentRunSortDirection) => {
  const leftTimestamp = timestampValue(left)
  const rightTimestamp = timestampValue(right)
  if (leftTimestamp === null && rightTimestamp === null) return 0
  if (leftTimestamp === null) return 1
  if (rightTimestamp === null) return -1
  const compared = leftTimestamp - rightTimestamp
  return direction === 'asc' ? compared : -compared
}

const compareBy = (
  left: PrimitiveResourceSummary,
  right: PrimitiveResourceSummary,
  sort: AgentRunSortKey,
  direction: AgentRunSortDirection,
) => {
  const leftValue = sortValue(left, sort)
  const rightValue = sortValue(right, sort)
  return sort === 'createdAt'
    ? compareTimestamps(leftValue, rightValue, direction)
    : compareStrings(leftValue, rightValue, direction)
}

const deterministicTieBreak = (left: PrimitiveResourceSummary, right: PrimitiveResourceSummary) =>
  compareTimestamps(resourceCreationTimestamp(left), resourceCreationTimestamp(right), 'desc') ||
  compareStrings(resourceNamespace(left), resourceNamespace(right), 'asc') ||
  compareStrings(resourceName(left), resourceName(right), 'asc')

export const sortAgentRunResources = (
  resources: PrimitiveResourceSummary[],
  sort: AgentRunSortKey = defaultAgentRunSort.sort,
  direction: AgentRunSortDirection = defaultAgentRunSort.direction,
) => [...resources].sort((left, right) => compareBy(left, right, sort, direction) || deterministicTieBreak(left, right))
