import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import process from 'node:process'

import { Context, Effect, Layer } from 'effect'

import { OrchestratorError, toLogError } from './errors'
import type { HealthCheckConfig, TargetHealthCheckResult, TargetHealthSummary } from './types'
import { WorkflowService } from './workflow'
import type { Logger } from './logger'

const SERVICE_ACCOUNT_DIRECTORY = '/var/run/secrets/kubernetes.io/serviceaccount'
const TOKEN_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/token`
const CA_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/ca.crt`

type KubernetesResponse = {
  status: number
  body: string
}

const requestKubernetes = (
  method: 'GET',
  path: string,
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
            path,
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
    catch: (error) => new OrchestratorError('target_health_check_failed', 'kubernetes request failed', error),
  })

const readOptionalFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf8'),
    catch: (error) => new OrchestratorError('target_health_check_failed', `failed to read ${filePath}`, error),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.catchAll(() => Effect.succeed<string | null>(null)),
  )

const parseJson = <T>(body: string, message: string) =>
  Effect.try({
    try: () => JSON.parse(body) as T,
    catch: (error) => new OrchestratorError('target_health_check_failed', message, error),
  })

const evaluateArgoApplicationCheck = (
  check: HealthCheckConfig,
  token: string,
  ca: string,
): Effect.Effect<TargetHealthCheckResult, OrchestratorError, never> => {
  const namespace = check.namespace ?? 'argocd'
  const application = check.application ?? ''
  const expectedSync = check.expectedSync ?? 'Synced'
  const expectedHealth = check.expectedHealth ?? 'Healthy'

  if (!application) {
    return Effect.fail(new OrchestratorError('target_health_check_failed', `${check.name} is missing application`))
  }

  return requestKubernetes(
    'GET',
    `/apis/argoproj.io/v1alpha1/namespaces/${namespace}/applications/${application}`,
    token,
    ca,
  ).pipe(
    Effect.flatMap((response) => {
      if (response.status !== 200) {
        return Effect.fail(
          new OrchestratorError(
            'target_health_check_failed',
            `argo application read returned ${response.status}`,
            response.body,
          ),
        )
      }
      return parseJson<{
        status?: {
          sync?: { status?: string }
          health?: { status?: string }
        }
      }>(response.body, 'failed to parse argo application response')
    }),
    Effect.map((payload) => {
      const syncStatus = payload.status?.sync?.status ?? 'Unknown'
      const healthStatus = payload.status?.health?.status ?? 'Unknown'
      const ok = syncStatus === expectedSync && healthStatus === expectedHealth
      return {
        name: check.name,
        type: check.type,
        ok,
        observed: `${syncStatus}/${healthStatus}`,
        message: ok
          ? `${application} is ${syncStatus}/${healthStatus}`
          : `${application} expected ${expectedSync}/${expectedHealth} but was ${syncStatus}/${healthStatus}`,
      } satisfies TargetHealthCheckResult
    }),
  )
}

const evaluateKnativeServiceCheck = (
  check: HealthCheckConfig,
  token: string,
  ca: string,
): Effect.Effect<TargetHealthCheckResult, OrchestratorError, never> => {
  const namespace = check.namespace ?? ''
  const serviceName = check.resourceName ?? ''
  if (!namespace || !serviceName) {
    return Effect.fail(
      new OrchestratorError('target_health_check_failed', `${check.name} is missing knative service identity`),
    )
  }

  return requestKubernetes(
    'GET',
    `/apis/serving.knative.dev/v1/namespaces/${namespace}/services/${serviceName}`,
    token,
    ca,
  ).pipe(
    Effect.flatMap((response) => {
      if (response.status !== 200) {
        return Effect.fail(
          new OrchestratorError(
            'target_health_check_failed',
            `knative service read returned ${response.status}`,
            response.body,
          ),
        )
      }
      return parseJson<{
        status?: {
          conditions?: Array<{ type?: string; status?: string }>
        }
      }>(response.body, 'failed to parse knative service response')
    }),
    Effect.map((payload) => {
      const ready = payload.status?.conditions?.find((condition) => condition.type === 'Ready')?.status === 'True'
      return {
        name: check.name,
        type: check.type,
        ok: ready,
        observed: ready ? 'Ready=True' : 'Ready!=True',
        message: ready ? `${serviceName} is Ready` : `${serviceName} is not Ready`,
      } satisfies TargetHealthCheckResult
    }),
  )
}

