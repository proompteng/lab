import { randomUUID } from 'node:crypto'
import { emitAuditEventBestEffort } from '~/server/audit-client'
import { resolveAuditContextFromRequest } from '~/server/audit-logging'
import { createGitHubClient } from '~/server/github-client'
import { isGithubRepoAllowed, loadGithubReviewConfig } from '~/server/github-review-config'
import { createGithubReviewStore } from '~/server/github-review-store'
import { recordGithubMergeAttempt, recordGithubMergeFailure, recordGithubReviewSubmitted } from '~/server/metrics'

const globalOverrides = globalThis as typeof globalThis & {
  __githubReviewConfigMock?: ReturnType<typeof loadGithubReviewConfig>
  __githubReviewGithubMock?: ReturnType<typeof createGitHubClient>
  __githubReviewStoreMock?: ReturnType<typeof createGithubReviewStore>
}

const getConfig = () => globalOverrides.__githubReviewConfigMock ?? loadGithubReviewConfig()
const getGithub = (config: ReturnType<typeof loadGithubReviewConfig>) =>
  globalOverrides.__githubReviewGithubMock ??
  createGitHubClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl })
const getStore = () => globalOverrides.__githubReviewStoreMock ?? createGithubReviewStore()

const requireRepoAllowed = (repository: string, config: ReturnType<typeof loadGithubReviewConfig>) => {
  if (!isGithubRepoAllowed(config, repository)) {
    throw new Error(`Repository ${repository} is not allowed`)
  }
}

const requireWriteEnabled = (flag: boolean, label: string) => {
  if (!flag) {
    throw new Error(`${label} is disabled`)
  }
}

const requireToken = (config: ReturnType<typeof loadGithubReviewConfig>) => {
  if (!config.githubToken) {
    throw new Error('Missing GitHub token')
  }
}

const isMergeable = (mergeableState: string | null | undefined) => {
  if (!mergeableState) return false
  const normalized = mergeableState.toLowerCase()
  return ['clean', 'unstable', 'has_hooks', 'unknown'].includes(normalized)
}

const isChecksPassing = (status: string | null | undefined) => status === 'success'

const isReviewPassing = (decision: string | null | undefined, unresolvedThreadsCount?: number | null) => {
  if (decision === 'changes_requested') return false
  if (typeof unresolvedThreadsCount === 'number' && unresolvedThreadsCount > 0) return false
  return true
}

export const submitPullRequestReview = async (
  request: Request,
  input: {
    owner: string
    repo: string
    number: number
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    body?: string | null
    comments?: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; startLine?: number }>
  },
) => {
  const config = getConfig()
  const github = getGithub(config)
  const store = getStore()
  const repository = `${input.owner}/${input.repo}`
  requireRepoAllowed(repository, config)
  requireWriteEnabled(config.reviewsWriteEnabled, 'Review submission')
  requireToken(config)

  const auditContext = resolveAuditContextFromRequest(request, {
    source: 'github-review-actions',
    repository,
  })
  const actor = auditContext.actor
  const requestId = auditContext.requestId ?? auditContext.correlationId
  const receivedAt = new Date().toISOString()

  try {
    const response = await github.submitReview({
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      event: input.event,
      body: input.body ?? null,
      comments: input.comments?.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        ...(comment.startLine ? { startLine: comment.startLine, startSide: comment.side } : {}),
      })),
    })

    recordGithubReviewSubmitted(input.event.toLowerCase())

    await store.updateReviewDecision({
      repository,
      prNumber: input.number,
      decision: input.event.toLowerCase(),
      requestedChanges: input.event === 'REQUEST_CHANGES',
      receivedAt,
    })

    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: null,
      action: 'review_submit',
      actor,
      requestId,
      payload: { event: input.event, body: input.body ?? null, comments: input.comments ?? [] },
      response: response ? (response as Record<string, unknown>) : null,
      success: true,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: 'github.review_submitted',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: 'review_submit',
        event: input.event,
        success: true,
      },
    })

    console.info('[jangar][github] review submitted', {
      repository,
      prNumber: input.number,
      actor,
      action: 'review_submit',
      requestId,
    })

    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: null,
      action: 'review_submit',
      actor,
      requestId,
      payload: { event: input.event, body: input.body ?? null, comments: input.comments ?? [] },
      response: null,
      success: false,
      error: message,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: 'github.review_submitted',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: 'review_submit',
        event: input.event,
        success: false,
        error: message,
      },
    })

    console.info('[jangar][github] review submit failed', {
      repository,
      prNumber: input.number,
      actor,
      action: 'review_submit',
      requestId,
      error: message,
    })

    throw error
  } finally {
    await store.close()
  }
}

