const githubApiVersion = '2022-11-28'
const githubGraphqlUrl = 'https://api.github.com/graphql'
const maximumGraphqlPages = 20
const minimumExactReviewAgeMs = 30_000
const maximumReleaseRangeCommits = 100
const githubWorkflowFile = 'bayn-build-push.yml'

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

export interface SuccessfulPublishRun {
  readonly id: number
  readonly runNumber: number
  readonly runAttempt: number
  readonly headSha: string
  readonly headBranch: string
  readonly event: string
  readonly status: string
  readonly conclusion: string
}

export type LastPublishedRevisionResolution =
  | {
      readonly status: 'resolved'
      readonly revision: string
      readonly runId: number
      readonly runNumber: number
      readonly runAttempt: number
    }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous'; readonly runNumber: number; readonly revisions: readonly string[] }

export interface BaynReleaseRangeCommit {
  readonly sha: string
  readonly parents: readonly string[]
  readonly files: readonly string[]
  readonly reviewSnapshot: BaynReleaseReviewSnapshot | null
}

export interface BaynReleaseComparison {
  readonly status: string
  readonly baseSha: string
  readonly headSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly totalCommits: number
  readonly commits: readonly BaynReleaseRangeCommit[]
  readonly truncated: boolean
}

export interface BaynReleaseEligibilitySnapshot {
  readonly currentCommitParents: readonly string[]
  readonly lastPublishedRevision: LastPublishedRevisionResolution
  readonly comparison: BaynReleaseComparison | null
}

export type BaynReleaseReviewHoldCode =
  | 'last-published-revision-missing'
  | 'last-published-revision-ambiguous'
  | 'last-published-revision-not-ancestor'
  | 'release-range-too-large'
  | 'release-range-metadata-mismatch'
  | 'no-associated-source-pr'
  | 'ambiguous-associated-source-prs'
  | 'non-single-commit-main-push'
  | 'associated-source-pr-merge-mismatch'
  | 'source-pr-metadata-mismatch'
  | 'exact-head-review-pending'
  | 'exact-head-review-missing'
  | 'exact-head-review-changes-requested'
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
}

export interface BaynReleaseEligibilityEligible {
  readonly status: 'eligible'
  readonly lastPublishedRevision: string
  readonly checkedCommitCount: number
  readonly baynAffectingCommitCount: number
  readonly reviewedPullRequests: readonly {
    readonly commitSha: string
    readonly prNumber: number
    readonly headSha: string
    readonly reviewSubmittedAt: string
  }[]
}

export interface BaynReleaseReviewHold {
  readonly status: 'hold'
  readonly code: BaynReleaseReviewHoldCode
  readonly message: string
  readonly retryable: boolean
}

export type BaynReleaseReviewEvaluation = BaynReleaseReviewEligible | BaynReleaseReviewHold

export type BaynReleaseEligibilityEvaluation = BaynReleaseEligibilityEligible | BaynReleaseReviewHold

export type BaynReleaseReviewPollResult = BaynReleaseReviewEvaluation & {
  readonly attempts: number
  readonly timedOut: boolean
}