const deriveResourcePath = (check: HealthCheckConfig): string => {
  if (check.path) return check.path

  const namespace = check.namespace ?? ''
  const resourceName = check.resourceName ?? ''
  const resourceKind = (check.resourceKind ?? '').trim().toLowerCase()

  if (!namespace || !resourceName || !resourceKind) {
    throw new OrchestratorError(
      'target_health_check_failed',
      `${check.name} is missing namespace/resource_kind/resource_name`,
    )
  }

  switch (resourceKind) {
    case 'deployment':
    case 'deployments':
      return `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName}`
    case 'statefulset':
    case 'statefulsets':
      return `/apis/apps/v1/namespaces/${namespace}/statefulsets/${resourceName}`
    case 'job':
    case 'jobs':
      return `/apis/batch/v1/namespaces/${namespace}/jobs/${resourceName}`
    case 'service':
    case 'services':
      return `/api/v1/namespaces/${namespace}/services/${resourceName}`
    case 'pod':
    case 'pods':
      return `/api/v1/namespaces/${namespace}/pods/${resourceName}`
    default:
      throw new OrchestratorError(
        'target_health_check_failed',
        `${check.name} uses unsupported kubernetes resource kind ${check.resourceKind ?? 'unknown'}`,
      )
  }
}

const evaluateKubernetesResourceCheck = (
  check: HealthCheckConfig,
  token: string,
  ca: string,
): Effect.Effect<TargetHealthCheckResult, OrchestratorError, never> =>
  Effect.try({
    try: () => deriveResourcePath(check),
    catch: (error) =>
      error instanceof OrchestratorError
        ? error
        : new OrchestratorError('target_health_check_failed', 'failed to resolve kubernetes resource path', error),
  }).pipe(
    Effect.flatMap((resourcePath) => requestKubernetes('GET', resourcePath, token, ca)),
    Effect.flatMap((response) => {
      if (response.status !== 200) {
        return Effect.fail(
          new OrchestratorError(
            'target_health_check_failed',
            `kubernetes resource read returned ${response.status}`,
            response.body,
          ),
        )
      }

      return parseJson<{
        spec?: { replicas?: number }
        status?: {
          readyReplicas?: number
          availableReplicas?: number
          phase?: string
          succeeded?: number
          conditions?: Array<{ type?: string; status?: string }>
        }
      }>(response.body, 'failed to parse kubernetes resource response')
    }),
    Effect.map((payload) => {
      const resourceKind = (check.resourceKind ?? '').trim().toLowerCase()

      if (resourceKind === 'deployment' || resourceKind === 'deployments') {
        const replicas = payload.spec?.replicas ?? 1
        const available = payload.status?.availableReplicas ?? payload.status?.readyReplicas ?? 0
        const ok = available >= replicas
        return {
          name: check.name,
          type: check.type,
          ok,
          observed: `${available}/${replicas}`,
          message: ok ? `${check.resourceName} is available` : `${check.resourceName} is not fully available`,
        } satisfies TargetHealthCheckResult
      }

      if (resourceKind === 'statefulset' || resourceKind === 'statefulsets') {
        const replicas = payload.spec?.replicas ?? 1
        const ready = payload.status?.readyReplicas ?? 0
        const ok = ready >= replicas
        return {
          name: check.name,
          type: check.type,
          ok,
          observed: `${ready}/${replicas}`,
          message: ok ? `${check.resourceName} is ready` : `${check.resourceName} is not fully ready`,
        } satisfies TargetHealthCheckResult
      }

      if (resourceKind === 'job' || resourceKind === 'jobs') {
        const completed = payload.status?.conditions?.some(
          (condition) => condition.type === 'Complete' && condition.status === 'True',
        )
        return {
          name: check.name,
          type: check.type,
          ok: Boolean(completed),
          observed: completed ? 'Complete=True' : 'Complete!=True',
          message: completed ? `${check.resourceName} completed` : `${check.resourceName} has not completed`,
        } satisfies TargetHealthCheckResult
      }

      if (resourceKind === 'pod' || resourceKind === 'pods') {
        const phase = payload.status?.phase ?? 'Unknown'
        return {
          name: check.name,
          type: check.type,
          ok: phase === 'Running',
          observed: phase,
          message: phase === 'Running' ? `${check.resourceName} is running` : `${check.resourceName} phase is ${phase}`,
        } satisfies TargetHealthCheckResult
      }

      return {
        name: check.name,
        type: check.type,
        ok: true,
        observed: 'Exists',
        message: `${check.resourceName ?? check.name} exists`,
      } satisfies TargetHealthCheckResult
    }),
  )