export const resolvePullRequestThread = async (
  request: Request,
  input: {
    owner: string
    repo: string
    number: number
    threadKey: string
    resolve: boolean
  },
) => {
  const config = getConfig()
  const github = getGithub(config)
  const store = getStore()
  const repository = `${input.owner}/${input.repo}`
  requireRepoAllowed(repository, config)
  requireWriteEnabled(config.reviewsWriteEnabled, 'Thread resolution')
  requireToken(config)

  const auditContext = resolveAuditContextFromRequest(request, {
    source: 'github-review-actions',
    repository,
  })
  const actor = auditContext.actor
  const requestId = auditContext.requestId ?? auditContext.correlationId
  const receivedAt = new Date().toISOString()
  let resolvedThreadId: string | null = null

  try {
    let threadId = input.threadKey
    const stored = await store.resolveThreadKey({ repository, prNumber: input.number, threadKey: input.threadKey })
    if (stored.threadId) {
      threadId = stored.threadId
    } else {
      const lookup = await github.getReviewThreadForComment(input.threadKey)
      if (lookup.threadId) {
        threadId = lookup.threadId
      }
    }

    const response = await github.resolveReviewThread({ threadId, resolve: input.resolve })

    await store.updateThreadResolution({
      repository,
      prNumber: input.number,
      threadKey: input.threadKey,
      threadId: response.id ?? threadId,
      resolved: input.resolve,
      receivedAt,
    })
    resolvedThreadId = response.id ?? threadId

    const unresolvedCount = await store.getUnresolvedThreadCount({ repository, prNumber: input.number })
    await store.updateUnresolvedThreadCount({ repository, prNumber: input.number, count: unresolvedCount, receivedAt })

    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: null,
      action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
      actor,
      requestId,
      payload: { threadKey: input.threadKey, threadId: resolvedThreadId, resolve: input.resolve },
      response: response as Record<string, unknown>,
      success: true,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: input.resolve ? 'github.thread_resolved' : 'github.thread_unresolved',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
        threadKey: input.threadKey,
        threadId: resolvedThreadId,
        success: true,
      },
    })

    console.info('[jangar][github] thread resolution updated', {
      repository,
      prNumber: input.number,
      actor,
      action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
      requestId,
    })

    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: null,
      action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
      actor,
      requestId,
      payload: { threadKey: input.threadKey, threadId: resolvedThreadId, resolve: input.resolve },
      response: null,
      success: false,
      error: message,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: input.resolve ? 'github.thread_resolved' : 'github.thread_unresolved',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
        threadKey: input.threadKey,
        threadId: resolvedThreadId,
        success: false,
        error: message,
      },
    })

    console.info('[jangar][github] thread resolution failed', {
      repository,
      prNumber: input.number,
      actor,
      action: input.resolve ? 'thread_resolve' : 'thread_unresolve',
      requestId,
      error: message,
    })

    throw error
  } finally {
    await store.close()
  }
}

