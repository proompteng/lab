import { readFile } from 'node:fs/promises'

import { createTemporalClient, loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { createGitHubClient } from '~/server/github-client'
import { createKubeGateway, type KubeGateway } from '~/server/kube-gateway'
import { startResourceWatch } from '~/server/kube-watch'
import {
  recordAgentConcurrency,
  recordAgentRunOutcome,
  recordAgentRunResyncAdoptions,
  recordAgentRunUntouchedBacklog,
  recordAgentRunUntouchedOldestAgeSeconds,
  recordReconcileDurationMs,
} from '~/server/metrics'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'
import { shouldApplyStatus } from '~/server/status-utils'
import { createAgentRunReconciler } from './agent-run-reconciler'
import {
  buildArtifactsLimitMessage,
  limitAgentRunStatusArtifacts,
  resolveAgentRunArtifactsLimitConfig,
} from './agentrun-artifacts'
import { deriveStandardConditionUpdates, normalizeConditions, upsertCondition } from './conditions'
import { checkCrds, parseConcurrency, parseQueueLimits, parseRateLimits, runKubectl } from './controller-config'
import { parseBooleanEnv, parseNumberEnv, parseOptionalNumber } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import {
  applyJobTtlAfterStatus,
  buildRunSpec,
  makeName,
  normalizeLabelValue,
  resolveRunnerServiceAccount,
  submitJobRun,
} from './job-runtime'
import {
  markAgentsControllerStarted,
  markAgentsControllerStartFailed,
  requestAgentsControllerStart,
  requestAgentsControllerStop,
} from './lifecycle-machine'
import {
  type AgentRunIngestionRuntimeState,
  type AgentsControllerMutableState,
  type CrdCheckState,
  createMutableState,
} from './mutable-state'
import {
  type ControllerState,
  ensureNamespaceState,
  listItems,
  snapshotNamespace,
  updateStateMap,
} from './namespace-state'
import { buildInFlightCounts } from './queue-state'
import { resetControllerRateState as resetControllerRateStateMaps } from './rate-limits'
import { createResourceReconcilers } from './resource-reconcilers'
import { resolveParam, resolveParameters } from './run-utils'
import { createTemporalRuntimeTools } from './temporal-runtime'
import { resolveVcsAuthMethod, validateVcsAuthConfig } from './vcs-auth'
import {
  clearGithubAppTokenCache,
  fetchGithubAppToken,
  parseIntOrString,
  resolveAuthSecretConfig,
  resolveSecretValue,
  resolveVcsContext,
  resolveVcsPrRateLimits,
  secretHasKey,
} from './vcs-context'
import { createWorkflowReconciler } from './workflow-reconciler'
import { validateAutonomousCodexAuthSecret } from './policy'
import {
  logAgentsControllerDebug,
  logAgentsControllerError,
  logAgentsControllerInfo,
  logAgentsControllerWarn,
  toLogError,
} from './operational-logging'

const DEFAULT_NAMESPACES = ['agents']
const DEFAULT_AGENTRUN_RETENTION_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const IMPLEMENTATION_TEXT_LIMIT = 128 * 1024
const DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS = 30
const DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY = 'jangar.agents_controller.enabled'
const DEFAULT_AGENTRUN_RESYNC_INTERVAL_SECONDS = 60
const DEFAULT_AGENTRUN_UNTOUCHED_WARN_AFTER_SECONDS = 120
const WHITEPAPER_RUN_ID_PREFIX = 'wp-'
const DEFAULT_WHITEPAPER_FINALIZE_BASE_URL = 'http://torghut.torghut.svc.cluster.local'
const DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'
const WHITEPAPER_FINALIZE_TIMEOUT_MS = 15_000
const DEFAULT_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS = 12
const DEFAULT_WHITEPAPER_OUTPUT_FETCH_DELAY_MS = 5_000

const BASE_REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
]
const VCS_PROVIDER_CRD = 'versioncontrolproviders.agents.proompteng.ai'

const isVcsProvidersEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true)

const isAgentRunImmutabilityEnforced = () => parseBooleanEnv(process.env.JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED, true)
const isAgentCommsSubscriberEnabled = () => !parseBooleanEnv(process.env.JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED, false)

const resolveRequiredCrds = () => {
  if (!isVcsProvidersEnabled()) return BASE_REQUIRED_CRDS
  return [...BASE_REQUIRED_CRDS.slice(0, 5), VCS_PROVIDER_CRD, ...BASE_REQUIRED_CRDS.slice(5)]
}

const resolveNatsDependency = () => ({
  enabled: isAgentCommsSubscriberEnabled(),
  url: process.env.NATS_URL?.trim(),
})

type ControllerHealthState = {
  started: boolean
  crdCheckState: CrdCheckState | null
  namespaces: string[] | null
  agentRunIngestion: AgentRunIngestionHealth[]
}

export type AgentRunIngestionHealth = {
  namespace: string
  lastWatchEventAt: string | null
  lastResyncAt: string | null
  untouchedRunCount: number
  oldestUntouchedAgeSeconds: number | null
}

export type AgentRunIngestionAssessment = AgentRunIngestionHealth & {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  dispatchPaused: boolean
}

export type AgentsControllerHealth = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
  agentRunIngestion?: AgentRunIngestionHealth[]
}

const globalState = globalThis as typeof globalThis & {
  __jangarAgentsControllerState?: ControllerHealthState
}

const controllerState = (() => {
  if (globalState.__jangarAgentsControllerState) return globalState.__jangarAgentsControllerState
  const initial = { started: false, crdCheckState: null, namespaces: null, agentRunIngestion: [] }
  globalState.__jangarAgentsControllerState = initial
  return initial
})()

let runtimeMutableState: AgentsControllerMutableState<ControllerState> = createMutableState<ControllerState>({
  started: controllerState.started,
  crdCheckState: controllerState.crdCheckState,
})

const hasActiveControllerRuntimeState = (state: AgentsControllerMutableState<ControllerState>) =>
  state.started ||
  state.starting ||
  state.reconciling ||
  state.watchHandles.length > 0 ||
  state.controllerSnapshot !== null

const initializeRuntimeMutableStateForLayer = () => {
  if (hasActiveControllerRuntimeState(runtimeMutableState)) {
    runtimeMutableState.crdCheckState = controllerState.crdCheckState
    return
  }
  runtimeMutableState = createMutableState<ControllerState>({
    started: controllerState.started,
    crdCheckState: controllerState.crdCheckState,
  })
}

const nowIso = () => new Date().toISOString()