const evaluateHttpCheck = (
  check: HealthCheckConfig,
): Effect.Effect<TargetHealthCheckResult, OrchestratorError, never> => {
  const url = check.url ?? ''
  if (!url) {
    return Effect.fail(new OrchestratorError('target_health_check_failed', `${check.name} is missing url`))
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      return response.status
    },
    catch: (error) => new OrchestratorError('target_health_check_failed', `failed to fetch ${url}`, error),
  }).pipe(
    Effect.map((status) => {
      const expectedStatus = check.expectedStatus ?? 200
      return {
        name: check.name,
        type: check.type,
        ok: status === expectedStatus,
        observed: String(status),
        message:
          status === expectedStatus
            ? `${url} returned ${status}`
            : `${url} returned ${status}, expected ${expectedStatus}`,
      } satisfies TargetHealthCheckResult
    }),
  )
}

const evaluateCheck = (
  check: HealthCheckConfig,
  token: string,
  ca: string,
): Effect.Effect<TargetHealthCheckResult, OrchestratorError, never> => {
  switch (check.type) {
    case 'argocd_application':
      return evaluateArgoApplicationCheck(check, token, ca)
    case 'http':
      return evaluateHttpCheck(check)
    case 'knative_service':
      return evaluateKnativeServiceCheck(check, token, ca)
    case 'kubernetes_resource':
      return evaluateKubernetesResourceCheck(check, token, ca)
  }
}

const fetchOpenPromotionPrCount = (
  repo: string,
  defaultBranch: string,
  promotionBranchPrefix: string,
  token: string | null,
): Effect.Effect<number, OrchestratorError, never> => {
  if (!promotionBranchPrefix) return Effect.succeed(0)
  if (!token) {
    return Effect.fail(new OrchestratorError('target_health_check_failed', 'GH_TOKEN or GITHUB_TOKEN is required'))
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=open&base=${encodeURIComponent(defaultBranch)}&per_page=100`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'symphony',
          },
        },
      )
      if (!response.ok) {
        throw new OrchestratorError(
          'target_health_check_failed',
          `github pull request list returned ${response.status}`,
          await response.text(),
        )
      }
      const payload = (await response.json()) as Array<{ head?: { ref?: string } }>
      return payload.filter((pullRequest) => (pullRequest.head?.ref ?? '').startsWith(promotionBranchPrefix)).length
    },
    catch: (error) =>
      error instanceof OrchestratorError
        ? error
        : new OrchestratorError('target_health_check_failed', 'failed to query open promotion pull requests', error),
  })
}

export interface TargetHealthServiceDefinition {
  readonly evaluatePreDispatch: Effect.Effect<TargetHealthSummary, never>
}

export class TargetHealthService extends Context.Tag('symphony/TargetHealthService')<
  TargetHealthService,
  TargetHealthServiceDefinition
>() {}

export const makeTargetHealthLayer = (logger: Logger) =>
  Layer.effect(
    TargetHealthService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const targetLogger = logger.child({ component: 'target-health' })

      return {
        evaluatePreDispatch: workflow.current.pipe(
          Effect.flatMap(({ config }) =>
            Effect.gen(function* () {
              const checkedAt = new Date().toISOString()
              const token = (yield* readOptionalFile(TOKEN_PATH)) ?? ''
              const ca = (yield* readOptionalFile(CA_PATH)) ?? ''
              const githubToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || null

              const checks = yield* Effect.forEach(config.health.preDispatch, (check) =>
                evaluateCheck(check, token, ca).pipe(
                  Effect.catchAll((error) =>
                    Effect.succeed({
                      name: check.name,
                      type: check.type,
                      ok: false,
                      observed: null,
                      message: error.message,
                    } satisfies TargetHealthCheckResult),
                  ),
                ),
              )

              const promotionPrCount = yield* fetchOpenPromotionPrCount(
                config.target.repo,
                config.target.defaultBranch,
                config.release.promotionBranchPrefix,
                githubToken,
              ).pipe(
                Effect.catchAll((error) => {
                  targetLogger.log('warn', 'target_health_github_query_failed', toLogError(error))
                  return Effect.succeed(-1)
                }),
              )

              const openPromotionPr = promotionPrCount > 0
              const lastError = promotionPrCount < 0 ? 'failed to evaluate open promotion pull requests' : null

              return {
                checkedAt,
                readyForDispatch: checks.every((check) => check.ok) && !openPromotionPr && lastError === null,
                openPromotionPr,
                promotionPrCount: Math.max(0, promotionPrCount),
                checks,
                lastError,
              } satisfies TargetHealthSummary
            }),
          ),
          Effect.catchAll((error) => {
            targetLogger.log('warn', 'target_health_evaluation_failed', toLogError(error))
            return Effect.succeed({
              checkedAt: new Date().toISOString(),
              readyForDispatch: false,
              openPromotionPr: false,
              promotionPrCount: 0,
              checks: [],
              lastError: error.message,
            } satisfies TargetHealthSummary)
          }),
        ),
      } satisfies TargetHealthServiceDefinition
    }),
  )
