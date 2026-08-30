export type LinearClientOptions = {
  token: string
  apiUrl: string
}

type LinearIssue = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url?: string | null
  updatedAt?: string | null
  labels: string[]
}

const request = async (url: string, token: string, query: string, variables: Record<string, unknown>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Linear API ${response.status}: ${text}`)
  }
  return (await response.json()) as Record<string, unknown>
}

export const createLinearClient = ({ token, apiUrl }: LinearClientOptions) => {
  const listIssues = async (options: {
    project?: string
    team?: string
    labels?: string[]
    updatedAfter?: string
  }): Promise<LinearIssue[]> => {
    const query = `query($filter: IssueFilter, $cursor: String) {
      issues(filter: $filter, first: 50, after: $cursor) {
        nodes {
          id
          identifier
          title
          description
          url
          updatedAt
          labels { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`

    const filter: Record<string, unknown> = {}
    if (options.project) {
      filter.project = { name: { eq: options.project } }
    }
    if (options.team) {
      filter.team = { key: { eq: options.team } }
    }
    if (options.updatedAfter) {
      filter.updatedAt = { gt: options.updatedAfter }
    }
    if (options.labels && options.labels.length > 0) {
      filter.labels = { name: { in: options.labels } }
    }

    const issues: LinearIssue[] = []
    let cursor: string | null = null
    let hasNext = true
    while (hasNext) {
      const response = await request(apiUrl, token, query, { filter, cursor })
      const data = response.data as Record<string, unknown>
      const issuesPayload = data?.issues as Record<string, unknown> | undefined
      const nodes = Array.isArray(issuesPayload?.nodes) ? (issuesPayload?.nodes as Record<string, unknown>[]) : []
      for (const node of nodes) {
        const labelsPayload = (node.labels as Record<string, unknown> | undefined)?.nodes
        const labels = Array.isArray(labelsPayload)
          ? labelsPayload
              .map((label) => (label as Record<string, unknown>).name)
              .filter((value): value is string => typeof value === 'string')
          : []
        issues.push({
          id: String(node.id ?? ''),
          identifier: String(node.identifier ?? ''),
          title: String(node.title ?? ''),
          description: typeof node.description === 'string' ? node.description : null,
          url: typeof node.url === 'string' ? node.url : null,
          updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : null,
          labels,
        })
      }
      const pageInfo = issuesPayload?.pageInfo as Record<string, unknown> | undefined
      hasNext = Boolean(pageInfo?.hasNextPage)
      cursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
      if (!hasNext || !cursor) break
    }
    return issues
  }

  return { listIssues }
}
