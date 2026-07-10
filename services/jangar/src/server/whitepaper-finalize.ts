import { createGitHubClient } from '~/server/github-client'
import { asRecord, asString, readNested } from '@proompteng/agent-contracts'
import { resolveWhitepaperControlConfig, resolveWhitepaperGitHubConfig } from '~/server/whitepaper-config'

const WHITEPAPER_RUN_ID_PREFIX = 'wp-'
const WHITEPAPER_FINALIZE_TIMEOUT_MS = 15_000

export type WhitepaperFinalizeTerminalStatusInput = {
  resource: Record<string, unknown>
  nextStatus: Record<string, unknown>
  previousPhase: string | null
  nextPhase: string
}

type WhitepaperOutputBranchResult =
  | {
      status: 'success'
      synthesis: Record<string, unknown>
      verdict: Record<string, unknown>
      github: ReturnType<typeof createGitHubClient>
    }
  | {
      status: 'missing_token' | 'not_found' | 'invalid_json'
      detail: string | null
    }
  | {
      status: 'fetch_error'
      retryable: boolean
      detail: string | null
    }

type WhitepaperOutputsResult =
  | {
      ok: true
      branch: string
      synthesis: Record<string, unknown>
      verdict: Record<string, unknown>
      designPullRequest: Record<string, unknown> | null
    }
  | {
      ok: false
      failureReason: string
      detail: string | null
    }

const whitepaperFinalizeEnabled = () => resolveWhitepaperControlConfig(process.env).enabled
const resolveWhitepaperOutputFetchAttempts = () => resolveWhitepaperControlConfig(process.env).outputFetchAttempts
const resolveWhitepaperOutputFetchDelayMs = () => resolveWhitepaperControlConfig(process.env).outputFetchDelayMs
const resolveWhitepaperFinalizeBaseUrl = () => resolveWhitepaperControlConfig(process.env).baseUrl

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const logWhitepaperFinalizeInfo = (message: string, details?: Record<string, unknown>) => {
  if (details) {
    console.info('[jangar][whitepaper-finalize]', message, details)
    return
  }
  console.info('[jangar][whitepaper-finalize]', message)
}

const logWhitepaperFinalizeWarn = (message: string, details?: Record<string, unknown>) => {
  if (details) {
    console.warn('[jangar][whitepaper-finalize]', message, details)
    return
  }
  console.warn('[jangar][whitepaper-finalize]', message)
}

const toLogError = (error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
})

const resolveParameters = (resource: Record<string, unknown>) =>
  asRecord(readNested(resource, ['spec', 'parameters'])) ?? {}

const resolveParam = (params: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = asString(params[key])
    if (value?.trim()) return value.trim()
  }
  return ''
}

const resolveWhitepaperFinalizeToken = () => resolveWhitepaperControlConfig(process.env).token

const buildWhitepaperArtifactPayloads = (rawArtifacts: unknown) => {
  if (!Array.isArray(rawArtifacts)) return []
  const payloads: Array<Record<string, unknown>> = []
  for (const entry of rawArtifacts) {
    const artifact = asRecord(entry)
    if (!artifact) continue
    const name = asString(artifact.name)?.trim()
    if (!name) continue
    const payload: Record<string, unknown> = {
      artifact_scope: 'run',
      artifact_type: 'agentrun_output',
      artifact_role: name,
    }
    const key = asString(artifact.key)?.trim()
    if (key) payload.ceph_object_key = key
    const uri = asString(artifact.url)?.trim() || asString(artifact.path)?.trim()
    if (uri) payload.artifact_uri = uri
    payload.metadata = artifact
    payloads.push(payload)
  }
  return payloads
}

const safeParseJsonRecord = (value: string) => {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const normalizeGitBranch = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length)
  if (trimmed.startsWith('heads/')) return trimmed.slice('heads/'.length)
  if (trimmed.startsWith('refs/')) return trimmed.slice('refs/'.length)
  return trimmed
}

const parseRepositoryParts = (repository: string) => {
  const trimmed = repository.trim()
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (!owner || !repo) return null
  return { owner, repo }
}

const collectErrorMessages = (error: unknown, seen = new Set<unknown>()): string[] => {
  if (error == null || seen.has(error)) return []
  if (typeof error === 'string') return error.trim() ? [error.trim()] : []
  if (typeof error !== 'object') return []

  seen.add(error)
  const messages: string[] = []
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (message) messages.push(message)
  if (record.cause) messages.push(...collectErrorMessages(record.cause, seen))
  if (record.error) messages.push(...collectErrorMessages(record.error, seen))
  return messages
}

const summarizeErrorMessage = (error: unknown) => {
  const messages = collectErrorMessages(error)
  return messages[0] ?? (error instanceof Error ? error.toString() : String(error))
}