export const mergePullRequest = async (
  request: Request,
  input: {
    owner: string
    repo: string
    number: number
    method: 'merge' | 'squash' | 'rebase'
    commitTitle?: string | null
    commitMessage?: string | null
    deleteBranch?: boolean
    force?: boolean
  },
) => {
  const config = getConfig()
  const github = getGithub(config)
  const store = getStore()
  const repository = `${input.owner}/${input.repo}`
  requireRepoAllowed(repository, config)
  requireWriteEnabled(config.mergeWriteEnabled, 'Merge')
  requireToken(config)

  const auditContext = resolveAuditContextFromRequest(request, {
    source: 'github-review-actions',
    repository,
  })
  const actor = auditContext.actor
  const requestId = auditContext.requestId ?? auditContext.correlationId
  const receivedAt = new Date().toISOString()

  try {
    const state = await store.getPull({ repository, prNumber: input.number })
    const pull = state.pull
    if (!pull) {
      throw new Error('Pull request not found in stored state')
    }

    const mergeableState = pull.mergeableState
    const checksStatus = state.checks?.status ?? null
    const reviewDecision = state.review?.decision ?? null
    const unresolvedThreadsCount = state.review?.unresolvedThreadsCount ?? null

    const force = Boolean(input.force && config.mergeForceEnabled)

    if (!force) {
      if (pull.draft) {
        throw new Error('Pull request is a draft')
      }
      if (!isMergeable(mergeableState)) {
        throw new Error(`Merge blocked (mergeable_state: ${mergeableState ?? 'unknown'})`)
      }
      if (!isChecksPassing(checksStatus)) {
        throw new Error(`Merge blocked (checks: ${checksStatus ?? 'unknown'})`)
      }
      if (!isReviewPassing(reviewDecision, unresolvedThreadsCount)) {
        throw new Error(`Merge blocked (review: ${reviewDecision ?? 'unknown'})`)
      }
    }

    recordGithubMergeAttempt()

    const response = await github.mergePullRequest({
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      method: input.method,
      commitTitle: input.commitTitle ?? undefined,
      commitMessage: input.commitMessage ?? undefined,
    })

    const merged = Boolean((response as Record<string, unknown>)?.merged)
    await store.updateMergeState({ repository, prNumber: input.number, merged, mergeableState, receivedAt })

    let deleteBranchResponse: Record<string, unknown> | null = null
    if (merged && input.deleteBranch && pull.headRef) {
      deleteBranchResponse = (await github.deleteBranch({
        owner: input.owner,
        repo: input.repo,
        branch: pull.headRef,
      })) as Record<string, unknown>
    }

    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: pull.headSha ?? null,
      action: 'merge',
      actor,
      requestId,
      payload: {
        method: input.method,
        commitTitle: input.commitTitle ?? null,
        commitMessage: input.commitMessage ?? null,
        deleteBranch: input.deleteBranch ?? false,
        force,
      },
      response: { merge: response as Record<string, unknown>, deleteBranch: deleteBranchResponse },
      success: true,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: 'github.merge_completed',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: 'merge',
        method: input.method,
        deleteBranch: input.deleteBranch ?? false,
        force,
        merged,
        commitSha: pull.headSha ?? null,
        success: true,
      },
    })

    console.info('[jangar][github] merge completed', {
      repository,
      prNumber: input.number,
      actor,
      action: 'merge',
      requestId,
    })

    return { merge: response, deleteBranch: deleteBranchResponse }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordGithubMergeFailure()
    const state = await store.getPull({ repository, prNumber: input.number })
    const pull = state.pull

    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: pull?.headSha ?? null,
      action: 'merge',
      actor,
      requestId,
      payload: {
        method: input.method,
        commitTitle: input.commitTitle ?? null,
        commitMessage: input.commitMessage ?? null,
        deleteBranch: input.deleteBranch ?? false,
        force: Boolean(input.force && config.mergeForceEnabled),
      },
      response: null,
      success: false,
      error: message,
      receivedAt,
    })
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType: 'github.merge_completed',
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action: 'merge',
        method: input.method,
        deleteBranch: input.deleteBranch ?? false,
        force: Boolean(input.force && config.mergeForceEnabled),
        commitSha: pull?.headSha ?? null,
        success: false,
        error: message,
      },
    })

    console.info('[jangar][github] merge failed', {
      repository,
      prNumber: input.number,
      actor,
      action: 'merge',
      requestId,
      error: message,
    })

    throw error
  } finally {
    await store.close()
  }
}