const resolveAgentRunResyncIntervalSeconds = () =>
  parseNumberEnv(
    process.env.JANGAR_AGENTS_CONTROLLER_RESYNC_INTERVAL_SECONDS,
    DEFAULT_AGENTRUN_RESYNC_INTERVAL_SECONDS,
    1,
  )

const resolveAgentRunUntouchedWarnAfterSeconds = () =>
  parseNumberEnv(
    process.env.JANGAR_AGENTS_CONTROLLER_UNTOUCHED_WARN_AFTER_SECONDS,
    DEFAULT_AGENTRUN_UNTOUCHED_WARN_AFTER_SECONDS,
    1,
  )

const createDefaultAgentRunIngestionRuntimeState = (): AgentRunIngestionRuntimeState => ({
  lastWatchEventAtMs: null,
  lastResyncAtMs: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
  degradedSinceMs: null,
  healthyResyncStreak: 0,
  lastResyncSummarySignature: null,
  lastStallSignature: null,
})

const getAgentRunIngestionRuntimeState = (namespace: string) => {
  const existing = runtimeMutableState.agentRunIngestionState.get(namespace)
  if (existing) return existing
  const created = createDefaultAgentRunIngestionRuntimeState()
  runtimeMutableState.agentRunIngestionState.set(namespace, created)
  return created
}

const buildAgentRunIngestionHealth = (
  namespace: string,
  state: AgentRunIngestionRuntimeState,
): AgentRunIngestionHealth => ({
  namespace,
  lastWatchEventAt: state.lastWatchEventAtMs ? new Date(state.lastWatchEventAtMs).toISOString() : null,
  lastResyncAt: state.lastResyncAtMs ? new Date(state.lastResyncAtMs).toISOString() : null,
  untouchedRunCount: state.untouchedRunCount,
  oldestUntouchedAgeSeconds: state.oldestUntouchedAgeSeconds,
})

const syncControllerAgentRunIngestionHealth = () => {
  controllerState.agentRunIngestion = Array.from(runtimeMutableState.agentRunIngestionState.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespace, state]) => buildAgentRunIngestionHealth(namespace, state))
}

const recordAgentRunWatchEventSeen = (namespace: string) => {
  getAgentRunIngestionRuntimeState(namespace).lastWatchEventAtMs = Date.now()
  syncControllerAgentRunIngestionHealth()
}

const buildDefaultAgentRunIngestionHealth = (namespace: string): AgentRunIngestionHealth => ({
  namespace,
  lastWatchEventAt: null,
  lastResyncAt: null,
  untouchedRunCount: 0,
  oldestUntouchedAgeSeconds: null,
})

const isAgentRunIngestionBlind = (entry: AgentRunIngestionHealth) =>
  entry.untouchedRunCount > 0 && entry.lastResyncAt !== null && entry.lastWatchEventAt === null

const isAgentRunIngestionStalled = (entry: AgentRunIngestionHealth) => {
  const warnAfterSeconds = resolveAgentRunUntouchedWarnAfterSeconds()
  const untouchedPastThreshold =
    entry.untouchedRunCount > 0 &&
    entry.oldestUntouchedAgeSeconds !== null &&
    entry.oldestUntouchedAgeSeconds >= warnAfterSeconds
  return untouchedPastThreshold || isAgentRunIngestionBlind(entry)
}

export const assessAgentRunIngestion = (
  namespace: string,
  health: AgentsControllerHealth = getAgentsControllerHealth(),
): AgentRunIngestionAssessment => {
  const entry =
    (health.agentRunIngestion ?? []).find((item) => item.namespace === namespace) ??
    buildDefaultAgentRunIngestionHealth(namespace)
  const runtimeState = runtimeMutableState.agentRunIngestionState.get(namespace)
  const blind = isAgentRunIngestionBlind(entry)
  const stalled = isAgentRunIngestionStalled(entry)
  const recoveryInProgress = Boolean(runtimeState?.degradedSinceMs) && !stalled

  if (stalled || recoveryInProgress) {
    const message = blind
      ? 'no AgentRun watch events observed since controller start while untouched runs exist'
      : stalled
        ? `untouched AgentRuns detected for ${entry.oldestUntouchedAgeSeconds}s`
        : `ingestion recovering (${runtimeState?.healthyResyncStreak ?? 0}/2 healthy resyncs)`
    return {
      ...entry,
      status: 'degraded',
      message,
      dispatchPaused: stalled || Boolean(runtimeState?.degradedSinceMs),
    }
  }

  if (!health.started) {
    return {
      ...entry,
      status: 'unknown',
      message: 'agents controller not started',
      dispatchPaused: false,
    }
  }

  return {
    ...entry,
    status: 'healthy',
    message: 'AgentRun ingestion healthy',
    dispatchPaused: false,
  }
}

const getAgentRunUntouchedReasons = (agentRun: Record<string, unknown>) => {
  const reasons: string[] = []
  const metadata = asRecord(agentRun.metadata) ?? {}
  const status = asRecord(agentRun.status) ?? {}
  const generation = metadata.generation
  const observedGeneration = status.observedGeneration
  const phase = asString(status.phase)
  const finalizers = Array.isArray(metadata.finalizers)
    ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
    : []

  if (!phase) reasons.push('missing_phase')
  if (observedGeneration == null) {
    reasons.push('missing_observed_generation')
  } else if (generation != null && observedGeneration !== generation) {
    reasons.push('generation_drift')
  }
  if (!finalizers.includes('agents.proompteng.ai/runtime-cleanup')) {
    reasons.push('missing_finalizer')
  }
  return reasons
}

const getAgentRunCreationTimestampMs = (agentRun: Record<string, unknown>) => {
  const createdAt = asString(readNested(agentRun, ['metadata', 'creationTimestamp']))
  if (!createdAt) return null
  const parsed = Date.parse(createdAt)
  return Number.isNaN(parsed) ? null : parsed
}

