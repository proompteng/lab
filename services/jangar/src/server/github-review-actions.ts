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

const isAutomergeBranch = (headRef: string | null | undefined, prefixes: string[]) => {
  if (!headRef) return false
  const branch = headRef.trim()
  if (!branch) return false
  return prefixes.some((prefix) => branch.startsWith(prefix))
}

const hasHoldLabel = (labels: string[] | undefined, holdLabel: string | null) => {
  if (!holdLabel || !Array.isArray(labels)) return false
  const normalized = holdLabel.trim().toLowerCase()
  if (!normalized) return false
  return labels.some((label) => String(label).trim().toLowerCase() === normalized)
}

const toPathPrefixList = (values: string[] | undefined | null): string[] => {
  if (!Array.isArray(values)) return []
  const normalized = values
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => value.length > 0)
    .map((value) => (value.endsWith('/') ? value.slice(0, -1) : value))
  return Array.from(new Set(normalized))
}

const parseRiskClass = (labels: string[] | undefined): string | null => {
  if (!Array.isArray(labels)) return null
  for (const label of labels) {
    const raw = String(label).trim()
    if (!raw) continue
    const normalized = raw.toLowerCase()
    if (!normalized.startsWith('risk:')) continue
    const value = normalized.slice(5).trim()
    if (!value) continue
    return value
  }
  return null
}

