import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import process from 'node:process'

import { Context, Effect, Layer } from 'effect'
import * as Duration from 'effect/Duration'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as Stream from 'effect/Stream'

import { OrchestratorError } from './errors'
import type { LeaderSnapshot } from './types'
import type { Logger } from './logger'

type LeaderElectionConfig = {
  enabled: boolean
  required: boolean
  leaseName: string
  leaseNamespace: string | null
  leaseDurationSeconds: number
  renewDeadlineSeconds: number
  retryPeriodSeconds: number
}

type KubernetesLease = {
  apiVersion: 'coordination.k8s.io/v1'
  kind: 'Lease'
  metadata?: {
    name?: string
    namespace?: string
    resourceVersion?: string
  }
  spec?: {
    holderIdentity?: string
    leaseDurationSeconds?: number
    acquireTime?: string
    renewTime?: string
    leaseTransitions?: number
  }
}

type KubernetesResponse = {
  status: number
  body: string
}

const DEFAULT_LEASE_NAME = 'symphony-leader'
const DEFAULT_LEASE_DURATION_SECONDS = 30
const DEFAULT_RENEW_DEADLINE_SECONDS = 20
const DEFAULT_RETRY_PERIOD_SECONDS = 5
const SERVICE_ACCOUNT_DIRECTORY = '/var/run/secrets/kubernetes.io/serviceaccount'
const TOKEN_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/token`
const CA_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/ca.crt`
const NAMESPACE_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/namespace`
const EXPIRY_SAFETY_MARGIN_MS = 2_000

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

const parseIntegerEnv = (value: string | undefined, fallback: number, min: number): number => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

const nowIso = () => new Date().toISOString()

const safeString = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

const resolveIdentity = () => {
  const hostname = (process.env.HOSTNAME ?? '').trim()
  return hostname.length > 0 ? `${hostname}_${randomUUID()}` : `symphony_${randomUUID()}`
}

const parseLeaseTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const isLeaseExpired = (lease: KubernetesLease, nowMs: number, leaseDurationSeconds: number) => {
  const renewMs = parseLeaseTime(lease.spec?.renewTime)
  if (renewMs === null) return true
  return nowMs - renewMs > leaseDurationSeconds * 1_000 + EXPIRY_SAFETY_MARGIN_MS
}

const buildLease = (config: LeaderElectionConfig, identity: string): KubernetesLease => ({
  apiVersion: 'coordination.k8s.io/v1',
  kind: 'Lease',
  metadata: {
    name: config.leaseName,
    namespace: config.leaseNamespace ?? undefined,
  },
  spec: {
    holderIdentity: identity,
    leaseDurationSeconds: config.leaseDurationSeconds,
    acquireTime: nowIso(),
    renewTime: nowIso(),
    leaseTransitions: 0,
  },
})

const updateLease = (current: KubernetesLease, config: LeaderElectionConfig, identity: string): KubernetesLease => {
  const previousHolder = (current.spec?.holderIdentity ?? '').trim()
  const currentTransitions = Number.isFinite(current.spec?.leaseTransitions)
    ? Math.max(0, Math.floor(current.spec?.leaseTransitions ?? 0))
    : 0

  return {
    ...current,
    metadata: {
      ...current.metadata,
      name: config.leaseName,
      namespace: config.leaseNamespace ?? undefined,
    },
    spec: {
      ...current.spec,
      holderIdentity: identity,
      leaseDurationSeconds: config.leaseDurationSeconds,
      acquireTime: current.spec?.acquireTime ?? nowIso(),
      renewTime: nowIso(),
      leaseTransitions:
        previousHolder.length === 0 || previousHolder === identity ? currentTransitions : currentTransitions + 1,
    },
  }
}

const clearLeaseHolder = (current: KubernetesLease, config: LeaderElectionConfig): KubernetesLease => ({
  ...current,
  metadata: {
    ...current.metadata,
    name: config.leaseName,
    namespace: config.leaseNamespace ?? undefined,
  },
  spec: {
    ...current.spec,
    holderIdentity: '',
    leaseDurationSeconds: config.leaseDurationSeconds,
    renewTime: nowIso(),
  },
})

const requestKubernetes = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token: string,
  ca: string,
  body?: unknown,
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

        const rawBody = body === undefined ? null : JSON.stringify(body)
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
              ...(rawBody
                ? {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(rawBody).toString(),
                  }
                : {}),
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
        if (rawBody) {
          request.write(rawBody)
        }
        request.end()
      }),
    catch: (error) => new OrchestratorError('leader_election_error', 'kubernetes lease request failed', error),
  })

const readOptionalFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf8'),
    catch: (error) => new OrchestratorError('leader_election_error', `failed to read ${filePath}`, error),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.catchAll(() => Effect.succeed<string | null>(null)),
  )

const resolveLeaderElectionConfig = (): Effect.Effect<LeaderElectionConfig, never, never> =>
  Effect.gen(function* () {
    const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST)
    const defaultEnabled = inCluster
    const enabled = parseBooleanEnv(process.env.SYMPHONY_LEADER_ELECTION_ENABLED, defaultEnabled)
    const token = yield* readOptionalFile(TOKEN_PATH)
    const namespace =
      (process.env.SYMPHONY_LEADER_ELECTION_LEASE_NAMESPACE ?? '').trim() ||
      (yield* readOptionalFile(NAMESPACE_PATH)) ||
      null

    const required = enabled && inCluster && token !== null && namespace !== null

    const config = {
      enabled,
      required,
      leaseName: (process.env.SYMPHONY_LEADER_ELECTION_LEASE_NAME ?? DEFAULT_LEASE_NAME).trim() || DEFAULT_LEASE_NAME,
      leaseNamespace: namespace,
      leaseDurationSeconds: parseIntegerEnv(
        process.env.SYMPHONY_LEADER_ELECTION_LEASE_DURATION_SECONDS,
        DEFAULT_LEASE_DURATION_SECONDS,
        1,
      ),
      renewDeadlineSeconds: parseIntegerEnv(
        process.env.SYMPHONY_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
        DEFAULT_RENEW_DEADLINE_SECONDS,
        1,
      ),
      retryPeriodSeconds: parseIntegerEnv(
        process.env.SYMPHONY_LEADER_ELECTION_RETRY_PERIOD_SECONDS,
        DEFAULT_RETRY_PERIOD_SECONDS,
        1,
      ),
    } satisfies LeaderElectionConfig

    if (config.retryPeriodSeconds >= config.renewDeadlineSeconds) {
      config.renewDeadlineSeconds = DEFAULT_RENEW_DEADLINE_SECONDS
      config.retryPeriodSeconds = DEFAULT_RETRY_PERIOD_SECONDS
    }
    if (config.renewDeadlineSeconds >= config.leaseDurationSeconds) {
      config.leaseDurationSeconds = DEFAULT_LEASE_DURATION_SECONDS
      config.renewDeadlineSeconds = DEFAULT_RENEW_DEADLINE_SECONDS
      config.retryPeriodSeconds = DEFAULT_RETRY_PERIOD_SECONDS
    }

    return config
  })

export interface LeaderElectionServiceDefinition {
  readonly start: Effect.Effect<void, never>
  readonly stop: Effect.Effect<void, never>
  readonly status: Effect.Effect<LeaderSnapshot, never>
  readonly changes: Stream.Stream<LeaderSnapshot>
}

export class LeaderElectionService extends Context.Tag('symphony/LeaderElectionService')<
  LeaderElectionService,
  LeaderElectionServiceDefinition
>() {}

export const makeLeaderElectionLayer = (logger: Logger) =>
  Layer.effect(
    LeaderElectionService,
    Effect.gen(function* () {
      const leaderLogger = logger.child({ component: 'leader-election' })
      const config = yield* resolveLeaderElectionConfig()
      const token = (yield* readOptionalFile(TOKEN_PATH)) ?? ''
      const ca = (yield* readOptionalFile(CA_PATH)) ?? ''
      const identity = resolveIdentity()
      const initialStatus: LeaderSnapshot = {
        enabled: config.enabled,
        required: config.required,
        isLeader: !config.required,
        leaseName: config.leaseName,
        leaseNamespace: config.leaseNamespace,
        identity,
        lastTransitionAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
      }

      const statusRef = yield* SubscriptionRef.make(initialStatus)
      const startedRef = yield* Ref.make(false)
      const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const lastSuccessMsRef = yield* Ref.make<number>(0)

      const updateStatus = (patch: Partial<LeaderSnapshot>) =>
        SubscriptionRef.update(statusRef, (current) => {
          const next = { ...current, ...patch }
          const leaderChanged = next.isLeader !== current.isLeader
          return {
            ...next,
            lastTransitionAt: leaderChanged ? nowIso() : next.lastTransitionAt,
          }
        })

      const getLeasePath = () =>
        `/apis/coordination.k8s.io/v1/namespaces/${config.leaseNamespace}/leases/${config.leaseName}`

      const createLeasePath = () => `/apis/coordination.k8s.io/v1/namespaces/${config.leaseNamespace}/leases`

      const readLease = requestKubernetes('GET', getLeasePath(), token, ca).pipe(
        Effect.flatMap((response) => {
          if (response.status === 200) {
            return Effect.try({
              try: () => JSON.parse(response.body) as KubernetesLease,
              catch: (error) =>
                new OrchestratorError('leader_election_error', 'lease read returned invalid JSON', error),
            })
          }
          if (response.status === 404) {
            return Effect.fail(new OrchestratorError('leader_election_error', 'lease not found', response.body))
          }
          return Effect.fail(
            new OrchestratorError(
              'leader_election_error',
              `lease read returned status ${response.status}`,
              response.body,
            ),
          )
        }),
      )

      const createLeaseIfMissing = requestKubernetes(
        'POST',
        createLeasePath(),
        token,
        ca,
        buildLease(config, identity),
      ).pipe(
        Effect.flatMap((response) => {
          if (response.status === 201 || response.status === 200) {
            return Effect.try({
              try: () => JSON.parse(response.body) as KubernetesLease,
              catch: (error) =>
                new OrchestratorError('leader_election_error', 'lease create returned invalid JSON', error),
            })
          }
          return Effect.fail(
            new OrchestratorError(
              'leader_election_error',
              `lease create returned status ${response.status}`,
              response.body,
            ),
          )
        }),
      )

      const replaceLease = (lease: KubernetesLease) =>
        requestKubernetes('PUT', getLeasePath(), token, ca, lease).pipe(
          Effect.flatMap((response) => {
            if (response.status === 200) {
              return Effect.try({
                try: () => JSON.parse(response.body) as KubernetesLease,
                catch: (error) =>
                  new OrchestratorError('leader_election_error', 'lease replace returned invalid JSON', error),
              })
            }
            return Effect.fail(
              new OrchestratorError(
                'leader_election_error',
                `lease replace returned status ${response.status}`,
                response.body,
              ),
            )
          }),
        )

      const tick = Effect.gen(function* () {
        if (!config.required) {
          yield* updateStatus({ isLeader: true, lastError: null })
          return
        }

        yield* updateStatus({ lastAttemptAt: nowIso() })

        const leaseEither = yield* Effect.either(readLease)
        let lease: KubernetesLease | null = null
        if (leaseEither._tag === 'Right') {
          lease = leaseEither.right
        } else if (leaseEither.left.message === 'lease not found') {
          const createdEither = yield* Effect.either(createLeaseIfMissing)
          if (createdEither._tag === 'Right') {
            lease = createdEither.right
          } else {
            const responseText = safeString(createdEither.left.causeValue)
            if (responseText.includes('already exists')) {
              const fallback = yield* Effect.either(readLease)
              if (fallback._tag === 'Right') {
                lease = fallback.right
              } else {
                yield* updateStatus({
                  isLeader: false,
                  lastError: fallback.left.message,
                })
                return
              }
            } else {
              yield* updateStatus({
                isLeader: false,
                lastError: createdEither.left.message,
              })
              return
            }
          }
        } else {
          const error = leaseEither.left
          const conflict = typeof error.causeValue === 'string' && error.causeValue.includes('409')
          yield* updateStatus({
            isLeader: false,
            lastError: conflict ? null : error.message,
          })
          return
        }

        if (!lease) {
          yield* updateStatus({ isLeader: false, lastError: 'lease missing after acquisition attempt' })
          return
        }

        const holderIdentity = (lease.spec?.holderIdentity ?? '').trim()
        const nowMs = Date.now()
        const canAcquire =
          holderIdentity.length === 0 ||
          holderIdentity === identity ||
          isLeaseExpired(lease, nowMs, config.leaseDurationSeconds)

        if (!canAcquire) {
          yield* updateStatus({ isLeader: false, lastError: null })
          return
        }

        const replaceEither = yield* Effect.either(replaceLease(updateLease(lease, config, identity)))
        if (replaceEither._tag === 'Left') {
          const error = replaceEither.left
          const causeText = safeString(error.causeValue)
          yield* updateStatus({
            isLeader: false,
            lastError: causeText.includes('409') ? null : error.message,
          })
          return
        }

        yield* Ref.set(lastSuccessMsRef, nowMs)
        yield* updateStatus({
          isLeader: true,
          lastError: null,
          lastSuccessAt: nowIso(),
        })
      })

      const loop = Effect.forever(
        tick.pipe(
          Effect.zipRight(
            Ref.get(lastSuccessMsRef).pipe(
              Effect.flatMap((lastSuccessMs) =>
                lastSuccessMs > 0 && Date.now() - lastSuccessMs > config.renewDeadlineSeconds * 1_000
                  ? updateStatus({
                      isLeader: false,
                      lastError: `renew deadline exceeded (${config.renewDeadlineSeconds}s)`,
                    })
                  : Effect.void,
              ),
            ),
          ),
          Effect.zipRight(Effect.sleep(Duration.seconds(config.retryPeriodSeconds))),
        ),
      )

      const releaseLease = Effect.gen(function* () {
        if (!config.required) return
        const current = yield* SubscriptionRef.get(statusRef)
        if (!current.isLeader) return

        const lease = yield* Effect.either(readLease)
        if (lease._tag === 'Left') return
        const holderIdentity = (lease.right.spec?.holderIdentity ?? '').trim()
        if (holderIdentity !== identity) return

        yield* replaceLease(clearLeaseHolder(lease.right, config)).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.asVoid,
        )
      })

      return {
        start: Ref.get(startedRef).pipe(
          Effect.flatMap((started) =>
            started
              ? Effect.void
              : config.required
                ? loop.pipe(
                    Effect.forkDaemon,
                    Effect.flatMap((fiber) => Ref.set(fiberRef, fiber)),
                    Effect.zipRight(Ref.set(startedRef, true)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        leaderLogger.log('info', 'leader_election_started', {
                          identity,
                          lease_name: config.leaseName,
                          lease_namespace: config.leaseNamespace,
                        })
                      }),
                    ),
                  )
                : updateStatus({ isLeader: true, lastError: null }).pipe(Effect.zipRight(Ref.set(startedRef, true))),
          ),
        ),
        stop: Ref.get(fiberRef).pipe(
          Effect.flatMap((fiber) => (fiber ? Fiber.interruptFork(fiber) : Effect.void)),
          Effect.zipRight(releaseLease),
          Effect.zipRight(Ref.set(startedRef, false)),
          Effect.zipRight(updateStatus({ isLeader: !config.required, lastError: null })),
        ),
        status: SubscriptionRef.get(statusRef),
        changes: statusRef.changes,
      } satisfies LeaderElectionServiceDefinition
    }),
  )
