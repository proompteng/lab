import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import process from 'node:process'

import { Context, Effect, Layer } from 'effect'

import { OrchestratorError, toLogError } from './errors'
import type {
  DeliveryArgoObservation,
  DeliveryChecksSummary,
  DeliveryPullRequestRef,
  DeliveryStage,
  DeliveryTransaction,
  DeliveryWorkflowRunRef,
  DeliveryWorkflowState,
  IssueRecord,
  SymphonyConfig,
} from './types'
import type { Logger } from './logger'

const SERVICE_ACCOUNT_DIRECTORY = '/var/run/secrets/kubernetes.io/serviceaccount'
const TOKEN_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/token`
const CA_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/ca.crt`
const ROLLBACK_BRANCH_PREFIX = 'codex/symphony-rollback-'

type GitHubRepository = {
  owner: string
  name: string
}

type GitHubPullRequest = {
  number: number
  html_url: string
  state: 'open' | 'closed'
  title: string
  body: string | null
  draft: boolean
  created_at: string | null
  updated_at: string | null
  merged_at: string | null
  merge_commit_sha: string | null
  head: {
    ref: string
    sha: string
  }
  base: {
    ref: string
  }
}

type GitHubCheckRun = {
  name: string
  html_url: string | null
  status: string
  conclusion: string | null
}

type GitHubCombinedStatus = {
  state: string
  statuses: Array<{
    context: string
    state: string
    target_url: string | null
  }>
}

type GitHubWorkflowRun = {
  id: number
  html_url: string
  name: string | null
  status: string | null
  conclusion: string | null
  event: string | null
  head_sha: string
  head_branch: string | null
  created_at: string | null
  updated_at: string | null
}

type GitHubWorkflowRunsResponse = {
  workflow_runs: GitHubWorkflowRun[]
}

type GitHubPullsResponse = GitHubPullRequest[]

type KubernetesResponse = {
  status: number
  body: string
}

type DeliveryObservation = {
  handoffRequired: boolean
  codePr: DeliveryPullRequestRef | null
  requiredChecks: DeliveryChecksSummary | null
  mergedCommitSha: string | null
  build: DeliveryWorkflowRunRef | null
  releaseContract: DeliveryTransaction['releaseContract']
  promotionPr: DeliveryPullRequestRef | null
  argo: DeliveryArgoObservation | null
  postDeploy: DeliveryWorkflowRunRef | null
  rollbackPr: DeliveryPullRequestRef | null
  lastError: string | null
}

const parseRepo = (repo: string): GitHubRepository => {
  const [owner, name] = repo.split('/', 2)
  if (!owner || !name) {
    throw new OrchestratorError('runtime_unavailable', `invalid target repo '${repo}'`)
  }
  return { owner, name }
}

const readOptionalFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf8'),
    catch: (error) => new OrchestratorError('runtime_unavailable', `failed to read ${filePath}`, error),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.catchAll(() => Effect.succeed<string | null>(null)),
  )

const requestKubernetes = (
  method: 'GET',
  requestPath: string,
  token: string,
  ca: string,
): Effect.Effect<KubernetesResponse, OrchestratorError, never> =>
  Effect.tryPromise({
    try: () =>
      new Promise<KubernetesResponse>((resolve, reject) => {
        const host = process.env.KUBERNETES_SERVICE_HOST
        const port = process.env.KUBERNETES_SERVICE_PORT ?? '443'
        if (!host) {
          reject(new Error('KUBERNETES_SERVICE_HOST is not set'))
          return
        }

        const request = httpsRequest(
          {
            method,
            host,
            port,
            path: requestPath,
            ca,
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
            },
          },
          (response) => {
            let responseBody = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              responseBody += chunk
            })
            response.on('end', () => {
              resolve({ status: response.statusCode ?? 500, body: responseBody })
            })
          },
        )

        request.on('error', reject)
        request.end()
      }),
    catch: (error) => new OrchestratorError('runtime_unavailable', 'kubernetes request failed', error),
  })

const parseJson = <T>(body: string, message: string) =>
  Effect.try({
    try: () => JSON.parse(body) as T,
    catch: (error) => new OrchestratorError('runtime_unavailable', message, error),
  })

