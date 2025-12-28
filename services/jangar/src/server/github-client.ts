import { Buffer } from 'node:buffer'

export type GitHubClientOptions = {
  token: string | null
  apiBaseUrl: string
  userAgent?: string
}

export type PullRequest = {
  number: number
  url: string
  htmlUrl: string
  headSha: string
  headRef: string
  baseRef: string
  state: string
  title: string
  body: string | null
  mergeableState: string | null
}

export type CheckRunSummary = {
  status: 'pending' | 'success' | 'failure'
  url?: string
}

export type ReviewSummary = {
  status: 'pending' | 'approved' | 'changes_requested' | 'commented'
  unresolvedThreads: Array<{ id: string; author: string | null }>
  requestedChanges: boolean
}

export type FileContent = {
  content: string
  sha: string
}

export type CreatePullRequestInput = {
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
}

export type CreateBranchInput = {
  owner: string
  repo: string
  branch: string
  baseSha: string
}

export type UpdateFileInput = {
  owner: string
  repo: string
  path: string
  branch: string
  message: string
  content: string
  sha?: string
}

const encodeBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const decodeBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')

const buildHeaders = (token: string | null, userAgent = 'jangar-codex-judge') => {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

const requestJson = async (url: string, init: RequestInit) => {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text}`)
  }
  return text ? (JSON.parse(text) as unknown) : null
}

const requestText = async (url: string, init: RequestInit) => {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text}`)
  }
  return text
}