const getListResourceVersion = (payload: Record<string, unknown>) => {
  const resourceVersion = asString(readNested(payload, ['metadata', 'resourceVersion']))
  return resourceVersion?.trim() ? resourceVersion : null
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

const whitepaperFinalizeEnabled = () => parseBooleanEnv(process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED, true)

const resolveWhitepaperOutputFetchAttempts = () =>
  parseNumberEnv(process.env.JANGAR_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS, DEFAULT_WHITEPAPER_OUTPUT_FETCH_ATTEMPTS, 1)

const resolveWhitepaperOutputFetchDelayMs = () =>
  parseNumberEnv(process.env.JANGAR_WHITEPAPER_OUTPUT_FETCH_DELAY_MS, DEFAULT_WHITEPAPER_OUTPUT_FETCH_DELAY_MS, 0)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const resolveWhitepaperFinalizeBaseUrl = () => {
  const fromEnv = asString(process.env.JANGAR_WHITEPAPER_FINALIZE_BASE_URL)?.trim()
  if (fromEnv) return fromEnv
  const fallback = asString(process.env.TORGHUT_BASE_URL)?.trim()
  if (fallback) return fallback
  return DEFAULT_WHITEPAPER_FINALIZE_BASE_URL
}

const resolveWhitepaperFinalizeToken = async () => {
  const explicitToken =
    asString(process.env.JANGAR_WHITEPAPER_FINALIZE_TOKEN)?.trim() ||
    asString(process.env.WHITEPAPER_WORKFLOW_API_TOKEN)?.trim() ||
    asString(process.env.JANGAR_API_KEY)?.trim()
  if (explicitToken) return explicitToken

  const useServiceAccountToken = parseBooleanEnv(process.env.JANGAR_WHITEPAPER_FINALIZE_USE_SERVICE_ACCOUNT_TOKEN, true)
  if (!useServiceAccountToken) return null
  const tokenPath = asString(process.env.JANGAR_WHITEPAPER_SERVICE_ACCOUNT_TOKEN_PATH)?.trim()
  const resolvedPath = tokenPath || DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH

  try {
    const token = (await readFile(resolvedPath, 'utf8')).trim()
    return token || null
  } catch {
    return null
  }
}

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

const collectErrorMessages = (error: unknown, seen = new Set<unknown>()): string[] => {
  if (error == null || seen.has(error)) return []
  if (typeof error === 'string') return error.trim() ? [error.trim()] : []
  if (typeof error !== 'object') return []

  seen.add(error)
  const messages: string[] = []
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (message) messages.push(message)

  if (record.cause) {
    messages.push(...collectErrorMessages(record.cause, seen))
  }
  if (record.error) {
    messages.push(...collectErrorMessages(record.error, seen))
  }

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
  const githubToken = asString(process.env.GITHUB_TOKEN)?.trim() || asString(process.env.GH_TOKEN)?.trim() || null
  if (!githubToken) {
    return {
      status: 'missing_token',
      detail: 'GITHUB_TOKEN or GH_TOKEN is required to fetch whitepaper outputs from GitHub',
    }
  }
  const githubApiBaseUrl = asString(process.env.GITHUB_API_BASE_URL)?.trim() || DEFAULT_GITHUB_API_BASE_URL
  const github = createGitHubClient({
    token: githubToken,
    apiBaseUrl: githubApiBaseUrl,
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
          logAgentsControllerWarn('whitepaper finalize failed to resolve design PR', {
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
        return {
          ok: false,
          failureReason: 'whitepaper_github_token_missing',
          detail: outputs.detail,
        }
      }

      if (outputs.status === 'invalid_json') {
        return {
          ok: false,
          failureReason: 'whitepaper_output_invalid',
          detail: outputs.detail,
        }
      }

      if (outputs.status === 'fetch_error') {
        if (!outputs.retryable) {
          return {
            ok: false,
            failureReason: 'whitepaper_output_fetch_failed',
            detail: outputs.detail,
          }
        }
        sawRetryableFailure = true
        lastFailure = {
          failureReason: 'whitepaper_output_fetch_failed',
          detail: outputs.detail,
        }
        continue
      }

      sawRetryableFailure = true
      lastFailure = {
        failureReason: 'whitepaper_outputs_missing',
        detail: outputs.detail,
      }
    }

    if (!sawRetryableFailure || attempt >= maxAttempts) {
      break
    }

    logAgentsControllerInfo('whitepaper outputs not visible yet; retrying finalize fetch', {
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
  const token = await resolveWhitepaperFinalizeToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

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

const maybeFinalizeWhitepaperRun = async (resource: Record<string, unknown>, nextStatus: Record<string, unknown>) => {
  if (!whitepaperFinalizeEnabled()) return
  const params = resolveParameters(resource)
  const runId = resolveParam(params, ['runId', 'run_id']).trim()
  if (!runId || !runId.startsWith(WHITEPAPER_RUN_ID_PREFIX)) return

  const phase = asString(nextStatus.phase) ?? asString(readNested(resource, ['status', 'phase'])) ?? ''
  if (!['Succeeded', 'Failed', 'Cancelled'].includes(phase)) return

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
    status: phase === 'Succeeded' ? 'completed' : 'failed',
    source: 'jangar-agents-controller',
    agentrun_name: asString(readNested(resource, ['metadata', 'name'])) ?? null,
    artifacts: buildWhitepaperArtifactPayloads(readNested(nextStatus, ['artifacts'])),
  }

  if (phase !== 'Succeeded') {
    payload.failure_reason = phase === 'Cancelled' ? 'agentrun_cancelled' : 'agentrun_failed'
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
    if (outputs.detail) {
      payload.failure_detail = outputs.detail
    }
    await postWhitepaperFinalize(runId, payload)
    return
  }

  payload.repository = repository
  payload.head_branch = outputs.branch
  payload.base_branch = normalizeGitBranch(baseBranch) || 'main'
  payload.synthesis = outputs.synthesis
  payload.verdict = outputs.verdict
  if (outputs.designPullRequest) {
    payload.design_pull_request = outputs.designPullRequest
  }
  await postWhitepaperFinalize(runId, payload)
}

const isKubeNotFoundError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('notfound') || normalized.includes(' not found')
}

const hasJobCondition = (job: Record<string, unknown>, conditionType: string) => {
  const status = asRecord(job.status) ?? {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  return conditions.some((entry) => {
    const record = asRecord(entry)
    if (!record) return false
    return asString(record.type) === conditionType && asString(record.status) === 'True'
  })
}

const isJobComplete = (job: Record<string, unknown>) => hasJobCondition(job, 'Complete')

const isJobFailed = (job: Record<string, unknown>) => hasJobCondition(job, 'Failed')

const shouldStart = () => {
  if (process.env.NODE_ENV === 'test') return false
  return parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_ENABLED, true)
}

const shouldStartWithFeatureFlag = async () => {
  if (process.env.NODE_ENV === 'test') return false
  return resolveBooleanFeatureToggle({
    key: DEFAULT_AGENTS_CONTROLLER_ENABLED_FLAG_KEY,
    keyEnvVar: 'JANGAR_AGENTS_CONTROLLER_ENABLED_FLAG_KEY',
    fallbackEnvVar: 'JANGAR_AGENTS_CONTROLLER_ENABLED',
    defaultValue: true,
  })
}

const parseNamespaces = () => {
  return parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
    fallback: DEFAULT_NAMESPACES,
    label: 'agents controller',
  })
}

const resolveCrdCheckNamespace = () => {
  const namespaces = parseNamespaces()
  if (namespaces.includes('*')) return 'default'
  return namespaces[0] ?? 'default'
}

const resolveNamespaces = async (kubeGateway: Pick<KubeGateway, 'listNamespaces'> = createKubeGateway()) => {
  const namespaces = parseNamespaces()
  if (!namespaces.includes('*')) {
    return namespaces
  }
  const resolved = await kubeGateway.listNamespaces()
  if (resolved.length === 0) {
    throw new Error('no namespaces returned by kube gateway')
  }
  return resolved
}

const resolveConfiguredNamespaces = () => {
  try {
    return parseNamespaces()
  } catch {
    return null
  }
}

export const getAgentsControllerHealth = (): AgentsControllerHealth => ({
  enabled: shouldStart(),
  started: controllerState.started,
  namespaces: controllerState.namespaces ?? resolveConfiguredNamespaces(),
  crdsReady: controllerState.crdCheckState?.ok ?? null,
  missingCrds: controllerState.crdCheckState?.missing ?? [],
  lastCheckedAt: controllerState.crdCheckState?.checkedAt ?? null,
  agentRunIngestion: controllerState.agentRunIngestion,
})

const isAgentRunIdempotencyEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED, true)

const resolveAgentRunIdempotencyRetentionDays = () =>
  parseNumberEnv(process.env.JANGAR_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS, DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS, 1)

const getPrimitivesStore = async () => {
  if (runtimeMutableState.primitivesStoreRef) return runtimeMutableState.primitivesStoreRef
  try {
    runtimeMutableState.primitivesStoreRef = createPrimitivesStore()
    await runtimeMutableState.primitivesStoreRef.ready
    return runtimeMutableState.primitivesStoreRef
  } catch (error) {
    runtimeMutableState.primitivesStoreRef = null
    console.warn('[jangar] failed to initialize primitives store (idempotency disabled)', error)
    return null
  }
}

const setStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
) => {
  const metadata = asRecord(resource.metadata) ?? {}
  const name = asString(metadata.name)
  const namespace = asString(metadata.namespace)
  if (!name || !namespace) return
  const apiVersion = asString(resource.apiVersion)
  const kind = asString(resource.kind)
  if (!apiVersion || !kind) return
  let nextStatusBase = status
  if (kind === 'AgentRun' && status.contract === undefined) {
    const existingContract = readNested(resource, ['status', 'contract'])
    if (existingContract) {
      nextStatusBase = { ...status, contract: existingContract }
    }
  }
  if (kind === 'AgentRun' && status.systemPromptHash === undefined) {
    const existingHash = readNested(resource, ['status', 'systemPromptHash'])
    if (existingHash) {
      nextStatusBase = { ...nextStatusBase, systemPromptHash: existingHash }
    }
  }
  if (kind === 'AgentRun' && status.specHash === undefined) {
    const existingHash = readNested(resource, ['status', 'specHash'])
    if (existingHash) {
      nextStatusBase = { ...nextStatusBase, specHash: existingHash }
    }
  }
  if (kind === 'AgentRun' && status.artifacts === undefined) {
    const existingArtifacts = readNested(resource, ['status', 'artifacts'])
    if (existingArtifacts) {
      nextStatusBase = { ...nextStatusBase, artifacts: existingArtifacts }
    }
  }

  let baseConditions = normalizeConditions(nextStatusBase.conditions)
  if (kind === 'AgentRun') {
    if (nextStatusBase.artifacts !== undefined) {
      const config = resolveAgentRunArtifactsLimitConfig()
      const artifactsResult = limitAgentRunStatusArtifacts(nextStatusBase.artifacts, config)
      if (artifactsResult.strictViolation) {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimitExceeded',
          status: 'True',
          reason: artifactsResult.reasons[0] ?? 'LimitExceeded',
          message: buildArtifactsLimitMessage(artifactsResult),
        })
        if (asString(nextStatusBase.phase) !== 'Failed' && asString(nextStatusBase.phase) !== 'Cancelled') {
          nextStatusBase = { ...nextStatusBase, phase: 'Failed', finishedAt: nextStatusBase.finishedAt ?? nowIso() }
        }
      } else if (artifactsResult.trimmedCount || artifactsResult.strippedUrlCount || artifactsResult.droppedCount) {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimited',
          status: 'True',
          reason: artifactsResult.reasons[0] ?? 'Limited',
          message: buildArtifactsLimitMessage(artifactsResult),
        })
      } else {
        baseConditions = upsertCondition(baseConditions, {
          type: 'ArtifactsLimited',
          status: 'False',
          reason: 'WithinLimits',
          message: '',
        })
      }

      nextStatusBase = { ...nextStatusBase, artifacts: artifactsResult.artifacts }
    }
  }

  const phase = asString(nextStatusBase.phase) ?? null
  const standardUpdates = deriveStandardConditionUpdates(baseConditions, phase)
  let conditions = baseConditions
  for (const update of standardUpdates) {
    conditions = upsertCondition(conditions, update)
  }
  if (kind === 'AgentRun' && phase) {
    const normalizedPhase = phase.trim().toLowerCase()
    if (normalizedPhase !== 'pending' && normalizedPhase !== 'queued') {
      conditions = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'False',
        reason: 'NotBlocked',
        message: '',
      })
    }
  }
  const nextStatus = {
    ...nextStatusBase,
    updatedAt: nowIso(),
    conditions,
  }
  if (!shouldApplyStatus(asRecord(resource.status), nextStatus)) {
    return
  }
  if (kind === 'AgentRun') {
    const previousPhase = asString(asRecord(resource.status)?.phase)
    const nextPhase = asString(nextStatusBase.phase)
    if (nextPhase && ['Succeeded', 'Failed', 'Cancelled'].includes(nextPhase) && previousPhase !== nextPhase) {
      const runtimeRef = asRecord(status.runtimeRef) ?? asRecord(readNested(resource, ['status', 'runtimeRef'])) ?? {}
      const runtimeType =
        asString(runtimeRef.type) ?? asString(readNested(resource, ['spec', 'runtime', 'type'])) ?? 'unknown'
      recordAgentRunOutcome(nextPhase, { runtime: runtimeType })
      try {
        await maybeFinalizeWhitepaperRun(resource, nextStatus)
      } catch (error) {
        console.warn('[jangar] whitepaper finalize callback failed', {
          runId: resolveParam(resolveParameters(resource), ['runId', 'run_id']) || null,
          phase: nextPhase,
          error,
        })
      }
    }
  }
  await kube.applyStatus({ apiVersion, kind, metadata: { name, namespace }, status: nextStatus })
}

