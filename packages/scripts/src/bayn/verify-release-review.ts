const githubApiVersion = '2022-11-28'
const githubGraphqlUrl = 'https://api.github.com/graphql'
const maximumGraphqlPages = 20
const minimumExactReviewAgeMs = 30_000

export const baynCodexReviewer = 'chatgpt-codex-connector'

export interface AssociatedPullRequest {
  readonly number: number
  readonly baseRefName: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly mergedAt: string | null
}

export interface PullRequestReview {
  readonly authorLogin: string | null
  readonly commitSha: string | null
  readonly submittedAt: string | null
  readonly state: string
}

export interface PullRequestReviewThread {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string | null
  readonly url: string | null
}

export interface PullRequestReviewState {
  readonly number: number
  readonly baseRefName: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly mergedAt: string | null
  readonly reviews: readonly PullRequestReview[]
  readonly threads: readonly PullRequestReviewThread[]
}

export interface BaynReleaseReviewSnapshot {
  readonly mainCommitParents: readonly string[]
  readonly associatedPullRequests: readonly AssociatedPullRequest[]
  readonly pullRequest: PullRequestReviewState | null
}

export type BaynReleaseReviewHoldCode =
  | 'no-associated-source-pr'
  | 'ambiguous-associated-source-prs'
  | 'non-single-commit-main-push'
  | 'associated-source-pr-merge-mismatch'
  | 'source-pr-metadata-mismatch'
  | 'exact-head-review-pending'
  | 'exact-head-review-missing'
  | 'exact-head-review-settling'
  | 'active-unresolved-review-threads'
  | 'github-api-error'
  | 'github-api-timeout'
  | 'github-api-invalid-response'
  | 'github-api-pagination-limit'
  | 'unexpected-verifier-error'

export interface BaynReleaseReviewEligible {
  readonly status: 'eligible'
  readonly prNumber: number
  readonly headSha: string
  readonly reviewSubmittedAt: string
  readonly ignoredOutdatedThreads: number
}

export interface BaynReleaseReviewHold {
  readonly status: 'hold'
  readonly code: BaynReleaseReviewHoldCode
  readonly message: string
  readonly retryable: boolean
}

export type BaynReleaseReviewEvaluation = BaynReleaseReviewEligible | BaynReleaseReviewHold

export type BaynReleaseReviewPollResult = BaynReleaseReviewEvaluation & {
  readonly attempts: number
  readonly timedOut: boolean
}

export class GitHubReleaseReviewError extends Error {
  readonly code:
    | 'github-api-error'
    | 'github-api-timeout'
    | 'github-api-invalid-response'
    | 'github-api-pagination-limit'
  readonly operation: string
  readonly status: number | null