const parseGitHubStatusCode = (error: unknown) => {
  for (const message of collectErrorMessages(error)) {
    const match = message.match(/GitHub API (\d{3})\b/)
    if (!match) continue
    const status = Number.parseInt(match[1] ?? '', 10)
    if (Number.isFinite(status)) return status
  }
  return null
}

const isRetryableGitHubStatusCode = (statusCode: number | null) => {
  if (statusCode == null) return true
  if (statusCode === 408 || statusCode === 409 || statusCode === 423 || statusCode === 425 || statusCode === 429) {
    return true
  }
  return statusCode >= 500
}

const fetchWhitepaperOutputFromBranch = async (input: {
  owner: string
  repo: string
  branch: string
  runId: string
}): Promise<WhitepaperOutputBranchResult> => {
  const githubConfig = resolveWhitepaperGitHubConfig(process.env)
  const githubToken = githubConfig.token
  if (!githubToken) {
    return {
      status: 'missing_token',
      detail: 'GITHUB_TOKEN or GH_TOKEN is required to fetch whitepaper outputs from GitHub',
    }
  }
  const github = createGitHubClient({
    token: githubToken,
    apiBaseUrl: githubConfig.apiBaseUrl,
  })
  const root = `docs/whitepapers/${input.runId}`
  try {
    const [synthesisFile, verdictFile] = await Promise.all([
      github.getFile(input.owner, input.repo, `${root}/synthesis.json`, input.branch),
      github.getFile(input.owner, input.repo, `${root}/verdict.json`, input.branch),
    ])
    const synthesis = safeParseJsonRecord(synthesisFile.content)
    const verdict = safeParseJsonRecord(verdictFile.content)
    if (!synthesis || !verdict) {
      return {
        status: 'invalid_json',
        detail: `whitepaper outputs on ${input.branch} are not valid JSON objects`,
      }
    }
    return { status: 'success', synthesis, verdict, github }
  } catch (error) {
    const statusCode = parseGitHubStatusCode(error)
    if (statusCode === 404) {
      return {
        status: 'not_found',
        detail: summarizeErrorMessage(error),
      }
    }
    return {
      status: 'fetch_error',
      retryable: isRetryableGitHubStatusCode(statusCode),
      detail: summarizeErrorMessage(error),
    }
  }
}

const fetchWhitepaperOutputs = async (input: {
  repository: string
  runId: string
  headBranch: string
  baseBranch: string
}): Promise<WhitepaperOutputsResult> => {
  const parts = parseRepositoryParts(input.repository)
  if (!parts) {
    return {
      ok: false,
      failureReason: 'whitepaper_repository_invalid',
      detail: `repository must be in owner/repo form, got "${input.repository}"`,
    }
  }

  const branchCandidates = [input.headBranch, input.baseBranch, 'main']
    .map((branch) => normalizeGitBranch(branch))
    .filter((branch, index, list) => branch.length > 0 && list.indexOf(branch) === index)
  const maxAttempts = resolveWhitepaperOutputFetchAttempts()
  const retryDelayMs = resolveWhitepaperOutputFetchDelayMs()
  let lastFailure: { failureReason: string; detail: string | null } = {
    failureReason: 'whitepaper_outputs_missing',
    detail: null,
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sawRetryableFailure = false

    for (const branch of branchCandidates) {
      const outputs = await fetchWhitepaperOutputFromBranch({
        owner: parts.owner,
        repo: parts.repo,
        branch,
        runId: input.runId,
      })
      if (outputs.status === 'success') {
        let designPullRequest: Record<string, unknown> | null = null
        try {
          const pullRequest = await outputs.github.getPullRequestByHead(
            parts.owner,
            parts.repo,
            `${parts.owner}:${branch}`,
          )
          if (pullRequest) {
            designPullRequest = {
              status: pullRequest.state === 'open' ? 'opened' : pullRequest.state,
              repository: input.repository,
              base_branch: pullRequest.baseRef,
              head_branch: pullRequest.headRef,
              pr_number: pullRequest.number,
              pr_url: pullRequest.htmlUrl,
              title: pullRequest.title,
              body: pullRequest.body,
              commit_sha: pullRequest.headSha,
            }
          }
        } catch (error) {
          logWhitepaperFinalizeWarn('failed to resolve design PR', {
            repository: input.repository,
            runId: input.runId,
            branch,
            ...toLogError(error),
          })
        }

        return {
          ok: true,
          branch,
          synthesis: outputs.synthesis,
          verdict: outputs.verdict,
          designPullRequest,
        }
      }

      if (outputs.status === 'missing_token') {
        return { ok: false, failureReason: 'whitepaper_github_token_missing', detail: outputs.detail }
      }
      if (outputs.status === 'invalid_json') {
        return { ok: false, failureReason: 'whitepaper_output_invalid', detail: outputs.detail }
      }
      if (outputs.status === 'fetch_error') {
        if (!outputs.retryable) {
          return { ok: false, failureReason: 'whitepaper_output_fetch_failed', detail: outputs.detail }
        }
        sawRetryableFailure = true
        lastFailure = { failureReason: 'whitepaper_output_fetch_failed', detail: outputs.detail }
        continue
      }

      sawRetryableFailure = true
      lastFailure = { failureReason: 'whitepaper_outputs_missing', detail: outputs.detail }
    }

    if (!sawRetryableFailure || attempt >= maxAttempts) break
    logWhitepaperFinalizeInfo('outputs not visible yet; retrying finalize fetch', {
      repository: input.repository,
      runId: input.runId,
      attempt,
      maxAttempts,
      retryDelayMs,
      headBranch: branchCandidates[0] ?? null,
      baseBranch: branchCandidates[1] ?? null,
      detail: lastFailure.detail,
    })
    await wait(retryDelayMs)
  }

  return {
    ok: false,
    failureReason: lastFailure.failureReason,
    detail: lastFailure.detail,
  }
}