const resolveJobImage = (workload: Record<string, unknown>) =>
  asString(workload.image) ?? process.env.JANGAR_AGENT_RUNNER_IMAGE ?? process.env.JANGAR_AGENT_IMAGE ?? null

const getTemporalClient = async () => {
  if (!runtimeMutableState.temporalClientPromise) {
    runtimeMutableState.temporalClientPromise = (async () => {
      const config = await loadTemporalConfig({
        defaults: {
          host: DEFAULT_TEMPORAL_HOST,
          port: DEFAULT_TEMPORAL_PORT,
          address: DEFAULT_TEMPORAL_ADDRESS,
        },
      })
      return createTemporalClient({ config })
    })()
  }
  const { client } = await runtimeMutableState.temporalClientPromise
  return client
}

const parseAgentRunRetentionSeconds = () => {
  const parsed = parseOptionalNumber(process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS)
  if (parsed === undefined || parsed < 0) return DEFAULT_AGENTRUN_RETENTION_SECONDS
  return Math.floor(parsed)
}

const resolveAgentRunRetentionSeconds = (spec: Record<string, unknown>) => {
  const override = parseOptionalNumber(spec.ttlSecondsAfterFinished)
  if (override !== undefined && override >= 0) return Math.floor(override)
  return parseAgentRunRetentionSeconds()
}

