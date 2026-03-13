import { SymphonyError } from './errors'
import type { Issue, SymphonyConfig } from './types'
import { normalizeState, parseIsoTimestamp } from './utils'

const PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 30_000

type GraphqlResponse = {
  data?: Record<string, unknown>
  errors?: unknown
}

type IssueTrackerClient = {
  fetchCandidateIssues: () => Promise<Issue[]>
  fetchIssuesByStates: (states: string[]) => Promise<Issue[]>
  fetchIssueStatesByIds: (issueIds: string[]) => Promise<Issue[]>
  executeLinearGraphql: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const singleOperationPattern = /\b(query|mutation|subscription)\b/g

const readText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const normalizePriority = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : null

const normalizeLabels = (value: unknown): string[] => {
  const nodes = Array.isArray((value as { nodes?: unknown } | null | undefined)?.nodes)
    ? ((value as { nodes: Array<Record<string, unknown>> }).nodes ?? [])
    : []
  return nodes
    .map((entry) => (typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : ''))
    .filter((entry) => entry.length > 0)
}

const normalizeBlockedBy = (value: unknown) => {
  const nodes = Array.isArray((value as { nodes?: unknown } | null | undefined)?.nodes)
    ? ((value as { nodes: Array<Record<string, unknown>> }).nodes ?? [])
    : []
  return nodes
    .filter((entry) => normalizeState(typeof entry.type === 'string' ? entry.type : null) === 'blocks')
    .map((entry) => {
      const blocker = (entry.issue ?? entry.sourceIssue ?? null) as Record<string, unknown> | null
      const blockerState = (blocker?.state ?? null) as Record<string, unknown> | null
      return {
        id: typeof blocker?.id === 'string' ? blocker.id : null,
        identifier: typeof blocker?.identifier === 'string' ? blocker.identifier : null,
        state: typeof blockerState?.name === 'string' ? blockerState.name : null,
      }
    })
}

const normalizeIssue = (node: Record<string, unknown>): Issue => {
  const statePayload = (node.state ?? null) as Record<string, unknown> | null
  return {
    id: readText(node.id) ?? '',
    identifier: readText(node.identifier) ?? '',
    title: readText(node.title) ?? '',
    description: readText(node.description),
    priority: normalizePriority(node.priority),
    state: readText(statePayload?.name) ?? '',
    branchName: readText(node.branchName),
    url: readText(node.url),
    labels: normalizeLabels(node.labels),
    blockedBy: normalizeBlockedBy(node.inverseRelations),
    createdAt: parseIsoTimestamp(node.createdAt),
    updatedAt: parseIsoTimestamp(node.updatedAt),
  }
}

const validateOperationCount = (query: string): void => {
  const matches = query.match(singleOperationPattern) ?? []
  if (matches.length > 1) {
    throw new SymphonyError(
      'linear_graphql_invalid_input',
      'linear_graphql accepts exactly one GraphQL operation per call',
    )
  }
}

const requestGraphql = async (
  config: SymphonyConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(config.tracker.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: config.tracker.apiKey ?? '',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new SymphonyError('linear_api_status', `Linear API returned ${response.status}`, body)
    }

    const payload = (await response.json()) as GraphqlResponse
    if (payload.errors) {
      throw new SymphonyError('linear_graphql_errors', 'Linear GraphQL request returned errors', payload.errors)
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new SymphonyError(
        'linear_unknown_payload',
        'Linear GraphQL response did not include a data object',
        payload,
      )
    }

    return payload.data
  } catch (error) {
    if (error instanceof SymphonyError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SymphonyError('linear_api_request', `Linear API request timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw new SymphonyError('linear_api_request', 'Linear API request failed', error)
  } finally {
    clearTimeout(timeout)
  }
}

const collectIssuePage = (
  payload: Record<string, unknown>,
): { nodes: Record<string, unknown>[]; hasNextPage: boolean; endCursor: string | null } => {
  const issues = (payload.issues ?? null) as Record<string, unknown> | null
  const nodes = Array.isArray(issues?.nodes) ? (issues?.nodes as Record<string, unknown>[]) : []
  const pageInfo = (issues?.pageInfo ?? null) as Record<string, unknown> | null
  const hasNextPage = Boolean(pageInfo?.hasNextPage)
  const endCursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
  if (hasNextPage && !endCursor) {
    throw new SymphonyError(
      'linear_missing_end_cursor',
      'Linear pagination reported hasNextPage=true without endCursor',
    )
  }
  return { nodes, hasNextPage, endCursor }
}

const issueSelection = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      issue {
        id
        identifier
        state { name }
      }
    }
  }
`

export const createLinearTrackerClient = async (
  configProvider: () => Promise<SymphonyConfig>,
): Promise<IssueTrackerClient> => {
  const fetchIssuesByFilter = async (stateNames: string[], options?: { issueIds?: string[] }): Promise<Issue[]> => {
    if (stateNames.length === 0) return []
    const config = await configProvider()

    const query = `
      query SymphonyIssues($projectSlug: String!, $stateNames: [String!], $after: String, $issueIds: [ID!]) {
        issues(
          first: ${PAGE_SIZE},
          after: $after,
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $stateNames } }
            id: { in: $issueIds }
          }
        ) {
          nodes {
            ${issueSelection}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `

    const issues: Issue[] = []
    let cursor: string | null = null
    let hasNextPage = true

    while (hasNextPage) {
      const data = await requestGraphql(config, query, {
        projectSlug: config.tracker.projectSlug,
        stateNames,
        after: cursor,
        issueIds: options?.issueIds && options.issueIds.length > 0 ? options.issueIds : null,
      })
      const page = collectIssuePage(data)
      for (const node of page.nodes) {
        const normalized = normalizeIssue(node)
        if (normalized.id && normalized.identifier && normalized.title && normalized.state) {
          issues.push(normalized)
        }
      }
      hasNextPage = page.hasNextPage
      cursor = page.endCursor
      if (hasNextPage && !cursor) {
        throw new SymphonyError(
          'linear_missing_end_cursor',
          'Linear pagination could not continue without an endCursor',
        )
      }
    }

    return issues
  }

  return {
    fetchCandidateIssues: async () => {
      const config = await configProvider()
      return fetchIssuesByFilter(config.tracker.activeStates)
    },
    fetchIssuesByStates: async (states: string[]) => {
      if (states.length === 0) return []
      return fetchIssuesByFilter(states)
    },
    fetchIssueStatesByIds: async (issueIds: string[]) => {
      if (issueIds.length === 0) return []
      const config = await configProvider()
      const normalizedStates = Array.from(new Set([...config.tracker.activeStates, ...config.tracker.terminalStates]))
      const issues = await fetchIssuesByFilter(normalizedStates, { issueIds })
      const byId = new Map(issues.map((issue) => [issue.id, issue]))
      return issueIds.map((issueId) => byId.get(issueId)).filter((issue): issue is Issue => Boolean(issue))
    },
    executeLinearGraphql: async (query: string, variables: Record<string, unknown> = {}) => {
      const config = await configProvider()
      if (config.tracker.kind !== 'linear' || !config.tracker.apiKey) {
        throw new SymphonyError('missing_tracker_api_key', 'Linear auth is not configured')
      }
      validateOperationCount(query)
      return requestGraphql(config, query, variables)
    },
  }
}

export type { IssueTrackerClient }