  constructor(
    code: GitHubReleaseReviewError['code'],
    operation: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code} during ${operation}`, { cause: options.cause })
    this.name = 'GitHubReleaseReviewError'
    this.code = code
    this.operation = operation
    this.status = options.status ?? null
  }
}

const shortSha = (sha: string): string => sha.slice(0, 12)

const sourcePullCandidates = (
  pullRequests: readonly AssociatedPullRequest[],
  baseRefName: string,
): readonly AssociatedPullRequest[] =>
  pullRequests.filter((pullRequest) => pullRequest.baseRefName === baseRefName && pullRequest.mergedAt !== null)

const hold = (code: BaynReleaseReviewHoldCode, message: string, retryable: boolean): BaynReleaseReviewHold => ({
  status: 'hold',
  code,
  message,
  retryable,
})

const submittedReviewStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])

export const evaluateBaynReleaseReview = (input: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly snapshot: BaynReleaseReviewSnapshot
  readonly nowMs: number
  readonly pushBeforeSha: string | null
}): BaynReleaseReviewEvaluation => {
  if (
    input.pushBeforeSha !== null &&
    (input.snapshot.mainCommitParents.length !== 1 || input.snapshot.mainCommitParents[0] !== input.pushBeforeSha)
  ) {
    const parents =
      input.snapshot.mainCommitParents.length === 0
        ? 'no parents'
        : input.snapshot.mainCommitParents.map(shortSha).join(', ')
    return hold(
      'non-single-commit-main-push',
      `main push ${shortSha(input.pushBeforeSha)}..${shortSha(input.mainCommitSha)} is not one direct-parent commit; observed parent(s): ${parents}`,
      false,
    )
  }

  const sourcePulls = sourcePullCandidates(input.snapshot.associatedPullRequests, input.baseRefName)
  if (sourcePulls.length === 0) {
    return hold(
      'no-associated-source-pr',
      `main commit ${shortSha(input.mainCommitSha)} has no associated merged pull request targeting ${input.baseRefName}`,
      true,
    )
  }
  if (sourcePulls.length > 1) {
    const numbers = sourcePulls.map(({ number }) => `#${number}`).join(', ')
    return hold(
      'ambiguous-associated-source-prs',
      `main commit ${shortSha(input.mainCommitSha)} is associated with multiple merged source pull requests: ${numbers}`,
      false,
    )
  }

  const sourcePull = sourcePulls[0]
  if (sourcePull === undefined) throw new Error('source pull selection was unexpectedly empty')
  if (sourcePull.mergeCommitSha !== input.mainCommitSha) {
    return hold(
      'associated-source-pr-merge-mismatch',
      `associated source PR #${sourcePull.number} does not identify ${shortSha(input.mainCommitSha)} as its merge commit`,
      false,
    )
  }

  const pullRequest = input.snapshot.pullRequest
  if (
    pullRequest === null ||
    pullRequest.number !== sourcePull.number ||
    pullRequest.baseRefName !== input.baseRefName ||
    pullRequest.mergedAt === null ||
    pullRequest.mergeCommitSha !== input.mainCommitSha ||
    pullRequest.headSha !== sourcePull.headSha
  ) {
    return hold(
      'source-pr-metadata-mismatch',
      `source PR #${sourcePull.number} metadata does not exactly bind main commit ${shortSha(input.mainCommitSha)} to final head ${shortSha(sourcePull.headSha)}`,
      false,
    )
  }

  const exactHeadReviews = pullRequest.reviews.filter(
    (review) => review.authorLogin === baynCodexReviewer && review.commitSha === pullRequest.headSha,
  )
  const exactSubmittedReview = exactHeadReviews
    .filter((review) => review.submittedAt !== null && submittedReviewStates.has(review.state))
    .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))[0]
  if (exactSubmittedReview === undefined) {
    const hasPendingExactHeadReview = exactHeadReviews.some(
      (review) => review.submittedAt === null || review.state === 'PENDING',
    )
    if (hasPendingExactHeadReview) {
      return hold(
        'exact-head-review-pending',
        `source PR #${pullRequest.number} has a pending ${baynCodexReviewer} review for final head ${shortSha(pullRequest.headSha)}`,
        true,
      )
    }

    const olderReviewedHeads = [
      ...new Set(
        pullRequest.reviews
          .filter(
            (review) =>
              review.authorLogin === baynCodexReviewer &&
              review.commitSha !== null &&
              review.submittedAt !== null &&
              submittedReviewStates.has(review.state),
          )
          .map((review) => shortSha(review.commitSha as string)),
      ),
    ]
    const olderReviewDetail =
      olderReviewedHeads.length === 0
        ? 'no submitted Codex review exists'
        : `reviewed older head(s): ${olderReviewedHeads.join(', ')}`
    return hold(
      'exact-head-review-missing',
      `source PR #${pullRequest.number} final head ${shortSha(pullRequest.headSha)} lacks a submitted ${baynCodexReviewer} review; ${olderReviewDetail}`,
      true,
    )
  }

  const reviewSubmittedAtMs = Date.parse(exactSubmittedReview.submittedAt as string)
  if (!Number.isFinite(reviewSubmittedAtMs)) {
    return hold(
      'source-pr-metadata-mismatch',
      `source PR #${pullRequest.number} exact-head review has an invalid submitted-at timestamp`,
      false,
    )
  }
  const reviewAgeMs = input.nowMs - reviewSubmittedAtMs
  if (reviewAgeMs < minimumExactReviewAgeMs) {
    return hold(
      'exact-head-review-settling',
      `source PR #${pullRequest.number} exact-head review is ${Math.max(0, Math.floor(reviewAgeMs / 1_000))}s old; waiting for review threads to settle`,
      true,
    )
  }

  const activeUnresolvedThreads = pullRequest.threads.filter((thread) => !thread.isResolved && !thread.isOutdated)
  if (activeUnresolvedThreads.length > 0) {
    const examples = activeUnresolvedThreads
      .slice(0, 3)
      .map((thread) => thread.url ?? thread.path ?? thread.id)
      .join(', ')
    return hold(
      'active-unresolved-review-threads',
      `source PR #${pullRequest.number} has ${activeUnresolvedThreads.length} active unresolved review thread(s): ${examples}`,
      false,
    )
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewSubmittedAt: exactSubmittedReview.submittedAt as string,
    ignoredOutdatedThreads: pullRequest.threads.filter((thread) => !thread.isResolved && thread.isOutdated).length,
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const apiErrorHold = (error: unknown): BaynReleaseReviewHold => {
  if (error instanceof GitHubReleaseReviewError) {
    const status = error.status === null ? '' : ` (HTTP ${error.status})`
    return hold(error.code, `${error.code} while ${error.operation}${status}`, true)
  }
  const name = error instanceof Error ? error.name : typeof error
  return hold('unexpected-verifier-error', `unexpected verifier failure of type ${name}`, true)
}

export const pollBaynReleaseReview = async (options: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly loadSnapshot: () => Promise<BaynReleaseReviewSnapshot>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
  readonly pushBeforeSha?: string | null
}): Promise<BaynReleaseReviewPollResult> => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let lastHold: BaynReleaseReviewHold | null = null

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let evaluation: BaynReleaseReviewEvaluation
    try {
      evaluation = evaluateBaynReleaseReview({
        mainCommitSha: options.mainCommitSha,
        baseRefName: options.baseRefName,
        snapshot: await options.loadSnapshot(),
        nowMs: now(),
        pushBeforeSha: options.pushBeforeSha ?? null,
      })
    } catch (error) {
      evaluation = apiErrorHold(error)
    }

    if (evaluation.status === 'eligible') return { ...evaluation, attempts: attempt, timedOut: false }
    lastHold = evaluation
    if (!evaluation.retryable) return { ...evaluation, attempts: attempt, timedOut: false }
    if (attempt < options.maxAttempts) await sleep(options.pollIntervalMs)
  }

  if (lastHold === null) throw new Error('release review poll completed without an evaluation')
  return {
    ...lastHold,
    message: `${lastHold.message}; bounded wait exhausted after ${options.maxAttempts} attempt(s)`,
    attempts: options.maxAttempts,
    timedOut: true,
  }
}

const expectRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value as Record<string, unknown>
}

const expectString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

const expectNullableString = (value: unknown, context: string): string | null => {
  if (value === null) return null
  return expectString(value, context)
}

const expectBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean') throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return value
}

const expectInteger = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

interface GitHubJsonResponse {
  readonly value: unknown
  readonly headers: Headers
}

const requestGitHubJson = async (options: {
  readonly url: string
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly method?: 'GET' | 'POST'
  readonly body?: string
  readonly fetchFn: typeof fetch
}): Promise<GitHubJsonResponse> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs)
  try {
    const response = await options.fetchFn(options.url, {
      method: options.method ?? 'GET',
      body: options.body,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'bayn-release-review-gate',
        'X-GitHub-Api-Version': githubApiVersion,
      },
    })
    if (!response.ok) {
      throw new GitHubReleaseReviewError('github-api-error', options.operation, { status: response.status })
    }
    try {
      return { value: await response.json(), headers: response.headers }
    } catch (error) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', options.operation, { cause: error })
    }
  } catch (error) {
    if (error instanceof GitHubReleaseReviewError) throw error
    if (controller.signal.aborted) {
      throw new GitHubReleaseReviewError('github-api-timeout', options.operation, { cause: error })
    }
    throw new GitHubReleaseReviewError('github-api-error', options.operation, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

const requestGraphql = async (options: {
  readonly query: string
  readonly variables: Record<string, unknown>
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
}): Promise<Record<string, unknown>> => {
  const response = await requestGitHubJson({
    url: githubGraphqlUrl,
    operation: options.operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
    method: 'POST',
    body: JSON.stringify({ query: options.query, variables: options.variables }),
  })
  const payload = expectRecord(response.value, options.operation)
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GitHubReleaseReviewError('github-api-error', options.operation)
  }
  return expectRecord(payload.data, options.operation)
}

const parseAssociatedPullRequests = (value: unknown): readonly AssociatedPullRequest[] => {
  if (!Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list associated pull requests')
  }
  return value.map((item, index) => {
    const pullRequest = expectRecord(item, `associated pull request ${index}`)
    const base = expectRecord(pullRequest.base, `associated pull request ${index} base`)
    const head = expectRecord(pullRequest.head, `associated pull request ${index} head`)
    return {
      number: expectInteger(pullRequest.number, `associated pull request ${index} number`),
      baseRefName: expectString(base.ref, `associated pull request ${index} base ref`),
      headSha: expectString(head.sha, `associated pull request ${index} head SHA`),
      mergeCommitSha: expectNullableString(
        pullRequest.merge_commit_sha,
        `associated pull request ${index} merge commit SHA`,
      ),
      mergedAt: expectNullableString(pullRequest.merged_at, `associated pull request ${index} merged at`),
    }
  })
}

const parseMainCommitParents = (value: unknown): readonly string[] => {
  const commit = expectRecord(value, 'read main commit parents')
  if (!Array.isArray(commit.parents)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'read main commit parents')
  }
  return commit.parents.map((item, index) => {
    const parent = expectRecord(item, `main commit parent ${index}`)
    return expectString(parent.sha, `main commit parent ${index} SHA`)
  })
}