const resetControllerRateState = () => {
  resetControllerRateStateMaps(runtimeMutableState.controllerRateState)
}

const enqueueNamespaceTask = (namespace: string, task: () => Promise<void>) => {
  logAgentsControllerDebug('namespace_task_enqueued', { namespace })
  const current = runtimeMutableState.namespaceQueues.get(namespace) ?? Promise.resolve()
  const next = current
    .catch(() => undefined)
    .then(async () => {
      const startedAt = Date.now()
      logAgentsControllerDebug('namespace_task_started', { namespace })
      try {
        await task()
      } finally {
        logAgentsControllerDebug('namespace_task_completed', {
          namespace,
          durationMs: Date.now() - startedAt,
        })
      }
    })
    .catch((error) => {
      logAgentsControllerWarn('namespace_task_failed', {
        namespace,
        ...toLogError(error),
      })
    })
  runtimeMutableState.namespaceQueues.set(namespace, next)
  return next
}

const resyncAgentRunsForNamespace = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  reason: 'periodic' | 'watch_restart' | 'manual',
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const runList = listItems(await kube.list(RESOURCE_MAP.AgentRun, namespace))
  const refreshedRuns = new Map<string, Record<string, unknown>>()
  const candidateRuns: Array<{ run: Record<string, unknown>; reasons: string[] }> = []
  let untouchedRunCount = 0
  let oldestUntouchedAgeSeconds: number | null = null
  const now = Date.now()

  for (const run of runList) {
    const name = asString(readNested(run, ['metadata', 'name']))
    if (!name) continue
    refreshedRuns.set(name, run)
    const reasons = getAgentRunUntouchedReasons(run)
    const untouchedReasons = reasons.filter((entry) => entry !== 'generation_drift')
    if (untouchedReasons.length > 0) {
      untouchedRunCount += 1
      const createdAtMs = getAgentRunCreationTimestampMs(run)
      if (createdAtMs !== null) {
        const ageSeconds = Math.max(0, Math.floor((now - createdAtMs) / 1000))
        oldestUntouchedAgeSeconds =
          oldestUntouchedAgeSeconds === null ? ageSeconds : Math.max(oldestUntouchedAgeSeconds, ageSeconds)
      }
    }
    if (reasons.length > 0) {
      candidateRuns.push({ run, reasons })
    }
  }

  nsState.runs = refreshedRuns

  const ingestionState = getAgentRunIngestionRuntimeState(namespace)
  ingestionState.lastResyncAtMs = now
  ingestionState.untouchedRunCount = untouchedRunCount
  ingestionState.oldestUntouchedAgeSeconds = oldestUntouchedAgeSeconds
  const warnAfterSeconds = resolveAgentRunUntouchedWarnAfterSeconds()
  const blindSinceStart = untouchedRunCount > 0 && ingestionState.lastWatchEventAtMs === null
  const stallSignature =
    (untouchedRunCount > 0 && oldestUntouchedAgeSeconds !== null && oldestUntouchedAgeSeconds >= warnAfterSeconds) ||
    blindSinceStart
      ? [
          untouchedRunCount,
          oldestUntouchedAgeSeconds ?? 'none',
          warnAfterSeconds,
          blindSinceStart ? 'blind' : 'seen',
        ].join(':')
      : null
  if (stallSignature) {
    if (ingestionState.degradedSinceMs === null) {
      ingestionState.degradedSinceMs = now
    }
    ingestionState.healthyResyncStreak = 0
    if (ingestionState.lastStallSignature !== stallSignature) {
      logAgentsControllerWarn('agentrun_ingestion_stalled', {
        namespace,
        reason,
        untouchedRunCount,
        oldestUntouchedAgeSeconds,
        warnAfterSeconds,
        blindSinceStart,
      })
      ingestionState.lastStallSignature = stallSignature
    }
  } else {
    if (ingestionState.degradedSinceMs !== null) {
      ingestionState.healthyResyncStreak += 1
      if (ingestionState.healthyResyncStreak >= 2) {
        logAgentsControllerInfo('agentrun_ingestion_recovered', {
          namespace,
          reason,
          untouchedRunCount,
          oldestUntouchedAgeSeconds,
        })
        ingestionState.degradedSinceMs = null
        ingestionState.healthyResyncStreak = 0
        ingestionState.lastStallSignature = null
      }
    } else {
      ingestionState.healthyResyncStreak = 0
      ingestionState.lastStallSignature = null
    }
  }

  syncControllerAgentRunIngestionHealth()

  recordAgentRunUntouchedBacklog(untouchedRunCount, { namespace, reason })
  if (oldestUntouchedAgeSeconds !== null) {
    recordAgentRunUntouchedOldestAgeSeconds(oldestUntouchedAgeSeconds, { namespace, reason })
  }

  if (candidateRuns.length > 0) {
    recordAgentRunResyncAdoptions(candidateRuns.length, { namespace, reason })
  }

  const resyncSummarySignature = [
    refreshedRuns.size,
    candidateRuns.length,
    untouchedRunCount,
    oldestUntouchedAgeSeconds ?? 'none',
    blindSinceStart ? 'blind' : 'seen',
    ingestionState.healthyResyncStreak,
  ].join(':')
  const shouldLogResyncSummary =
    reason !== 'periodic' ||
    candidateRuns.length > 0 ||
    ingestionState.lastResyncSummarySignature !== resyncSummarySignature
  if (shouldLogResyncSummary) {
    logAgentsControllerInfo('agentrun_resync_completed', {
      namespace,
      reason,
      totalRuns: refreshedRuns.size,
      candidateCount: candidateRuns.length,
      untouchedRunCount,
      oldestUntouchedAgeSeconds,
      blindSinceStart,
      healthyResyncStreak: ingestionState.healthyResyncStreak,
    })
    ingestionState.lastResyncSummarySignature = resyncSummarySignature
  }

  for (const candidate of candidateRuns) {
    const runName = asString(readNested(candidate.run, ['metadata', 'name'])) ?? 'unknown'
    logAgentsControllerDebug('agentrun_resync_adopted', {
      namespace,
      runName,
      reason,
      adoptionReasons: candidate.reasons,
    })
    await enqueueNamespaceTask(namespace, () =>
      reconcileRunWithState(kube, namespace, candidate.run, state, concurrency),
    )
  }
}