const postWhitepaperFinalize = async (runId: string, payload: Record<string, unknown>) => {
  const baseUrl = resolveWhitepaperFinalizeBaseUrl().replace(/\/+$/, '')
  const token = resolveWhitepaperFinalizeToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WHITEPAPER_FINALIZE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/whitepapers/runs/${encodeURIComponent(runId)}/finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`whitepaper finalize failed: ${response.status} ${response.statusText} ${raw}`.trim())
    }
  } finally {
    clearTimeout(timeout)
  }
}

export const maybeFinalizeWhitepaperRun = async (input: WhitepaperFinalizeTerminalStatusInput) => {
  if (!whitepaperFinalizeEnabled()) return
  const { resource, nextStatus, nextPhase } = input
  const params = resolveParameters(resource)
  const runId = resolveParam(params, ['runId', 'run_id']).trim()
  if (!runId || !runId.startsWith(WHITEPAPER_RUN_ID_PREFIX)) return
  if (!['Succeeded', 'Failed', 'Cancelled'].includes(nextPhase)) return

  const repository =
    resolveParam(params, ['repository', 'repo']) ||
    asString(readNested(nextStatus, ['vcs', 'repository'])) ||
    asString(readNested(resource, ['status', 'vcs', 'repository'])) ||
    ''
  const headBranch =
    resolveParam(params, ['head', 'headBranch', 'branch']) ||
    asString(readNested(nextStatus, ['vcs', 'headBranch'])) ||
    asString(readNested(resource, ['status', 'vcs', 'headBranch'])) ||
    ''
  const baseBranch =
    resolveParam(params, ['base', 'baseBranch']) ||
    asString(readNested(nextStatus, ['vcs', 'baseBranch'])) ||
    asString(readNested(resource, ['status', 'vcs', 'baseBranch'])) ||
    'main'

  const payload: Record<string, unknown> = {
    status: nextPhase === 'Succeeded' ? 'completed' : 'failed',
    source: 'jangar-whitepaper-finalize-consumer',
    agentrun_name: asString(readNested(resource, ['metadata', 'name'])) ?? null,
    artifacts: buildWhitepaperArtifactPayloads(readNested(nextStatus, ['artifacts'])),
  }

  if (nextPhase !== 'Succeeded') {
    payload.failure_reason = nextPhase === 'Cancelled' ? 'agentrun_cancelled' : 'agentrun_failed'
    await postWhitepaperFinalize(runId, payload)
    return
  }

  if (!repository) {
    payload.status = 'failed'
    payload.failure_reason = 'whitepaper_repository_missing'
    await postWhitepaperFinalize(runId, payload)
    return
  }

  const outputs = await fetchWhitepaperOutputs({
    repository,
    runId,
    headBranch,
    baseBranch,
  })
  if (!outputs.ok) {
    payload.status = 'failed'
    payload.failure_reason = outputs.failureReason
    payload.repository = repository
    payload.head_branch = normalizeGitBranch(headBranch)
    payload.base_branch = normalizeGitBranch(baseBranch) || 'main'
    if (outputs.detail) payload.failure_detail = outputs.detail
    await postWhitepaperFinalize(runId, payload)
    return
  }

  payload.repository = repository
  payload.head_branch = outputs.branch
  payload.base_branch = normalizeGitBranch(baseBranch) || 'main'
  payload.synthesis = outputs.synthesis
  payload.verdict = outputs.verdict
  if (outputs.designPullRequest) payload.design_pull_request = outputs.designPullRequest
  await postWhitepaperFinalize(runId, payload)
}