const normalizeWorkflowState = (status: string | null, conclusion: string | null): DeliveryWorkflowState => {
  if (status === 'queued' || status === 'requested' || status === 'waiting' || status === 'pending') return 'queued'
  if (status === 'in_progress') return 'in_progress'
  if (conclusion === 'success') return 'success'
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'failure'
  if (conclusion === 'cancelled') return 'cancelled'
  if (conclusion === 'skipped') return 'skipped'
  if (conclusion === 'neutral' || conclusion === 'stale') return 'neutral'
  return 'not_found'
}

const toPullRequestRef = (pullRequest: GitHubPullRequest): DeliveryPullRequestRef => ({
  number: pullRequest.number,
  url: pullRequest.html_url,
  branch: pullRequest.head.ref,
  state: pullRequest.merged_at ? 'merged' : pullRequest.state === 'open' ? 'open' : 'closed',
  title: pullRequest.title,
  createdAt: pullRequest.created_at,
  updatedAt: pullRequest.updated_at,
  mergedAt: pullRequest.merged_at,
  mergedCommitSha: pullRequest.merge_commit_sha,
})

const toWorkflowRunRef = (run: GitHubWorkflowRun): DeliveryWorkflowRunRef => ({
  id: run.id,
  url: run.html_url,
  name: run.name ?? 'unknown',
  state: normalizeWorkflowState(run.status, run.conclusion),
  status: run.status,
  conclusion: run.conclusion,
  event: run.event,
  headSha: run.head_sha,
  headBranch: run.head_branch,
  createdAt: run.created_at,
  updatedAt: run.updated_at,
})

const issueMatchesPullRequest = (issueIdentifier: string, pullRequest: GitHubPullRequest): boolean => {
  const normalizedIdentifier = issueIdentifier.trim().toLowerCase()
  const normalizedToken = issueIdentifier.replaceAll('-', '_').trim().toLowerCase()
  const title = pullRequest.title.toLowerCase()
  const body = (pullRequest.body ?? '').toLowerCase()
  const branch = pullRequest.head.ref.toLowerCase()

  return (
    title.includes(normalizedIdentifier) ||
    body.includes(normalizedIdentifier) ||
    branch.includes(normalizedIdentifier) ||
    branch.includes(normalizedToken)
  )
}