const {
  reconcileAgent,
  reconcileAgentProvider,
  reconcileImplementationSpec,
  reconcileImplementationSource,
  reconcileVersionControlProvider,
  reconcileMemory,
} = createResourceReconcilers({
  setStatus: (kube, resource, status) => setStatus(kube as ReturnType<typeof createKubernetesClient>, resource, status),
  nowIso,
  implementationTextLimit: IMPLEMENTATION_TEXT_LIMIT,
  resolveVcsAuthMethod,
  validateVcsAuthConfig,
  parseIntOrString,
  resolveAuthSecretConfig,
  resolveSecretValue,
  secretHasKey,
  validateAutonomousCodexAuthSecret,
})

const buildConditions = (resource: Record<string, unknown>) =>
  normalizeConditions(readNested(resource, ['status', 'conditions']))

const { validateImplementationContract, buildContractStatus } = createImplementationContractTools(resolveParam)

const { submitCustomRun, submitTemporalRun, reconcileTemporalRun } = createTemporalRuntimeTools({
  getTemporalClient,
  resolveParameters,
  buildRunSpec,
  makeName,
  buildConditions,
  nowIso,
  setStatus: (kube, resource, status) =>
    setStatus(
      kube as unknown as ReturnType<typeof createKubernetesClient>,
      resource,
      status as Record<string, unknown>,
    ),
})

const { reconcileWorkflowRun } = createWorkflowReconciler({
  resolveRunnerServiceAccount,
  resolveJobImage,
  validateImplementationContract,
  buildContractStatus,
  buildConditions,
  setStatus,
  nowIso,
  submitJobRun,
  applyJobTtlAfterStatus,
  normalizeLabelValue,
  isJobComplete,
  isJobFailed,
})

const { reconcileAgentRun } = createAgentRunReconciler({
  setStatus,
  nowIso,
  isKubeNotFoundError,
  resolveJobImage,
  resolveAgentRunRetentionSeconds,
  getPrimitivesStore,
  runKubectl,
  getTemporalClient,
  reconcileWorkflowRun,
  submitJobRun,
  submitCustomRun,
  submitTemporalRun,
  reconcileTemporalRun,
  buildConditions,
  isAgentRunImmutabilityEnforced,
  isAgentRunIdempotencyEnabled,
  parseQueueLimits,
  parseRateLimits,
  getControllerSnapshot: () => runtimeMutableState.controllerSnapshot,
  getControllerRateState: () => runtimeMutableState.controllerRateState,
  validateImplementationContract,
  buildContractStatus,
  resolveRunnerServiceAccount,
  applyJobTtlAfterStatus,
  isJobComplete,
  isJobFailed,
})

const reconcileAgentRunWithMetrics = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  namespace: string,
  memories: Record<string, unknown>[],
  existingRuns: Record<string, unknown>[],
  concurrency: ReturnType<typeof parseConcurrency>,
  inFlight: { total: number; perAgent: Map<string, number>; perRepository: Map<string, number> },
  globalInFlight: number,
) => {
  const reconcileStartedAt = Date.now()
  try {
    await reconcileAgentRun(kube, agentRun, namespace, memories, existingRuns, concurrency, inFlight, globalInFlight)
  } finally {
    const durationMs = Date.now() - reconcileStartedAt
    recordReconcileDurationMs(durationMs, { kind: 'agentrun', namespace })
  }
}

const reconcileNamespaceSnapshot = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  snapshot: ReturnType<typeof snapshotNamespace>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const { agents, providers, specs, sources, vcsProviders, memories, runs } = snapshot

  for (const memory of memories) {
    await reconcileMemory(kube, memory, namespace)
  }

  for (const agent of agents) {
    await reconcileAgent(kube, agent, namespace, providers, memories)
  }

  for (const provider of providers) {
    await reconcileAgentProvider(kube, provider)
  }

  for (const spec of specs) {
    await reconcileImplementationSpec(kube, spec)
  }

  for (const source of sources) {
    await reconcileImplementationSource(kube, source, namespace)
  }

  if (isVcsProvidersEnabled()) {
    for (const vcsProvider of vcsProviders) {
      await reconcileVersionControlProvider(kube, vcsProvider, namespace)
    }
  }

  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
    perRepository: counts.perRepository,
  }
  recordAgentConcurrency(counts.total, { scope: 'namespace', namespace })
  recordAgentConcurrency(counts.cluster, { scope: 'cluster' })

  for (const run of runs) {
    await reconcileAgentRunWithMetrics(kube, run, namespace, memories, runs, concurrency, inFlight, counts.cluster)
  }
}

const reconcileRunWithState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  run: Record<string, unknown>,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  const counts = buildInFlightCounts(state, namespace)
  const inFlight = {
    total: counts.total,
    perAgent: counts.perAgent,
    perRepository: counts.perRepository,
  }
  await reconcileAgentRunWithMetrics(
    kube,
    run,
    namespace,
    snapshot.memories,
    snapshot.runs,
    concurrency,
    inFlight,
    counts.cluster,
  )
}

const reconcileNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const snapshot = snapshotNamespace(ensureNamespaceState(state, namespace))
  await reconcileNamespaceSnapshot(kube, namespace, snapshot, state, concurrency)
}

const _reconcileAll = async (
  kube: ReturnType<typeof createKubernetesClient>,
  state: ControllerState,
  namespaces: string[],
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  if (runtimeMutableState.reconciling) return
  runtimeMutableState.reconciling = true
  try {
    if (isAgentRunIdempotencyEnabled()) {
      const now = Date.now()
      if (now - runtimeMutableState.lastIdempotencyPruneAtMs >= 60 * 60 * 1000) {
        const store = await getPrimitivesStore()
        if (store) {
          try {
            const retentionDays = resolveAgentRunIdempotencyRetentionDays()
            await store.pruneAgentRunIdempotencyKeys(retentionDays)
            runtimeMutableState.lastIdempotencyPruneAtMs = now
          } catch (error) {
            console.warn('[jangar] failed to prune AgentRun idempotency keys', error)
          }
        }
      }
    }
    for (const namespace of namespaces) {
      await reconcileNamespaceState(kube, namespace, state, concurrency)
    }
  } catch (error) {
    console.warn('[jangar] agents controller failed', error)
  } finally {
    runtimeMutableState.reconciling = false
  }
}