const pullRequestMetadataQuery = `
  query BaynReleasePullRequestMetadata($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        baseRefName
        headRefOid
        mergedAt
        mergeCommit { oid }
      }
    }
  }
`

const pullRequestReviewsQuery = `
  query BaynReleasePullRequestReviews($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          nodes {
            author { login }
            commit { oid }
            submittedAt
            state
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const pullRequestThreadsQuery = `
  query BaynReleasePullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: 1) { nodes { url } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const graphqlPullRequest = (data: Record<string, unknown>, operation: string): Record<string, unknown> => {
  const repository = expectRecord(data.repository, operation)
  return expectRecord(repository.pullRequest, operation)
}

const parsePageInfo = (
  connection: Record<string, unknown>,
  operation: string,
): { readonly hasNextPage: boolean; readonly endCursor: string | null } => {
  const pageInfo = expectRecord(connection.pageInfo, `${operation} page info`)
  return {
    hasNextPage: expectBoolean(pageInfo.hasNextPage, `${operation} has next page`),
    endCursor: expectNullableString(pageInfo.endCursor, `${operation} end cursor`),
  }
}

const fetchPullRequestMetadata = async (options: GitHubLoaderOptions, pullNumber: number) => {
  const data = await requestGraphql({
    query: pullRequestMetadataQuery,
    variables: { owner: options.owner, name: options.name, number: pullNumber },
    operation: `read source PR #${pullNumber} metadata`,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const pullRequest = graphqlPullRequest(data, `read source PR #${pullNumber} metadata`)
  const mergeCommit = pullRequest.mergeCommit === null ? null : expectRecord(pullRequest.mergeCommit, 'merge commit')
  return {
    number: expectInteger(pullRequest.number, 'source PR number'),
    baseRefName: expectString(pullRequest.baseRefName, 'source PR base ref'),
    headSha: expectString(pullRequest.headRefOid, 'source PR head SHA'),
    mergedAt: expectNullableString(pullRequest.mergedAt, 'source PR merged at'),
    mergeCommitSha: mergeCommit === null ? null : expectString(mergeCommit.oid, 'source PR merge commit SHA'),
  }
}

const fetchPullRequestReviews = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestReview[]> => {
  const reviews: PullRequestReview[] = []
  let cursor: string | null = null
  for (let page = 0; page < maximumGraphqlPages; page += 1) {
    const operation = `read source PR #${pullNumber} reviews page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestReviewsQuery,
      variables: { owner: options.owner, name: options.name, number: pullNumber, cursor },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const connection = expectRecord(graphqlPullRequest(data, operation).reviews, operation)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    for (const [index, item] of connection.nodes.entries()) {
      const review = expectRecord(item, `${operation} review ${index}`)
      const author = review.author === null ? null : expectRecord(review.author, `${operation} review author ${index}`)
      const commit = review.commit === null ? null : expectRecord(review.commit, `${operation} review commit ${index}`)
      reviews.push({
        authorLogin: author === null ? null : expectString(author.login, `${operation} author login ${index}`),
        commitSha: commit === null ? null : expectString(commit.oid, `${operation} commit SHA ${index}`),
        submittedAt: expectNullableString(review.submittedAt, `${operation} submitted at ${index}`),
        state: expectString(review.state, `${operation} state ${index}`),
      })
    }
    const pageInfo = parsePageInfo(connection, operation)
    if (!pageInfo.hasNextPage) return reviews
    if (pageInfo.endCursor === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    cursor = pageInfo.endCursor
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read source PR #${pullNumber} reviews`)
}

const fetchPullRequestThreads = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestReviewThread[]> => {
  const threads: PullRequestReviewThread[] = []
  let cursor: string | null = null
  for (let page = 0; page < maximumGraphqlPages; page += 1) {
    const operation = `read source PR #${pullNumber} review threads page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestThreadsQuery,
      variables: { owner: options.owner, name: options.name, number: pullNumber, cursor },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const connection = expectRecord(graphqlPullRequest(data, operation).reviewThreads, operation)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    for (const [index, item] of connection.nodes.entries()) {
      const thread = expectRecord(item, `${operation} thread ${index}`)
      const comments = expectRecord(thread.comments, `${operation} thread comments ${index}`)
      if (!Array.isArray(comments.nodes)) {
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} thread comments ${index}`)
      }
      const firstComment = comments.nodes[0]
      const comment =
        firstComment === undefined ? null : expectRecord(firstComment, `${operation} first comment ${index}`)
      threads.push({
        id: expectString(thread.id, `${operation} thread ID ${index}`),
        isResolved: expectBoolean(thread.isResolved, `${operation} resolved ${index}`),
        isOutdated: expectBoolean(thread.isOutdated, `${operation} outdated ${index}`),
        path: expectNullableString(thread.path, `${operation} path ${index}`),
        url: comment === null ? null : expectString(comment.url, `${operation} comment URL ${index}`),
      })
    }
    const pageInfo = parsePageInfo(connection, operation)
    if (!pageInfo.hasNextPage) return threads
    if (pageInfo.endCursor === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    cursor = pageInfo.endCursor
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read source PR #${pullNumber} review threads`)
}

interface GitHubLoaderOptions {
  readonly owner: string
  readonly name: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
}

export const createGitHubReleaseReviewLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynReleaseReviewSnapshot>) => {
  const [owner, name, extra] = options.repository.split('/')
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0 || extra !== undefined) {
    throw new Error('repository must be in owner/name form')
  }
  const loaderOptions: GitHubLoaderOptions = {
    owner,
    name,
    token: options.token,
    mainCommitSha: options.mainCommitSha,
    baseRefName: options.baseRefName,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
  }

  return async () => {
    const associationOperation = `list pull requests associated with ${shortSha(loaderOptions.mainCommitSha)}`
    const [commitResponse, associationResponse] = await Promise.all([
      requestGitHubJson({
        url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(loaderOptions.mainCommitSha)}`,
        operation: 'read main commit parents',
        token: loaderOptions.token,
        requestTimeoutMs: loaderOptions.requestTimeoutMs,
        fetchFn: loaderOptions.fetchFn,
      }),
      requestGitHubJson({
        url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(loaderOptions.mainCommitSha)}/pulls?per_page=100`,
        operation: associationOperation,
        token: loaderOptions.token,
        requestTimeoutMs: loaderOptions.requestTimeoutMs,
        fetchFn: loaderOptions.fetchFn,
      }),
    ])
    if (associationResponse.headers.get('link')?.includes('rel="next"') === true) {
      throw new GitHubReleaseReviewError('github-api-pagination-limit', associationOperation)
    }
    const mainCommitParents = parseMainCommitParents(commitResponse.value)
    const associatedPullRequests = parseAssociatedPullRequests(associationResponse.value)
    const candidates = sourcePullCandidates(associatedPullRequests, loaderOptions.baseRefName)
    if (candidates.length !== 1) return { mainCommitParents, associatedPullRequests, pullRequest: null }

    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('source pull selection was unexpectedly empty')
    const metadata = await fetchPullRequestMetadata(loaderOptions, candidate.number)
    const reviews = await fetchPullRequestReviews(loaderOptions, candidate.number)
    const threads = await fetchPullRequestThreads(loaderOptions, candidate.number)
    return {
      mainCommitParents,
      associatedPullRequests,
      pullRequest: { ...metadata, reviews, threads },
    }
  }
}