const parseReleaseContractFromPullRequest = (
  pullRequest: GitHubPullRequest | null,
): DeliveryTransaction['releaseContract'] | null => {
  if (!pullRequest?.body) return null

  const sourceSha = /Source commit:\s*`([0-9a-f]{40})`/i.exec(pullRequest.body)?.[1] ?? null
  const tag = /Image tag:\s*`([^`]+)`/i.exec(pullRequest.body)?.[1] ?? null
  const digest = /(Image digest|Failed commit):\s*`(sha256:[0-9a-f]{64})`/i.exec(pullRequest.body)?.[2] ?? null

  return {
    sourceSha,
    tag,
    digest,
    image: null,
    reason: pullRequest.head.ref.startsWith(ROLLBACK_BRANCH_PREFIX) ? 'rollback' : 'promotion_pr',
    resolvedAt: pullRequest.updated_at,
  }
}

const deriveLastError = (observation: DeliveryObservation): string | null => {
  if (observation.rollbackPr?.state === 'open') return observation.lastError ?? 'rollback pull request is open'
  if (observation.rollbackPr?.state === 'merged') return null
  if (observation.postDeploy?.state === 'failure') return 'post-deploy verification failed'
  if (observation.build?.state === 'failure') return 'build workflow failed'
  if (observation.requiredChecks?.state === 'failure') return 'required checks failed'
  return observation.lastError
}

export const deriveDeliveryStage = (observation: DeliveryObservation): DeliveryStage => {
  if (observation.rollbackPr?.state === 'merged') return 'rolled_back'
  if (observation.rollbackPr?.state === 'open') return 'rollback_open'
  if (observation.handoffRequired) return 'handoff_required'
  if (observation.postDeploy?.state === 'failure') return 'failed'
  if (observation.postDeploy && ['queued', 'in_progress'].includes(observation.postDeploy.state)) {
    return 'post_deploy_verify_running'
  }
  if (observation.postDeploy?.state === 'success') return 'completed'
  if (observation.promotionPr?.state === 'merged') {
    const revision = observation.argo?.revision ?? ''
    if (revision && revision !== observation.promotionPr.mergedCommitSha) {
      return 'argo_rollout_pending'
    }
    if (observation.argo && (observation.argo.health !== 'Healthy' || observation.argo.sync !== 'Synced')) {
      return 'argo_rollout_pending'
    }
    return 'promotion_merged'
  }
  if (observation.promotionPr?.state === 'open') return 'promotion_pr_open'
  if (observation.releaseContract?.digest || observation.releaseContract?.tag) return 'release_contract_resolved'
  if (observation.build && ['queued', 'in_progress'].includes(observation.build.state)) return 'build_running'
  if (observation.build?.state === 'failure') return 'failed'
  if (observation.mergedCommitSha) return 'merged_to_main'
  if (observation.requiredChecks?.state === 'success') return 'checks_green'
  if (observation.requiredChecks?.state === 'failure') return 'failed'
  if (observation.codePr && observation.requiredChecks !== null) return 'checks_pending'
  if (observation.codePr) return 'code_pr_open'
  return 'coding'
}

export const createEmptyDeliveryTransaction = (stage: DeliveryStage = 'coding'): DeliveryTransaction => ({
  stage,
  updatedAt: new Date().toISOString(),
  codePr: null,
  requiredChecks: null,
  mergedCommitSha: null,
  build: null,
  releaseContract: null,
  promotionPr: null,
  argo: null,
  postDeploy: null,
  rollbackPr: null,
  lastError: null,
})

export interface DeliveryServiceDefinition {
  readonly createPullRequest: (input: {
    repo: string
    title: string
    head: string
    base: string
    body: string
    draft?: boolean
  }) => Effect.Effect<DeliveryPullRequestRef, OrchestratorError>
  readonly getPullRequest: (repo: string, number: number) => Effect.Effect<DeliveryPullRequestRef, OrchestratorError>
  readonly mergePullRequest: (input: {
    repo: string
    number: number
    method?: 'merge' | 'squash' | 'rebase'
  }) => Effect.Effect<DeliveryPullRequestRef, OrchestratorError>
  readonly inspectRequiredChecks: (
    repo: string,
    headSha: string,
  ) => Effect.Effect<DeliveryChecksSummary, OrchestratorError>
  readonly getWorkflowRun: (repo: string, runId: number) => Effect.Effect<DeliveryWorkflowRunRef, OrchestratorError>
  readonly refreshIssueDelivery: (
    issue: IssueRecord,
    config: SymphonyConfig,
  ) => Effect.Effect<DeliveryTransaction, OrchestratorError>
}

export class DeliveryService extends Context.Tag('symphony/DeliveryService')<
  DeliveryService,
  DeliveryServiceDefinition
>() {}

export const makeDeliveryServiceLayer = (logger: Logger) =>
  Layer.effect(
    DeliveryService,
    Effect.sync(() => {
      const deliveryLogger = logger.child({ component: 'delivery-service' })
      const githubToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || null

      const githubRequest = <T>(
        repo: string,
        path: string,
        init: RequestInit = {},
      ): Effect.Effect<T, OrchestratorError, never> => {
        if (!githubToken) {
          return Effect.fail(
            new OrchestratorError('runtime_unavailable', 'GH_TOKEN or GITHUB_TOKEN is required for delivery tracking'),
          )
        }

        const requestUrl = new URL(`https://api.github.com${path}`)
        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(requestUrl, {
              ...init,
              headers: {
                authorization: `Bearer ${githubToken}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'symphony',
                ...init.headers,
              },
            })
            if (!response.ok) {
              throw new OrchestratorError(
                'runtime_unavailable',
                `github request failed for ${repo}${path}: ${response.status}`,
                await response.text(),
              )
            }
            return (await response.json()) as T
          },
          catch: (error) =>
            error instanceof OrchestratorError
              ? error
              : new OrchestratorError('runtime_unavailable', `github request failed for ${repo}${path}`, error),
        })
      }

      const listPullRequests = (repo: string) => {
        const parsedRepo = parseRepo(repo)
        return githubRequest<GitHubPullsResponse>(
          repo,
          `/repos/${parsedRepo.owner}/${parsedRepo.name}/pulls?state=all&base=main&sort=updated&direction=desc&per_page=100`,
        )
      }

      const getPullRequestPayload = (repo: string, number: number) => {
        const parsedRepo = parseRepo(repo)
        return githubRequest<GitHubPullRequest>(repo, `/repos/${parsedRepo.owner}/${parsedRepo.name}/pulls/${number}`)
      }

      const listWorkflowRuns = (repo: string, headSha: string) => {
        const parsedRepo = parseRepo(repo)
        return githubRequest<GitHubWorkflowRunsResponse>(
          repo,
          `/repos/${parsedRepo.owner}/${parsedRepo.name}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
        ).pipe(Effect.map((response) => response.workflow_runs))
      }

      const getWorkflowRunPayload = (repo: string, runId: number) => {
        const parsedRepo = parseRepo(repo)
        return githubRequest<GitHubWorkflowRun>(
          repo,
          `/repos/${parsedRepo.owner}/${parsedRepo.name}/actions/runs/${runId}`,
        )
      }

      const inspectRequiredChecksPayload = (repo: string, headSha: string) => {
        const parsedRepo = parseRepo(repo)
        return Effect.all({
          checks: githubRequest<{ check_runs: GitHubCheckRun[] }>(
            repo,
            `/repos/${parsedRepo.owner}/${parsedRepo.name}/commits/${headSha}/check-runs?per_page=100`,
          ),
          status: githubRequest<GitHubCombinedStatus>(
            repo,
            `/repos/${parsedRepo.owner}/${parsedRepo.name}/commits/${headSha}/status`,
          ),
        })
      }

      const createPullRequest = (input: {
        repo: string
        title: string
        head: string
        base: string
        body: string
        draft?: boolean
      }) => {
        const parsedRepo = parseRepo(input.repo)
        return githubRequest<GitHubPullRequest>(input.repo, `/repos/${parsedRepo.owner}/${parsedRepo.name}/pulls`, {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body,
            draft: input.draft ?? false,
          }),
        }).pipe(Effect.map(toPullRequestRef))
      }

      const inspectRequiredChecks = (repo: string, headSha: string) =>
        inspectRequiredChecksPayload(repo, headSha).pipe(
          Effect.map(({ checks, status }) => {
            const requiredCount = checks.check_runs.length + status.statuses.length
            const failingChecks = checks.check_runs.filter(
              (check) => check.conclusion !== null && !['success', 'neutral', 'skipped'].includes(check.conclusion),
            ).length
            const pendingChecks = checks.check_runs.filter(
              (check) => check.status !== 'completed' || check.conclusion === null,
            ).length
            const passingChecks = checks.check_runs.filter((check) =>
              ['success', 'neutral', 'skipped'].includes(check.conclusion ?? ''),
            ).length

            const failingStatuses = status.statuses.filter(
              (entry) => entry.state === 'failure' || entry.state === 'error',
            )
            const pendingStatuses = status.statuses.filter((entry) => entry.state === 'pending')
            const passingStatuses = status.statuses.filter((entry) => entry.state === 'success')

            const failingCount = failingChecks + failingStatuses.length
            const pendingCount = pendingChecks + pendingStatuses.length
            const passingCount = passingChecks + passingStatuses.length

            return {
              state:
                requiredCount === 0
                  ? 'not_found'
                  : failingCount > 0
                    ? 'failure'
                    : pendingCount > 0
                      ? 'pending'
                      : 'success',
              headSha,
              requiredCount,
              passingCount,
              failingCount,
              pendingCount,
              url:
                checks.check_runs.find((check) => check.html_url)?.html_url ??
                status.statuses.find((entry) => entry.target_url)?.target_url ??
                null,
            } satisfies DeliveryChecksSummary
          }),
        )

      const getPullRequest = (repo: string, number: number) =>
        getPullRequestPayload(repo, number).pipe(Effect.map(toPullRequestRef))

      const mergePullRequest = (input: { repo: string; number: number; method?: 'merge' | 'squash' | 'rebase' }) => {
        const parsedRepo = parseRepo(input.repo)
        return githubRequest<GitHubPullRequest>(
          input.repo,
          `/repos/${parsedRepo.owner}/${parsedRepo.name}/pulls/${input.number}/merge`,
          {
            method: 'PUT',
            body: JSON.stringify({
              merge_method: input.method ?? 'squash',
            }),
          },
        ).pipe(Effect.zipRight(getPullRequestPayload(input.repo, input.number)), Effect.map(toPullRequestRef))
      }

      const getWorkflowRun = (repo: string, runId: number) =>
        getWorkflowRunPayload(repo, runId).pipe(Effect.map(toWorkflowRunRef))

      const observeArgo = (
        config: SymphonyConfig,
      ): Effect.Effect<DeliveryArgoObservation | null, OrchestratorError, never> =>
        Effect.all({
          token: readOptionalFile(TOKEN_PATH),
          ca: readOptionalFile(CA_PATH),
        }).pipe(
          Effect.flatMap(({ token, ca }) => {
            if (!token || !ca) return Effect.succeed<DeliveryArgoObservation | null>(null)
            const argoNamespace =
              config.health.preDispatch.find(
                (check) => check.type === 'argocd_application' && check.application === config.target.argocdApplication,
              )?.namespace ?? 'argocd'

            return requestKubernetes(
              'GET',
              `/apis/argoproj.io/v1alpha1/namespaces/${argoNamespace}/applications/${config.target.argocdApplication}`,
              token,
              ca,
            ).pipe(
              Effect.flatMap((response) => {
                if (response.status !== 200) {
                  return Effect.fail(
                    new OrchestratorError(
                      'runtime_unavailable',
                      `argo application read returned ${response.status}`,
                      response.body,
                    ),
                  )
                }
                return parseJson<{
                  status?: {
                    sync?: { status?: string; revision?: string }
                    health?: { status?: string }
                  }
                }>(response.body, 'failed to parse argo application response')
              }),
              Effect.map((payload) => ({
                application: config.target.argocdApplication,
                namespace: argoNamespace,
                revision: payload.status?.sync?.revision ?? null,
                health: payload.status?.health?.status ?? null,
                sync: payload.status?.sync?.status ?? null,
                checkedAt: new Date().toISOString(),
              })),
            )
          }),
        )

      const findWorkflowRunByName = (runs: GitHubWorkflowRun[], workflowName: string | null) => {
        if (!workflowName) return null
        const matched = runs.find((run) => run.name === workflowName)
        return matched ? toWorkflowRunRef(matched) : null
      }

      const findCodePr = (issue: IssueRecord, config: SymphonyConfig) =>
        (issue.delivery?.codePr?.number
          ? getPullRequestPayload(config.target.repo, issue.delivery.codePr.number).pipe(
              Effect.map((pullRequest) => [pullRequest] as GitHubPullRequest[]),
              Effect.catchAll(() => listPullRequests(config.target.repo)),
            )
          : listPullRequests(config.target.repo)
        ).pipe(
          Effect.map((pullRequests) => {
            const matched = pullRequests.find(
              (pullRequest) =>
                pullRequest.base.ref === config.target.defaultBranch &&
                !pullRequest.head.ref.startsWith(config.release.promotionBranchPrefix) &&
                !pullRequest.head.ref.startsWith(ROLLBACK_BRANCH_PREFIX) &&
                issueMatchesPullRequest(issue.issueIdentifier, pullRequest),
            )
            return matched ?? null
          }),
        )

      const findPromotionPr = (
        repo: string,
        sourceSha: string | null,
        config: SymphonyConfig,
        previousNumber: number | null,
      ) =>
        (previousNumber
          ? getPullRequestPayload(repo, previousNumber).pipe(
              Effect.map((pullRequest) => [pullRequest] as GitHubPullRequest[]),
              Effect.catchAll(() => listPullRequests(repo)),
            )
          : listPullRequests(repo)
        ).pipe(
          Effect.map((pullRequests) => {
            const matched = pullRequests.find(
              (pullRequest) =>
                pullRequest.base.ref === config.target.defaultBranch &&
                pullRequest.head.ref.startsWith(config.release.promotionBranchPrefix) &&
                (sourceSha === null || (pullRequest.body ?? '').includes(sourceSha)),
            )
            return matched ?? null
          }),
        )

      const findRollbackPr = (repo: string, failedCommitSha: string | null, previousNumber: number | null) =>
        (previousNumber
          ? getPullRequestPayload(repo, previousNumber).pipe(
              Effect.map((pullRequest) => [pullRequest] as GitHubPullRequest[]),
              Effect.catchAll(() => listPullRequests(repo)),
            )
          : listPullRequests(repo)
        ).pipe(
          Effect.map((pullRequests) => {
            const matched = pullRequests.find(
              (pullRequest) =>
                pullRequest.head.ref.startsWith(ROLLBACK_BRANCH_PREFIX) &&
                (failedCommitSha === null || (pullRequest.body ?? '').includes(failedCommitSha)),
            )
            return matched ?? null
          }),
        )

      const refreshIssueDelivery = (issue: IssueRecord, config: SymphonyConfig) =>
        Effect.gen(function* () {
          const baseDelivery = issue.delivery ?? createEmptyDeliveryTransaction()
          const codePrPayload = yield* findCodePr(issue, config)
          const codePr = codePrPayload ? toPullRequestRef(codePrPayload) : null
          const requiredChecks =
            codePrPayload && codePrPayload.head.sha
              ? yield* inspectRequiredChecks(config.target.repo, codePrPayload.head.sha).pipe(
                  Effect.catchAll(() =>
                    Effect.succeed<DeliveryChecksSummary | null>({
                      state: 'not_found',
                      headSha: codePrPayload.head.sha,
                      requiredCount: 0,
                      passingCount: 0,
                      failingCount: 0,
                      pendingCount: 0,
                      url: null,
                    }),
                  ),
                )
              : null

          const mergedCommitSha = codePrPayload?.merge_commit_sha ?? baseDelivery.mergedCommitSha ?? null
          const workflowRuns = mergedCommitSha ? yield* listWorkflowRuns(config.target.repo, mergedCommitSha) : []
          const build = findWorkflowRunByName(workflowRuns, config.release.deployables[0]?.buildWorkflow ?? null)

          const promotionPrPayload = yield* findPromotionPr(
            config.target.repo,
            mergedCommitSha,
            config,
            baseDelivery.promotionPr?.number ?? null,
          )
          const promotionPr = promotionPrPayload ? toPullRequestRef(promotionPrPayload) : null
          const releaseContract =
            parseReleaseContractFromPullRequest(promotionPrPayload) ?? baseDelivery.releaseContract

          const argo =
            promotionPr?.state === 'merged'
              ? yield* observeArgo(config).pipe(
                  Effect.catchAll((error) => {
                    deliveryLogger.log('warn', 'delivery_argo_observation_failed', toLogError(error))
                    return Effect.succeed<DeliveryArgoObservation | null>(null)
                  }),
                )
              : null

          const promotionMergeCommitSha = promotionPr?.mergedCommitSha ?? null
          const postDeployRuns = promotionMergeCommitSha
            ? yield* listWorkflowRuns(config.target.repo, promotionMergeCommitSha)
            : []
          const postDeploy = findWorkflowRunByName(
            postDeployRuns,
            config.release.deployables[0]?.postDeployWorkflow ?? null,
          )

          const rollbackPrPayload = yield* findRollbackPr(
            config.target.repo,
            promotionMergeCommitSha,
            baseDelivery.rollbackPr?.number ?? null,
          )
          const rollbackPr = rollbackPrPayload ? toPullRequestRef(rollbackPrPayload) : null

          const observation: DeliveryObservation = {
            handoffRequired: issue.tracked.lastKnownState === config.tracker.handoffState,
            codePr,
            requiredChecks,
            mergedCommitSha,
            build,
            releaseContract,
            promotionPr,
            argo,
            postDeploy,
            rollbackPr,
            lastError: baseDelivery.lastError,
          }

          return {
            stage: deriveDeliveryStage(observation),
            updatedAt: new Date().toISOString(),
            codePr,
            requiredChecks,
            mergedCommitSha,
            build,
            releaseContract,
            promotionPr,
            argo,
            postDeploy,
            rollbackPr,
            lastError: deriveLastError(observation),
          } satisfies DeliveryTransaction
        }).pipe(
          Effect.catchAll((error) => {
            deliveryLogger.log('warn', 'delivery_refresh_failed', {
              issue_identifier: issue.issueIdentifier,
              ...toLogError(error),
            })
            return Effect.succeed({
              ...(issue.delivery ?? createEmptyDeliveryTransaction()),
              updatedAt: new Date().toISOString(),
              lastError: error.message,
            } satisfies DeliveryTransaction)
          }),
        )

      return {
        createPullRequest,
        getPullRequest,
        mergePullRequest,
        inspectRequiredChecks,
        getWorkflowRun,
        refreshIssueDelivery,
      } satisfies DeliveryServiceDefinition
    }),
  )