const seedNamespaceState = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const memoryList = await kube.list(RESOURCE_MAP.Memory, namespace)
  const agentList = await kube.list(RESOURCE_MAP.Agent, namespace)
  const specList = await kube.list(RESOURCE_MAP.ImplementationSpec, namespace)
  const sourceList = await kube.list(RESOURCE_MAP.ImplementationSource, namespace)
  const vcsProviderList = isVcsProvidersEnabled()
    ? await kube.list(RESOURCE_MAP.VersionControlProvider, namespace)
    : null
  const providerList = await kube.list(RESOURCE_MAP.AgentProvider, namespace)
  const runList = await kube.list(RESOURCE_MAP.AgentRun, namespace)
  const memories = listItems(memoryList)
  const agents = listItems(agentList)
  const specs = listItems(specList)
  const sources = listItems(sourceList)
  const vcsProviders = vcsProviderList ? listItems(vcsProviderList) : []
  const providers = listItems(providerList)
  const runs = listItems(runList)

  for (const resource of memories) updateStateMap(nsState.memories, 'ADDED', resource)
  for (const resource of agents) updateStateMap(nsState.agents, 'ADDED', resource)
  for (const resource of specs) updateStateMap(nsState.specs, 'ADDED', resource)
  for (const resource of sources) updateStateMap(nsState.sources, 'ADDED', resource)
  for (const resource of vcsProviders) updateStateMap(nsState.vcsProviders, 'ADDED', resource)
  for (const resource of providers) updateStateMap(nsState.providers, 'ADDED', resource)
  for (const resource of runs) updateStateMap(nsState.runs, 'ADDED', resource)

  enqueueNamespaceTask(namespace, () =>
    reconcileNamespaceSnapshot(kube, namespace, snapshotNamespace(nsState), state, concurrency),
  )

  return {
    agentRunResourceVersion: getListResourceVersion(runList),
  }
}

const startNamespaceWatches = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  state: ControllerState,
  concurrency: ReturnType<typeof parseConcurrency>,
  handles: Array<{ stop: () => void }>,
  options?: { agentRunResourceVersion?: string | null },
) => {
  const nsState = ensureNamespaceState(state, namespace)
  const enqueueFull = () =>
    enqueueNamespaceTask(namespace, () => reconcileNamespaceState(kube, namespace, state, concurrency))

  const handleAgentRunEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'name'])) ?? 'unknown'
    recordAgentRunWatchEventSeen(namespace)
    logAgentsControllerDebug('agentrun_watch_event_seen', {
      namespace,
      runName,
      eventType: event.type ?? 'UNKNOWN',
    })
    updateStateMap(nsState.runs, event.type, resource)
    if (event.type === 'DELETED') return
    enqueueNamespaceTask(namespace, () => reconcileRunWithState(kube, namespace, resource, state, concurrency))
  }

  const handleAgentEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.agents, event.type, resource)
    enqueueFull()
  }

  const handleProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.providers, event.type, resource)
    enqueueFull()
  }

  const handleSpecEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.specs, event.type, resource)
    enqueueFull()
  }

  const handleSourceEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.sources, event.type, resource)
    enqueueFull()
  }

  const handleVcsProviderEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.vcsProviders, event.type, resource)
    enqueueFull()
  }

  const handleMemoryEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    updateStateMap(nsState.memories, event.type, resource)
    enqueueFull()
  }

  const handleJobEvent = (event: { type?: string; object?: Record<string, unknown> }) => {
    const resource = asRecord(event.object)
    if (!resource) return
    const runName = asString(readNested(resource, ['metadata', 'labels', 'agents.proompteng.ai/agent-run']))
    if (!runName) return
    enqueueNamespaceTask(namespace, async () => {
      const existing = nsState.runs.get(runName)
      const run = existing ?? (await kube.get(RESOURCE_MAP.AgentRun, runName, namespace))
      if (!run) return
      nsState.runs.set(runName, run)
      await reconcileRunWithState(kube, namespace, run, state, concurrency)
    })
  }

  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentRun,
      namespace,
      resourceVersion: options?.agentRunResourceVersion ?? undefined,
      onEvent: handleAgentRunEvent,
      onError: (error) =>
        logAgentsControllerWarn('agentrun_watch_failed', {
          namespace,
          ...toLogError(error),
        }),
      onRestart: (restartReason) => {
        logAgentsControllerWarn('agentrun_watch_restarted', {
          namespace,
          reason: restartReason,
        })
        void resyncAgentRunsForNamespace(kube, namespace, state, concurrency, 'watch_restart')
      },
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Agent,
      namespace,
      onEvent: handleAgentEvent,
      onError: (error) => console.warn('[jangar] agent watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.AgentProvider,
      namespace,
      onEvent: handleProviderEvent,
      onError: (error) => console.warn('[jangar] provider watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSpec,
      namespace,
      onEvent: handleSpecEvent,
      onError: (error) => console.warn('[jangar] implementation spec watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.ImplementationSource,
      namespace,
      onEvent: handleSourceEvent,
      onError: (error) => console.warn('[jangar] implementation source watch failed', error),
    }),
  )
  if (isVcsProvidersEnabled()) {
    handles.push(
      startResourceWatch({
        resource: RESOURCE_MAP.VersionControlProvider,
        namespace,
        onEvent: handleVcsProviderEvent,
        onError: (error) => console.warn('[jangar] vcs provider watch failed', error),
      }),
    )
  }
  handles.push(
    startResourceWatch({
      resource: RESOURCE_MAP.Memory,
      namespace,
      onEvent: handleMemoryEvent,
      onError: (error) => console.warn('[jangar] memory watch failed', error),
    }),
  )
  handles.push(
    startResourceWatch({
      resource: 'job',
      namespace,
      labelSelector: 'agents.proompteng.ai/agent-run',
      onEvent: handleJobEvent,
      onError: (error) => console.warn('[jangar] agent job watch failed', error),
    }),
  )

  const resyncInterval = resolveAgentRunResyncIntervalSeconds() * 1000
  const timer = setInterval(() => {
    void resyncAgentRunsForNamespace(kube, namespace, state, concurrency, 'periodic')
  }, resyncInterval)
  handles.push({
    stop: () => clearInterval(timer),
  })

  await resyncAgentRunsForNamespace(kube, namespace, state, concurrency, 'manual')
}