interface CliOptions {
  readonly repository: string
  readonly mainCommitSha: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
  readonly pushBeforeSha: string | null
}

const parsePositiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export const parseVerifyReleaseReviewArguments = (
  arguments_: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('arguments must be provided as --name value pairs')
    }
    if (values.has(name)) throw new Error(`duplicate argument ${name}`)
    values.set(name, value)
  }
  const allowed = new Set([
    '--repository',
    '--commit',
    '--push-before',
    '--max-attempts',
    '--poll-interval-ms',
    '--request-timeout-ms',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown argument ${name}`)
  }

  const repository = values.get('--repository') ?? environment.GITHUB_REPOSITORY
  const mainCommitSha = values.get('--commit') ?? environment.GITHUB_SHA
  const pushBeforeSha = values.get('--push-before') ?? null
  if (repository === undefined || repository.length === 0)
    throw new Error('--repository or GITHUB_REPOSITORY is required')
  if (mainCommitSha === undefined || !/^[0-9a-f]{40}$/.test(mainCommitSha)) {
    throw new Error('--commit or GITHUB_SHA must be a lowercase 40-character commit SHA')
  }
  if (pushBeforeSha !== null && !/^[0-9a-f]{40}$/.test(pushBeforeSha)) {
    throw new Error('--push-before must be a lowercase 40-character commit SHA')
  }
  return {
    repository,
    mainCommitSha,
    pushBeforeSha,
    maxAttempts: parsePositiveInteger(values.get('--max-attempts') ?? '10', '--max-attempts'),
    pollIntervalMs: parsePositiveInteger(values.get('--poll-interval-ms') ?? '10000', '--poll-interval-ms'),
    requestTimeoutMs: parsePositiveInteger(values.get('--request-timeout-ms') ?? '10000', '--request-timeout-ms'),
  }
}

const run = async (): Promise<void> => {
  const options = parseVerifyReleaseReviewArguments(process.argv.slice(2))
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token.length === 0) throw new Error('GITHUB_TOKEN is required')
  const result = await pollBaynReleaseReview({
    mainCommitSha: options.mainCommitSha,
    baseRefName: 'main',
    maxAttempts: options.maxAttempts,
    pollIntervalMs: options.pollIntervalMs,
    pushBeforeSha: options.pushBeforeSha,
    loadSnapshot: createGitHubReleaseReviewLoader({
      repository: options.repository,
      token,
      mainCommitSha: options.mainCommitSha,
      baseRefName: 'main',
      requestTimeoutMs: options.requestTimeoutMs,
    }),
  })
  if (result.status === 'hold') {
    console.error(`BAYN_RELEASE_REVIEW_HOLD ${result.code}: ${result.message}`)
    process.exitCode = 1
    return
  }
  console.log(
    `BAYN_RELEASE_REVIEW_ELIGIBLE PR #${result.prNumber} final head ${shortSha(result.headSha)} reviewed at ${result.reviewSubmittedAt}; attempts=${result.attempts}; outdated_unresolved_ignored=${result.ignoredOutdatedThreads}`,
  )
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`BAYN_RELEASE_REVIEW_HOLD verifier-startup-error: ${name}`)
    process.exitCode = 1
  })
}