export const createGitHubClient = ({ token, apiBaseUrl, userAgent }: GitHubClientOptions) => {
  const headers = buildHeaders(token, userAgent)

  const rest = async (path: string, init: RequestInit = {}) => {
    return requestJson(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    })
  }

  const restText = async (path: string, init: RequestInit = {}) => {
    return requestText(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    })
  }

  const graphql = async (query: string, variables: Record<string, unknown>) => {
    return requestJson(`${apiBaseUrl.replace('/v3', '')}/graphql`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
  }

  const getPullRequestByHead = async (owner: string, repo: string, head: string): Promise<PullRequest | null> => {
    const data = (await rest(
      `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1`,
    )) as Array<Record<string, unknown>>
    const pr = data?.[0]
    if (!pr) return null
    return {
      number: Number(pr.number),
      url: String(pr.url),
      htmlUrl: String(pr.html_url),
      headSha: String((pr.head as Record<string, unknown>).sha),
      headRef: String((pr.head as Record<string, unknown>).ref),
      baseRef: String((pr.base as Record<string, unknown>).ref),
      state: String(pr.state),
      title: String(pr.title),
      body: typeof pr.body === 'string' ? pr.body : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
    }
  }

  const getPullRequest = async (owner: string, repo: string, number: number): Promise<PullRequest> => {
    const pr = (await rest(`/repos/${owner}/${repo}/pulls/${number}`)) as Record<string, unknown>
    return {
      number: Number(pr.number),
      url: String(pr.url),
      htmlUrl: String(pr.html_url),
      headSha: String((pr.head as Record<string, unknown>).sha),
      headRef: String((pr.head as Record<string, unknown>).ref),
      baseRef: String((pr.base as Record<string, unknown>).ref),
      state: String(pr.state),
      title: String(pr.title),
      body: typeof pr.body === 'string' ? pr.body : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
    }
  }

  const getCheckRuns = async (owner: string, repo: string, sha: string): Promise<CheckRunSummary> => {
    const data = (await rest(`/repos/${owner}/${repo}/commits/${sha}/check-runs`)) as Record<string, unknown>
    const runs = Array.isArray(data.check_runs) ? data.check_runs : []
    if (runs.length === 0) {
      return { status: 'pending' }
    }
    let hasFailure = false
    let hasPending = false
    let detailsUrl: string | undefined
    for (const run of runs) {
      const status = String(run.status ?? '')
      const conclusion = run.conclusion ? String(run.conclusion) : null
      detailsUrl = detailsUrl ?? (typeof run.html_url === 'string' ? run.html_url : undefined)
      if (status !== 'completed') {
        hasPending = true
      } else if (conclusion && conclusion !== 'success' && conclusion !== 'skipped') {
        hasFailure = true
      }
    }
    if (hasFailure) return { status: 'failure', url: detailsUrl }
    if (hasPending) return { status: 'pending', url: detailsUrl }
    return { status: 'success', url: detailsUrl }
  }

  const getPullRequestDiff = async (owner: string, repo: string, number: number) => {
    return restText(`/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        accept: 'application/vnd.github.v3.diff',
      },
    })
  }

  const getReviewSummary = async (
    owner: string,
    repo: string,
    number: number,
    reviewers: string[],
  ): Promise<ReviewSummary> => {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviews(last: 20) { nodes { author { login } state submittedAt } }
          reviewThreads(first: 50) {
            nodes {
              id
              isResolved
              comments(last: 10) { nodes { author { login } } }
            }
          }
        }
      }
    }`

    const response = (await graphql(query, { owner, repo, number })) as Record<string, unknown>
    const pr = (response.data as Record<string, unknown> | undefined)?.repository?.(
      response.data as Record<string, unknown>,
    ).repository?.pullRequest as Record<string, unknown> | undefined

    const reviewNodes = (pr?.reviews as Record<string, unknown> | undefined)?.nodes
    const reviews = Array.isArray(reviewNodes) ? reviewNodes : []

    let requestedChanges = false
    let status: ReviewSummary['status'] = 'pending'
    for (const review of reviews) {
      const author = (review as Record<string, unknown>).author as Record<string, unknown> | null
      const login = author?.login ? String(author.login).toLowerCase() : null
      if (reviewers.length > 0 && login && !reviewers.includes(login)) {
        continue
      }
      const state = String((review as Record<string, unknown>).state ?? '').toUpperCase()
      if (state === 'CHANGES_REQUESTED') {
        requestedChanges = true
        status = 'changes_requested'
      } else if (state === 'APPROVED' && status !== 'changes_requested') {
        status = 'approved'
      } else if (state === 'COMMENTED' && status === 'pending') {
        status = 'commented'
      }
    }

    const threads = Array.isArray((pr?.reviewThreads as Record<string, unknown> | undefined)?.nodes)
      ? ((pr?.reviewThreads as Record<string, unknown>).nodes as Array<Record<string, unknown>>)
      : []

    const unresolvedThreads = threads
      .filter((thread) => !thread.isResolved)
      .map((thread) => {
        const comments = Array.isArray((thread.comments as Record<string, unknown> | undefined)?.nodes)
          ? ((thread.comments as Record<string, unknown>).nodes as Array<Record<string, unknown>>)
          : []
        const authorLogin = comments
          .map((comment) => (comment.author as Record<string, unknown> | undefined)?.login)
          .filter((login) => typeof login === 'string')
          .map((login) => String(login).toLowerCase())
          .find((login) => login)
        return {
          id: String(thread.id),
          author: authorLogin ?? null,
        }
      })
      .filter((thread) => {
        if (reviewers.length === 0) return true
        if (!thread.author) return false
        return reviewers.includes(thread.author)
      })

    if (requestedChanges) {
      status = 'changes_requested'
    } else if (unresolvedThreads.length > 0) {
      status = 'commented'
    } else if (status === 'commented') {
      status = 'commented'
    } else if (status === 'approved') {
      status = 'approved'
    } else if (reviews.length === 0) {
      status = 'pending'
    }

    return { status, unresolvedThreads, requestedChanges }
  }

  const getRefSha = async (owner: string, repo: string, ref: string) => {
    const data = (await rest(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`)) as Record<string, unknown>
    const object = data.object as Record<string, unknown>
    return String(object.sha)
  }

  const createBranch = async ({ owner, repo, branch, baseSha }: CreateBranchInput) => {
    return rest(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    })
  }

  const getFile = async (owner: string, repo: string, path: string, ref: string): Promise<FileContent> => {
    const data = (await rest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    )) as Record<string, unknown>
    const content = typeof data.content === 'string' ? data.content.replace(/\n/g, '') : ''
    const sha = String(data.sha)
    return { content: decodeBase64(content), sha }
  }

  const updateFile = async ({ owner, repo, path, branch, message, content, sha }: UpdateFileInput) => {
    const body: Record<string, unknown> = { message, content: encodeBase64(content), branch }
    if (sha) {
      body.sha = sha
    }
    return rest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const createPullRequest = async ({ owner, repo, head, base, title, body }: CreatePullRequestInput) => {
    return rest(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, head, base, body }),
    })
  }

  return {
    getPullRequestByHead,
    getPullRequest,
    getCheckRuns,
    getPullRequestDiff,
    getReviewSummary,
    getRefSha,
    getFile,
    updateFile,
    createBranch,
    createPullRequest,
  }
}