const stopWatchHandles = (handles: Array<{ stop: () => void }>) => {
  for (const handle of handles) {
    handle.stop()
  }
}

const startAgentsControllerInternal = async () => {
  const startAccepted = requestAgentsControllerStart(runtimeMutableState.lifecycleActor)
  if (!startAccepted) return
  runtimeMutableState.starting = true
  runtimeMutableState.started = false
  runtimeMutableState.lifecycleToken += 1
  const token = runtimeMutableState.lifecycleToken
  let featureEnabled = false
  try {
    featureEnabled = await shouldStartWithFeatureFlag()
  } catch (error) {
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    throw error
  }
  if (!featureEnabled) {
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    return
  }
  const kubeGateway = createKubeGateway()
  let crdsReady: CrdCheckState
  try {
    crdsReady = await checkCrds({
      resolveRequiredCrds,
      resolveCrdCheckNamespace,
      resolveNatsDependency,
      nowIso,
      kubeGateway,
    })
    runtimeMutableState.crdCheckState = crdsReady
    controllerState.crdCheckState = crdsReady
  } catch (error) {
    logAgentsControllerError('startup_namespace_scope_failed', toLogError(error))
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
    }
    throw error
  }
  if (!crdsReady.ok) {
    logAgentsControllerError('startup_missing_crds', {
      missingCrds: crdsReady.missing,
    })
    runtimeMutableState.starting = false
    markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    return
  }
  const handles: Array<{ stop: () => void }> = []
  let startupCommitted = false
  try {
    const namespaces = await resolveNamespaces(kubeGateway)
    if (runtimeMutableState.lifecycleToken !== token) return
    controllerState.namespaces = namespaces
    logAgentsControllerInfo('startup_namespace_scope', { namespaces })
    const kube = createKubernetesClient()
    const concurrency = parseConcurrency()
    const state: ControllerState = { namespaces: new Map() }
    const namespaceSeedResults = new Map<string, { agentRunResourceVersion: string | null }>()
    for (const namespace of namespaces) {
      namespaceSeedResults.set(namespace, await seedNamespaceState(kube, namespace, state, concurrency))
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    for (const namespace of namespaces) {
      await startNamespaceWatches(kube, namespace, state, concurrency, handles, namespaceSeedResults.get(namespace))
      if (runtimeMutableState.lifecycleToken !== token) return
    }
    if (runtimeMutableState.lifecycleToken !== token) return
    runtimeMutableState.watchHandles = handles
    runtimeMutableState.controllerSnapshot = state
    runtimeMutableState.started = true
    startupCommitted = true
    markAgentsControllerStarted(runtimeMutableState.lifecycleActor)
    controllerState.started = true
    syncControllerAgentRunIngestionHealth()
    logAgentsControllerInfo('startup_complete', { namespaces })
  } catch (error) {
    logAgentsControllerError('startup_failed', toLogError(error))
    if (runtimeMutableState.lifecycleToken === token) {
      markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
    }
    if (error instanceof Error && error.name === 'NamespaceScopeConfigError') {
      process.exitCode = 1
      throw error
    }
  } finally {
    if (!startupCommitted) {
      stopWatchHandles(handles)
    }
    if (runtimeMutableState.lifecycleToken === token) {
      runtimeMutableState.starting = false
      if (!runtimeMutableState.started) {
        markAgentsControllerStartFailed(runtimeMutableState.lifecycleActor)
      }
    }
  }
}

const stopAgentsControllerInternal = () => {
  requestAgentsControllerStop(runtimeMutableState.lifecycleActor)
  runtimeMutableState.lifecycleToken += 1
  runtimeMutableState.starting = false
  stopWatchHandles(runtimeMutableState.watchHandles)
  runtimeMutableState.watchHandles = []
  runtimeMutableState.controllerSnapshot = null
  runtimeMutableState.namespaceQueues.clear()
  runtimeMutableState.agentRunIngestionState.clear()
  runtimeMutableState.started = false
  controllerState.started = false
  controllerState.namespaces = null
  controllerState.agentRunIngestion = []
}

export type AgentsControllerService = {
  start: Effect.Effect<void, Error>
  stop: Effect.Effect<void, never>
  getHealth: Effect.Effect<AgentsControllerHealth, never>
}

export class AgentsController extends Context.Tag('AgentsController')<AgentsController, AgentsControllerService>() {}

export const AgentsControllerLive = Layer.scoped(
  AgentsController,
  Effect.gen(function* () {
    initializeRuntimeMutableStateForLayer()
    yield* Effect.addFinalizer(() => Effect.sync(() => stopAgentsControllerInternal()))
    return {
      start: Effect.tryPromise({
        try: () => startAgentsControllerInternal(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
      stop: Effect.sync(() => {
        stopAgentsControllerInternal()
      }),
      getHealth: Effect.sync(() => getAgentsControllerHealth()),
    } satisfies AgentsControllerService
  }),
)

const agentsControllerRuntime = ManagedRuntime.make(AgentsControllerLive)

export const startAgentsControllerEffect = Effect.flatMap(AgentsController, (service) => service.start)
export const stopAgentsControllerEffect = Effect.flatMap(AgentsController, (service) => service.stop)
export const getAgentsControllerHealthEffect = Effect.flatMap(AgentsController, (service) => service.getHealth)

export const runAgentsControllerEffect = <A, E>(effect: Effect.Effect<A, E, AgentsController>): Promise<A> =>
  agentsControllerRuntime.runPromise(effect)

export const startAgentsController = async () => {
  await startAgentsControllerInternal()
}

export const stopAgentsController = () => {
  stopAgentsControllerInternal()
}

export const __test = {
  initializeRuntimeMutableStateForLayer,
  getRuntimeMutableState: () => runtimeMutableState,
  checkCrds,
  clearGithubAppTokenCache,
  resetControllerRateState,
  fetchGithubAppToken,
  setStatus,
  resolveAgentRunArtifactsLimitConfig,
  limitAgentRunStatusArtifacts,
  buildArtifactsLimitMessage,
  reconcileAgentRun: reconcileAgentRunWithMetrics,
  reconcileVersionControlProvider,
  reconcileMemory,
  resolveVcsPrRateLimits,
  resolveJobImage,
  resolveVcsContext,
  getAgentRunUntouchedReasons,
  resyncAgentRunsForNamespace,
  syncControllerAgentRunIngestionHealth,
  assessAgentRunIngestion,
  stopWatchHandles,
}