const isAllowedByPrefix = (value: string, allowedPrefixes: string[]) => {
  if (allowedPrefixes.length === 0) return true
  const normalized = value.toLowerCase()
  return allowedPrefixes.some((prefix) => {
    if (!prefix) return false
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

const isBlockedByPrefix = (value: string, blockedPrefixes: string[]) => {
  if (blockedPrefixes.length === 0) return false
  const normalized = value.toLowerCase()
  return blockedPrefixes.some((prefix) => {
    if (!prefix) return false
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

const isRequiredChecksPassing = (args: {
  checks: Array<{ commitSha: string; runs: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> }>
  requiredCheckNames: string[]
  headSha: string | null
}) => {
  const required = toPathPrefixList(args.requiredCheckNames)
  if (required.length === 0) return { passed: true, missing: [] as string[] }

  const runSet = new Set<string>(
    args.checks
      .filter((check) => !args.headSha || check.commitSha === args.headSha)
      .flatMap((check) => {
        return (check.runs ?? []).map((run) => {
          const name = String(run.name ?? '').trim()
          if (!name) return ''
          return name.toLowerCase()
        })
      })
      .filter((name) => name.length > 0),
  )
  const missing = required.filter((requiredCheck) => !runSet.has(requiredCheck))
  if (missing.length > 0) return { passed: false, missing }

  const matchedChecks = args.checks
    .filter((check) => !args.headSha || check.commitSha === args.headSha)
    .flatMap((check) => check.runs ?? [])
    .filter((run) => typeof run.name === 'string')
    .map((run) => {
      const name = String(run.name).trim().toLowerCase()
      const status = String(run.status ?? '')
        .trim()
        .toLowerCase()
      const conclusion = String(run.conclusion ?? '')
        .trim()
        .toLowerCase()
      return { name, status, conclusion, runName: String(run.name).trim() }
    })

  const failed = required.filter((requiredCheck) => {
    const observed = matchedChecks.find((run) => run.name === requiredCheck)
    if (!observed) return true
    if (observed.status && observed.status !== 'completed') return true
    if (observed.conclusion && observed.conclusion !== 'success') {
      return observed.conclusion !== 'neutral' && observed.conclusion !== 'skipped'
    }
    return false
  })

  return {
    passed: failed.length === 0,
    missing: failed,
  }
}

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
  const actor = auditContext.actor ?? null
  const requestId = auditContext.requestId ?? auditContext.correlationId ?? null
  const receivedAt = new Date().toISOString()
  let riskClass: string | null = null

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
      missionId: null,
      stage: null,
      actionClass: null,
      riskClass: null,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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
      missionId: null,
      stage: null,
      actionClass: null,
      riskClass: null,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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
  const actor = auditContext.actor ?? null
  const requestId = auditContext.requestId ?? auditContext.correlationId ?? null
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
      missionId: null,
      stage: null,
      actionClass: null,
      riskClass: null,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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
      missionId: null,
      stage: null,
      actionClass: null,
      riskClass: null,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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
  const actor = auditContext.actor ?? null
  const requestId = auditContext.requestId ?? auditContext.correlationId ?? null
  const receivedAt = new Date().toISOString()
  let riskClass: string | null = null

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
    riskClass = parseRiskClass(pull.labels)

    const force = Boolean(input.force && config.mergeForceEnabled)
    const isSwarmAutomerge = isAutomergeBranch(pull.headRef, config.automergeBranchPrefixes)
    if (isSwarmAutomerge && hasHoldLabel(pull.labels, config.mergeHoldLabel)) {
      throw new Error(`Merge blocked (${config.mergeHoldLabel ?? 'hold label'} present)`)
    }

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

      if (isSwarmAutomerge) {
        const requiredCheckResult = isRequiredChecksPassing({
          checks: await store.listCheckStates({ repository, prNumber: input.number }),
          requiredCheckNames: config.automergeRequiredCheckNames,
          headSha: pull.headSha,
        })
        if (!requiredCheckResult.passed) {
          throw new Error(`Merge blocked (required checks missing/failing: ${requiredCheckResult.missing.join(', ')})`)
        }

        const allowedPrefixes = toPathPrefixList(config.automergeAllowedFilePrefixes)
        const blockedPrefixes = toPathPrefixList(config.automergeBlockedFilePrefixes)
        const allowedRiskClasses = toPathPrefixList(config.automergeAllowedRiskClasses)

        if (allowedRiskClasses.length > 0) {
          if (!riskClass) {
            throw new Error('Merge blocked (risk class missing)')
          }
          if (!allowedRiskClasses.includes(riskClass)) {
            throw new Error(`Merge blocked (risk class '${riskClass}' not permitted)`)
          }
        }

        const changedFiles = await store.listFiles({
          repository,
          prNumber: input.number,
          commitSha: pull.headSha,
        })
        if (pull.changedFiles === 0 || changedFiles.length === 0) {
          throw new Error('Merge blocked (empty diff)')
        }
        const disallowedFiles = changedFiles
          .map((file) => file.path)
          .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
          .filter((filePath) => {
            return !isAllowedByPrefix(filePath, allowedPrefixes) || isBlockedByPrefix(filePath, blockedPrefixes)
          })
        if (disallowedFiles.length > 0) {
          throw new Error(`Merge blocked (files outside policy: ${disallowedFiles.slice(0, 5).join(', ')})`)
        }
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

    if (merged) {
      const rolloutReference =
        typeof (response as Record<string, unknown>).sha === 'string'
          ? String((response as Record<string, unknown>).sha)
          : pull.headSha
      const rolloutPayload = {
        action: 'rollout',
        missionId: null,
        stage: 'rollout',
        reference: rolloutReference,
        status: 'passed',
        reason: null,
        actor,
        requestId,
      }
      void (async () => {
        try {
          await store.insertWriteAudit({
            repository,
            prNumber: input.number,
            commitSha: rolloutReference,
            missionId: null,
            stage: 'rollout',
            actionClass: 'autonomous',
            riskClass,
            rolloutRef: rolloutReference,
            rolloutStatus: 'passed',
            rollbackRef: null,
            rollbackReason: null,
            action: 'rollout',
            actor,
            requestId,
            payload: rolloutPayload,
            response: { merge: response as Record<string, unknown>, deleteBranch: deleteBranchResponse },
            success: true,
            receivedAt,
          })
          void emitAuditEventBestEffort({
            entityType: 'GithubWriteAction',
            entityId: randomUUID(),
            eventType: 'github.rollout_reported',
            context: auditContext,
            details: {
              repository,
              prNumber: input.number,
              action: 'rollout',
              missionId: null,
              stage: 'rollout',
              reference: rolloutReference,
              status: 'passed',
              success: true,
            },
          })
        } catch (error) {
          console.error('[jangar][github] merge rollout evidence write failed', {
            repository,
            prNumber: input.number,
            actor,
            requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }

    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: pull.headSha ?? null,
      missionId: null,
      stage: 'merge',
      actionClass: 'autonomous',
      riskClass,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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
      missionId: null,
      stage: 'merge',
      actionClass: 'autonomous',
      riskClass,
      rolloutRef: null,
      rolloutStatus: null,
      rollbackRef: null,
      rollbackReason: null,
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

type DeploymentAction = 'rollout' | 'rollback'

const isDeploymentAction = (value: string): value is DeploymentAction => {
  return value === 'rollout' || value === 'rollback'
}

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const recordPullDeploymentAction = async (
  request: Request,
  input: {
    owner: string
    repo: string
    number: number
    action: string
    missionId?: string | null
    stage?: string | null
    reference?: string | null
    status?: string | null
    reason?: string | null
  },
) => {
  const config = getConfig()
  const store = getStore()
  const repository = `${input.owner}/${input.repo}`
  requireRepoAllowed(repository, config)
  requireWriteEnabled(config.mergeWriteEnabled, 'Merge')
  requireToken(config)

  const auditContext = resolveAuditContextFromRequest(request, {
    source: 'github-review-actions',
    repository,
  })
  const actor = auditContext.actor ?? null
  const requestId = auditContext.requestId ?? auditContext.correlationId ?? null
  const receivedAt = new Date().toISOString()
  let action: DeploymentAction = 'rollout'
  let missionId = normalizeText(input.missionId)
  let stage = normalizeText(input.stage)
  const reference = normalizeText(input.reference)
  const status = normalizeText(input.status)
  const reason = normalizeText(input.reason)

  try {
    const pullState = await store.getPull({ repository, prNumber: input.number })
    const pull = pullState.pull
    if (!pull) {
      throw new Error('Pull request not found in stored state')
    }

    if (!isDeploymentAction(input.action)) {
      throw new Error(`Invalid deployment action: ${input.action}`)
    }
    action = input.action
    if (!stage) {
      stage = action === 'rollback' ? 'rollback' : 'rollout'
    }
    if (action === 'rollout' && !reference) {
      throw new Error('Rollout evidence requires a reference')
    }
    if (action === 'rollback' && !reason) {
      throw new Error('Rollback evidence requires a reason')
    }

    const riskClass = parseRiskClass(pull.labels)

    const payload = {
      action,
      missionId,
      stage,
      reference,
      status,
      reason,
      actor,
      requestId,
    }
    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: pull.headSha ?? null,
      missionId,
      stage,
      actionClass: 'autonomous',
      riskClass,
      rolloutRef: action === 'rollout' ? reference : null,
      rolloutStatus: action === 'rollout' ? status : null,
      rollbackRef: action === 'rollback' ? reference : null,
      rollbackReason: action === 'rollback' ? reason : null,
      action,
      actor,
      requestId,
      payload,
      response: null,
      success: true,
      receivedAt,
    })

    const eventType = action === 'rollout' ? 'github.rollout_reported' : 'github.rollback_reported'
    void emitAuditEventBestEffort({
      entityType: 'GithubWriteAction',
      entityId: randomUUID(),
      eventType,
      context: auditContext,
      details: {
        repository,
        prNumber: input.number,
        action,
        missionId,
        stage,
        reference,
        status,
        success: true,
      },
    })

    return { ok: true, action, missionId, stage, reference, status, reason }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const pullState = await store.getPull({ repository, prNumber: input.number }).catch(() => ({ pull: null }))
    const pull = pullState.pull
    const riskClass = parseRiskClass(pull?.labels)
    await store.insertWriteAudit({
      repository,
      prNumber: input.number,
      commitSha: pull?.headSha ?? null,
      missionId,
      stage,
      actionClass: 'autonomous',
      riskClass,
      rolloutRef: action === 'rollout' ? reference : null,
      rolloutStatus: action === 'rollout' ? status : null,
      rollbackRef: action === 'rollback' ? reference : null,
      rollbackReason: action === 'rollback' ? reason : null,
      action,
      actor,
      requestId,
      payload: { action, missionId, stage, reference, status, reason },
      response: null,
      success: false,
      error: message,
      receivedAt,
    })
    throw error
  } finally {
    await store.close()
  }
}