export type BaynReleaseEligibilityPollResult = BaynReleaseEligibilityEvaluation & {
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

export const resolveLastPublishedRevision = (
  runs: readonly SuccessfulPublishRun[],
): LastPublishedRevisionResolution => {
  if (runs.length === 0) return { status: 'missing' }

  const highestRunNumber = Math.max(...runs.map((run) => run.runNumber))
  const latestRuns = runs.filter((run) => run.runNumber === highestRunNumber)
  const revisions = [...new Set(latestRuns.map((run) => run.headSha))].toSorted()
  if (revisions.length !== 1) {
    return { status: 'ambiguous', runNumber: highestRunNumber, revisions }
  }

  const revision = revisions[0]
  if (revision === undefined) return { status: 'missing' }
  const selectedRun = latestRuns
    .filter((run) => run.headSha === revision)
    .toSorted((left, right) => right.runAttempt - left.runAttempt || right.id - left.id)[0]
  if (selectedRun === undefined) return { status: 'missing' }
  return {
    status: 'resolved',
    revision,
    runId: selectedRun.id,
    runNumber: selectedRun.runNumber,
    runAttempt: selectedRun.runAttempt,
  }
}

const exactBaynReleasePaths = new Set([
  'packages/scripts/src/bayn/update-manifests.ts',
  'packages/scripts/src/bayn/verify-release-review.ts',
  'nix/images/bayn.nix',
  'nix/images/bayn-runtime-root.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/bun-workspace-deps-source.nix',
  'nix/packages.nix',
  'nix/cache-push.sh',
  'nix/ci-nix-oci-summary.sh',
  'nix/ci-run-timed.sh',
  'nix/oci-inspect-archive.sh',
  'nix/oci-push.sh',
  'nix/oci-release-contract.sh',
  'nix/verify-bayn-image-command.sh',
  'flake.nix',
  'flake.lock',
  'bun.lock',
  'package.json',
  '.npmrc',
  'bunfig.toml',
  'tsconfig.base.json',
  '.github/workflows/nix-oci-build-common.yml',
])

export const isBaynReleaseAffectingPath = (path: string): boolean =>
  path.startsWith('services/bayn/') ||
  path.startsWith('patches/') ||
  path.startsWith('.github/actions/setup-nix-toolchain/') ||
  /^\.github\/workflows\/bayn-[^/]+\.yml$/.test(path) ||
  path.endsWith('/package.json') ||
  exactBaynReleasePaths.has(path)

const eligibleReviewStates = new Set(['APPROVED', 'COMMENTED'])

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
  const exactSubmittedReview = exactHeadReviews
    .filter((review) => review.submittedAt !== null)
    .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))[0]
  if (exactSubmittedReview === undefined) {
    const olderReviewedHeads = [
      ...new Set(
        pullRequest.reviews
          .filter(
            (review) =>
              review.authorLogin === baynCodexReviewer && review.commitSha !== null && review.submittedAt !== null,
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
  if (exactSubmittedReview.state === 'CHANGES_REQUESTED') {
    return hold(
      'exact-head-review-changes-requested',
      `source PR #${pullRequest.number} latest exact-head ${baynCodexReviewer} review requests changes`,
      false,
    )
  }
  if (!eligibleReviewStates.has(exactSubmittedReview.state)) {
    return hold(
      'exact-head-review-missing',
      `source PR #${pullRequest.number} latest exact-head ${baynCodexReviewer} review state ${exactSubmittedReview.state} is not release-eligible`,
      false,
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

  const unresolvedThreads = pullRequest.threads.filter((thread) => !thread.isResolved)
  if (unresolvedThreads.length > 0) {
    const examples = unresolvedThreads
      .slice(0, 3)
      .map((thread) => thread.url ?? thread.path ?? thread.id)
      .join(', ')
    return hold(
      'active-unresolved-review-threads',
      `source PR #${pullRequest.number} has ${unresolvedThreads.length} unresolved review thread(s): ${examples}`,
      false,
    )
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewSubmittedAt: exactSubmittedReview.submittedAt as string,
  }
}

export const evaluateBaynReleaseEligibility = (input: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly nowMs: number
  readonly pushBeforeSha: string
}): BaynReleaseEligibilityEvaluation => {
  if (
    input.snapshot.currentCommitParents.length !== 1 ||
    input.snapshot.currentCommitParents[0] !== input.pushBeforeSha
  ) {
    const parents =
      input.snapshot.currentCommitParents.length === 0
        ? 'no parents'
        : input.snapshot.currentCommitParents.map(shortSha).join(', ')
    return hold(
      'non-single-commit-main-push',
      `main push ${shortSha(input.pushBeforeSha)}..${shortSha(input.mainCommitSha)} is not one direct-parent commit; observed parent(s): ${parents}`,
      false,
    )
  }

  const published = input.snapshot.lastPublishedRevision
  if (published.status === 'missing') {
    return hold(
      'last-published-revision-missing',
      `no successful ${githubWorkflowFile} main push identifies the last published Bayn revision`,
      true,
    )
  }
  if (published.status === 'ambiguous') {
    return hold(
      'last-published-revision-ambiguous',
      `successful ${githubWorkflowFile} run number ${published.runNumber} identifies multiple published revisions: ${published.revisions.map(shortSha).join(', ')}`,
      false,
    )
  }

  const comparison = input.snapshot.comparison
  if (comparison === null) {
    return hold(
      'release-range-metadata-mismatch',
      `release range ${shortSha(published.revision)}..${shortSha(input.mainCommitSha)} was not loaded`,
      false,
    )
  }
  if (comparison.baseSha !== published.revision || comparison.headSha !== input.mainCommitSha) {
    return hold(
      'release-range-metadata-mismatch',
      `release range metadata does not bind published ${shortSha(published.revision)} to current ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }
  if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
    return hold(
      'last-published-revision-not-ancestor',
      `last published Bayn revision ${shortSha(published.revision)} is not an ancestor of current ${shortSha(input.mainCommitSha)}; GitHub comparison status is ${comparison.status}`,
      false,
    )
  }
  if (comparison.mergeBaseSha !== published.revision) {
    return hold(
      'last-published-revision-not-ancestor',
      `last published Bayn revision ${shortSha(published.revision)} is not the exact merge base of current ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }
  if (comparison.truncated || comparison.aheadBy > maximumReleaseRangeCommits) {
    return hold(
      'release-range-too-large',
      `release range ${shortSha(published.revision)}..${shortSha(input.mainCommitSha)} contains ${comparison.aheadBy} commit(s), exceeding the bounded limit of ${maximumReleaseRangeCommits}`,
      false,
    )
  }
  if (
    comparison.aheadBy !== comparison.totalCommits ||
    comparison.aheadBy !== comparison.commits.length ||
    (comparison.status === 'identical' && comparison.aheadBy !== 0) ||
    (comparison.status === 'ahead' && comparison.aheadBy === 0)
  ) {
    return hold(
      'release-range-metadata-mismatch',
      `release range reports aheadBy=${comparison.aheadBy}, totalCommits=${comparison.totalCommits}, loadedCommits=${comparison.commits.length}, status=${comparison.status}`,
      false,
    )
  }

  const commitShas = comparison.commits.map((commit) => commit.sha)
  if (new Set(commitShas).size !== commitShas.length) {
    return hold('release-range-metadata-mismatch', 'release range contains duplicate commit identities', false)
  }
  if (comparison.commits.length > 0 && comparison.commits.at(-1)?.sha !== input.mainCommitSha) {
    return hold(
      'release-range-metadata-mismatch',
      `release range does not end at current main commit ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }

  const affectingCommits = comparison.commits.filter((commit) => commit.files.some(isBaynReleaseAffectingPath))
  if (comparison.aheadBy > 0 && affectingCommits.length === 0) {
    return hold(
      'release-range-metadata-mismatch',
      `triggered Bayn release range ${shortSha(published.revision)}..${shortSha(input.mainCommitSha)} contains no Bayn-affecting commit`,
      false,
    )
  }

  const reviewedPullRequests: BaynReleaseEligibilityEligible['reviewedPullRequests'][number][] = []
  for (const commit of affectingCommits) {
    if (commit.reviewSnapshot === null) {
      return hold(
        'release-range-metadata-mismatch',
        `Bayn-affecting commit ${shortSha(commit.sha)} has no source review snapshot`,
        false,
      )
    }
    const review = evaluateBaynReleaseReview({
      mainCommitSha: commit.sha,
      baseRefName: input.baseRefName,
      snapshot: commit.reviewSnapshot,
      nowMs: input.nowMs,
      pushBeforeSha: null,
    })
    if (review.status === 'hold') {
      return {
        ...review,
        message: `Bayn-affecting commit ${shortSha(commit.sha)} after last published ${shortSha(published.revision)} is not release-eligible: ${review.message}`,
      }
    }
    reviewedPullRequests.push({
      commitSha: commit.sha,
      prNumber: review.prNumber,
      headSha: review.headSha,
      reviewSubmittedAt: review.reviewSubmittedAt,
    })
  }

  return {
    status: 'eligible',
    lastPublishedRevision: published.revision,
    checkedCommitCount: comparison.commits.length,
    baynAffectingCommitCount: affectingCommits.length,
    reviewedPullRequests,
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

export const pollBaynReleaseEligibility = async (options: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly pushBeforeSha: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly loadSnapshot: () => Promise<BaynReleaseEligibilitySnapshot>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
}): Promise<BaynReleaseEligibilityPollResult> => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let lastHold: BaynReleaseReviewHold | null = null

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let evaluation: BaynReleaseEligibilityEvaluation
    try {
      evaluation = evaluateBaynReleaseEligibility({
        mainCommitSha: options.mainCommitSha,
        baseRefName: options.baseRefName,
        snapshot: await options.loadSnapshot(),
        nowMs: now(),
        pushBeforeSha: options.pushBeforeSha,
      })
    } catch (error) {
      evaluation = apiErrorHold(error)
    }

    if (evaluation.status === 'eligible') return { ...evaluation, attempts: attempt, timedOut: false }
    lastHold = evaluation
    if (!evaluation.retryable) return { ...evaluation, attempts: attempt, timedOut: false }
    if (attempt < options.maxAttempts) await sleep(options.pollIntervalMs)
  }

  if (lastHold === null) throw new Error('release eligibility poll completed without an evaluation')
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

const expectSha = (value: unknown, context: string): string => {
  const sha = expectString(value, context)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return sha
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

const parseSuccessfulPublishRuns = (value: unknown): readonly SuccessfulPublishRun[] => {
  const payload = expectRecord(value, 'list successful Bayn publish runs')
  if (!Array.isArray(payload.workflow_runs)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list successful Bayn publish runs')
  }
  return payload.workflow_runs.map((item, index) => {
    const run = expectRecord(item, `successful Bayn publish run ${index}`)
    const parsed: SuccessfulPublishRun = {
      id: expectInteger(run.id, `successful Bayn publish run ${index} ID`),
      runNumber: expectInteger(run.run_number, `successful Bayn publish run ${index} number`),
      runAttempt: expectInteger(run.run_attempt, `successful Bayn publish run ${index} attempt`),
      headSha: expectSha(run.head_sha, `successful Bayn publish run ${index} head SHA`),
      headBranch: expectString(run.head_branch, `successful Bayn publish run ${index} head branch`),
      event: expectString(run.event, `successful Bayn publish run ${index} event`),
      status: expectString(run.status, `successful Bayn publish run ${index} status`),
      conclusion: expectString(run.conclusion, `successful Bayn publish run ${index} conclusion`),
    }
    if (
      parsed.headBranch !== 'main' ||
      parsed.event !== 'push' ||
      parsed.status !== 'completed' ||
      parsed.conclusion !== 'success'
    ) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `successful Bayn publish run ${index} contract`)
    }
    return parsed
  })
}

interface ParsedComparison {
  readonly status: string
  readonly baseSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly totalCommits: number
  readonly commitShas: readonly string[]
}

const parseComparison = (value: unknown): ParsedComparison => {
  const comparison = expectRecord(value, 'compare last published Bayn revision to current main')
  const baseCommit = expectRecord(comparison.base_commit, 'comparison base commit')
  const mergeBaseCommit = expectRecord(comparison.merge_base_commit, 'comparison merge base commit')
  if (!Array.isArray(comparison.commits)) {
    throw new GitHubReleaseReviewError(
      'github-api-invalid-response',
      'compare last published Bayn revision to current main commits',
    )
  }
  return {
    status: expectString(comparison.status, 'comparison status'),
    baseSha: expectSha(baseCommit.sha, 'comparison base commit SHA'),
    mergeBaseSha: expectSha(mergeBaseCommit.sha, 'comparison merge base commit SHA'),
    aheadBy: expectInteger(comparison.ahead_by, 'comparison ahead count'),
    totalCommits: expectInteger(comparison.total_commits, 'comparison total commit count'),
    commitShas: comparison.commits.map((item, index) => {
      const commit = expectRecord(item, `comparison commit ${index}`)
      return expectSha(commit.sha, `comparison commit ${index} SHA`)
    }),
  }
}

interface CommitDetail {
  readonly sha: string
  readonly parents: readonly string[]
  readonly files: readonly string[]
}

const parseCommitDetail = (value: unknown, expectedSha: string): CommitDetail => {
  const commit = expectRecord(value, `read commit ${shortSha(expectedSha)}`)
  const sha = expectSha(commit.sha, `commit ${shortSha(expectedSha)} SHA`)
  if (sha !== expectedSha) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `read commit ${shortSha(expectedSha)} identity`)
  }
  if (!Array.isArray(commit.parents) || !Array.isArray(commit.files)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `read commit ${shortSha(expectedSha)} detail`)
  }
  return {
    sha,
    parents: commit.parents.map((item, index) => {
      const parent = expectRecord(item, `commit ${shortSha(expectedSha)} parent ${index}`)
      return expectSha(parent.sha, `commit ${shortSha(expectedSha)} parent ${index} SHA`)
    }),
    files: commit.files.flatMap((item, index) => {
      const file = expectRecord(item, `commit ${shortSha(expectedSha)} file ${index}`)
      const filename = expectString(file.filename, `commit ${shortSha(expectedSha)} file ${index} path`)
      if (file.previous_filename === undefined) return [filename]
      return [
        filename,
        expectString(file.previous_filename, `commit ${shortSha(expectedSha)} file ${index} previous path`),
      ]
    }),
  }
}

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> => {
  const output: Output[] = Array.from({ length: values.length })
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value === undefined) throw new Error(`missing concurrency input ${index}`)
      output[index] = await map(value, index)
    }
  })
  await Promise.all(workers)
  return output
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

const fetchCommitDetail = async (options: GitHubLoaderOptions, commitSha: string): Promise<CommitDetail> => {
  const operation = `read commit ${shortSha(commitSha)} detail`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(commitSha)}?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', `${operation} files`)
  }
  return parseCommitDetail(response.value, commitSha)
}

const loadCommitReviewSnapshot = async (
  options: GitHubLoaderOptions,
  commitSha: string,
  knownCommit?: CommitDetail,
): Promise<BaynReleaseReviewSnapshot> => {
  const associationOperation = `list pull requests associated with ${shortSha(commitSha)}`
  const [commit, associationResponse] = await Promise.all([
    knownCommit === undefined ? fetchCommitDetail(options, commitSha) : Promise.resolve(knownCommit),
    requestGitHubJson({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`,
      operation: associationOperation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    }),
  ])
  if (associationResponse.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', associationOperation)
  }
  const associatedPullRequests = parseAssociatedPullRequests(associationResponse.value)
  const candidates = sourcePullCandidates(associatedPullRequests, options.baseRefName)
  if (candidates.length !== 1) {
    return { mainCommitParents: commit.parents, associatedPullRequests, pullRequest: null }
  }

  const candidate = candidates[0]
  if (candidate === undefined) throw new Error('source pull selection was unexpectedly empty')
  const metadata = await fetchPullRequestMetadata(options, candidate.number)
  const reviews = await fetchPullRequestReviews(options, candidate.number)
  const threads = await fetchPullRequestThreads(options, candidate.number)
  return {
    mainCommitParents: commit.parents,
    associatedPullRequests,
    pullRequest: { ...metadata, reviews, threads },
  }
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

  return () => loadCommitReviewSnapshot(loaderOptions, loaderOptions.mainCommitSha)
}

interface StaticReleaseEligibilityContext {
  readonly currentCommit: CommitDetail
  readonly lastPublishedRevision: LastPublishedRevisionResolution
  readonly comparison:
    | (Omit<BaynReleaseComparison, 'commits'> & {
        readonly commits: readonly (CommitDetail & { readonly reviewSnapshot: null })[]
      })
    | null
}

const loadStaticReleaseEligibilityContext = async (
  options: GitHubLoaderOptions,
): Promise<StaticReleaseEligibilityContext> => {
  const successfulRunsOperation = `list successful ${githubWorkflowFile} main push runs`
  const [currentCommit, successfulRunsResponse] = await Promise.all([
    fetchCommitDetail(options, options.mainCommitSha),
    requestGitHubJson({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/workflows/${encodeURIComponent(githubWorkflowFile)}/runs?branch=main&event=push&status=success&per_page=100&page=1`,
      operation: successfulRunsOperation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    }),
  ])
  const lastPublishedRevision = resolveLastPublishedRevision(parseSuccessfulPublishRuns(successfulRunsResponse.value))
  if (lastPublishedRevision.status !== 'resolved') {
    return { currentCommit, lastPublishedRevision, comparison: null }
  }

  const comparisonOperation = `compare published ${shortSha(lastPublishedRevision.revision)} to current ${shortSha(options.mainCommitSha)}`
  const comparisonResponse = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/compare/${encodeURIComponent(lastPublishedRevision.revision)}...${encodeURIComponent(options.mainCommitSha)}?per_page=${maximumReleaseRangeCommits}&page=1`,
    operation: comparisonOperation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const parsedComparison = parseComparison(comparisonResponse.value)
  const truncated = comparisonResponse.headers.get('link')?.includes('rel="next"') === true
  if (truncated || parsedComparison.commitShas.length > maximumReleaseRangeCommits) {
    return {
      currentCommit,
      lastPublishedRevision,
      comparison: {
        status: parsedComparison.status,
        baseSha: parsedComparison.baseSha,
        headSha: options.mainCommitSha,
        mergeBaseSha: parsedComparison.mergeBaseSha,
        aheadBy: parsedComparison.aheadBy,
        totalCommits: parsedComparison.totalCommits,
        commits: [],
        truncated: true,
      },
    }
  }

  const commitDetails = await mapWithConcurrency(parsedComparison.commitShas, 4, async (commitSha) =>
    commitSha === currentCommit.sha ? currentCommit : fetchCommitDetail(options, commitSha),
  )
  return {
    currentCommit,
    lastPublishedRevision,
    comparison: {
      status: parsedComparison.status,
      baseSha: parsedComparison.baseSha,
      headSha: options.mainCommitSha,
      mergeBaseSha: parsedComparison.mergeBaseSha,
      aheadBy: parsedComparison.aheadBy,
      totalCommits: parsedComparison.totalCommits,
      commits: commitDetails.map((commit) => ({ ...commit, reviewSnapshot: null })),
      truncated: false,
    },
  }
}

export const createGitHubReleaseEligibilityLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynReleaseEligibilitySnapshot>) => {
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
  let staticContext: StaticReleaseEligibilityContext | null = null

  return async () => {
    const loadedContext = staticContext ?? (await loadStaticReleaseEligibilityContext(loaderOptions))
    if (loadedContext.lastPublishedRevision.status !== 'missing') staticContext = loadedContext
    if (loadedContext.comparison === null) {
      return {
        currentCommitParents: loadedContext.currentCommit.parents,
        lastPublishedRevision: loadedContext.lastPublishedRevision,
        comparison: null,
      }
    }

    const commits = await mapWithConcurrency(loadedContext.comparison.commits, 3, async (commit) => ({
      ...commit,
      reviewSnapshot: commit.files.some(isBaynReleaseAffectingPath)
        ? await loadCommitReviewSnapshot(loaderOptions, commit.sha, commit)
        : null,
    }))
    return {
      currentCommitParents: loadedContext.currentCommit.parents,
      lastPublishedRevision: loadedContext.lastPublishedRevision,
      comparison: { ...loadedContext.comparison, commits },
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
  if (options.pushBeforeSha === null) throw new Error('--push-before is required for Bayn publication eligibility')
  const result = await pollBaynReleaseEligibility({
    mainCommitSha: options.mainCommitSha,
    baseRefName: 'main',
    maxAttempts: options.maxAttempts,
    pollIntervalMs: options.pollIntervalMs,
    pushBeforeSha: options.pushBeforeSha,
    loadSnapshot: createGitHubReleaseEligibilityLoader({
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
    `BAYN_RELEASE_REVIEW_ELIGIBLE published=${shortSha(result.lastPublishedRevision)} current=${shortSha(options.mainCommitSha)} checked_commits=${result.checkedCommitCount} bayn_affecting_commits=${result.baynAffectingCommitCount} reviewed_prs=${result.reviewedPullRequests.map((review) => `#${review.prNumber}@${shortSha(review.headSha)}`).join(',')}; attempts=${result.attempts}`,
  )
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`BAYN_RELEASE_REVIEW_HOLD verifier-startup-error: ${name}`)
    process.exitCode = 1
  })
}
