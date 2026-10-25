import { randomUUID } from 'node:crypto'

import { type V1Lease, V1MicroTime } from '@kubernetes/client-node'
import { metrics as otelMetrics, type Counter } from '@proompteng/otel/api'
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'

import { createKubeGateway } from './kube-gateway'
import { isRuntimeTestEnv, resolveLeaderElectionSettings } from './leader-election-config'
import { resolveRuntimeServiceName } from './runtime-identity'

export type LeaderElectionConfig = {
  enabled: boolean
  leaseName: string
  leaseNamespace: string
  leaseDurationSeconds: number
  renewDeadlineSeconds: number
  retryPeriodSeconds: number
}

export type LeaderElectionStatus = {
  enabled: boolean
  required: boolean
  isLeader: boolean
  leaseName: string
  leaseNamespace: string
  identity: string
  lastTransitionAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export type LeaderElectionCallbacks = {
  onLeader: () => void
  onFollower: () => void
}

export class LeaderElectionRuntimeError extends Data.TaggedError('LeaderElectionRuntimeError')<{
  readonly operation: 'ensure' | 'release'
  readonly cause: unknown
}> {}

export type LeaderElectionService = {
  ensureRuntime: (callbacks: LeaderElectionCallbacks) => Effect.Effect<void, LeaderElectionRuntimeError>
  getStatus: Effect.Effect<LeaderElectionStatus, never>
  isLeaderForControllers: Effect.Effect<boolean, never>
  stop: Effect.Effect<void, never>
}

export class LeaderElection extends Context.Tag('LeaderElection')<LeaderElection, LeaderElectionService>() {}

const DEFAULT_CONFIG: Omit<LeaderElectionConfig, 'leaseNamespace'> & { leaseNamespace: '' } = {
  enabled: true,
  leaseName: 'agents-controller-leader',
  leaseNamespace: '',
  leaseDurationSeconds: 30,
  renewDeadlineSeconds: 20,
  retryPeriodSeconds: 5,
}

const EXPIRY_SAFETY_MARGIN_MS = 2_000
const NOT_LEADER_RETRY_AFTER_SECONDS = 5

const globalState = globalThis as typeof globalThis & {
  __agentsLeaderElection?: {
    started: boolean
    callbacks?: LeaderElectionCallbacks
    stop?: () => void
    config: LeaderElectionConfig
    status: LeaderElectionStatus
    lastLease?: V1Lease | null
    metrics?: {
      changesCounter: Counter
    }
  }
}

const nowIso = () => new Date().toISOString()
const toMicroTime = (date: Date) => new V1MicroTime(date.getTime())

export const isLeaderElectionRequired = () => resolveLeaderElectionSettings(process.env).required

const resolveIdentity = () => {
  const normalized = resolveLeaderElectionSettings(process.env)
  const podName = normalized.podName
  const uid = normalized.podUid ?? ''
  if (podName && uid) return `${podName}_${uid}`
  if (podName) return `${podName}_${randomUUID()}`
  return `unknown_${randomUUID()}`
}

export const resolveLeaderElectionConfig = (): LeaderElectionConfig => {
  const normalized = resolveLeaderElectionSettings(process.env)
  return {
    enabled: normalized.enabled,
    leaseName: normalized.leaseName || DEFAULT_CONFIG.leaseName,
    leaseNamespace: normalized.leaseNamespace,
    leaseDurationSeconds: normalized.leaseDurationSeconds,
    renewDeadlineSeconds: normalized.renewDeadlineSeconds,
    retryPeriodSeconds: normalized.retryPeriodSeconds,
  }
}

const ensureMetrics = () => {
  const state = globalState.__agentsLeaderElection
  if (!state || state.metrics) return

  const meter = otelMetrics.getMeter('agents')
  const changesCounter = meter.createCounter('agents_leader_changes_total', {
    description: 'Count of Agents leader election transitions (leader<->follower).',
  })

  state.metrics = { changesCounter }
}

type KubernetesLeaseErrorKind = 'notFound' | 'alreadyExists' | 'conflict' | 'unknown'

const classifyKubernetesLeaseError = (error: unknown): KubernetesLeaseErrorKind => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (message.includes('(NotFound)') || normalized.includes('notfound')) return 'notFound'
  if (message.includes('(AlreadyExists)') || normalized.includes('alreadyexists')) return 'alreadyExists'
  if (message.includes('(Conflict)') || normalized.includes('conflict')) return 'conflict'
  if (normalized.includes('the object has been modified')) return 'conflict'
  return 'unknown'
}

const parseLeaseTime = (value: unknown): number | null => {
  if (!value) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

const isLeaseExpired = (lease: V1Lease, nowMs: number, leaseDurationSeconds: number) => {
  const renewMs = parseLeaseTime(lease.spec?.renewTime)
  if (!renewMs) return true
  return nowMs - renewMs > leaseDurationSeconds * 1000 + EXPIRY_SAFETY_MARGIN_MS
}

const buildNewLease = (config: LeaderElectionConfig, identity: string, namespace: string, name: string): V1Lease => ({
  apiVersion: 'coordination.k8s.io/v1',
  kind: 'Lease',
  metadata: {
    name,
    namespace,
  },
  spec: {
    holderIdentity: identity,
    leaseDurationSeconds: config.leaseDurationSeconds,
    acquireTime: toMicroTime(new Date()),
    renewTime: toMicroTime(new Date()),
    leaseTransitions: 0,
  },
})

const updateLeaseForAcquireOrRenew = (current: V1Lease, config: LeaderElectionConfig, identity: string, now: Date) => {
  const previousHolder = (current.spec?.holderIdentity ?? '').trim()
  const nextTransitions = (() => {
    const currentTransitions = Number.isFinite(current.spec?.leaseTransitions)
      ? Math.max(0, Math.floor(current.spec?.leaseTransitions ?? 0))
      : 0
    if (!previousHolder || previousHolder === identity) return currentTransitions
    return currentTransitions + 1
  })()

  return {
    ...current,
    spec: {
      ...current.spec,
      holderIdentity: identity,
      leaseDurationSeconds: config.leaseDurationSeconds,
      renewTime: toMicroTime(now),
      acquireTime: current.spec?.acquireTime ?? toMicroTime(now),
      leaseTransitions: nextTransitions,
    },
  } satisfies V1Lease
}

const clearLeaseHolder = (current: V1Lease, config: LeaderElectionConfig, now: Date): V1Lease => ({
  ...current,
  spec: {
    ...current.spec,
    holderIdentity: '',
    leaseDurationSeconds: config.leaseDurationSeconds,
    renewTime: toMicroTime(now),
  },
})

const formatKubeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const setLeaderStatus = (isLeader: boolean, error?: string | null) => {
  const state = globalState.__agentsLeaderElection
  if (!state) return

  const changed = state.status.isLeader !== isLeader
  state.status.isLeader = isLeader
  state.status.lastError = error ?? null

  if (changed) {
    state.status.lastTransitionAt = nowIso()
    const leaseName = state.status.leaseName
    const leaseNamespace = state.status.leaseNamespace
    const identity = state.status.identity
    const suffix = error ? ` (${error})` : ''
    const serviceName = resolveRuntimeServiceName()
    console.info(
      `[${serviceName}] leader election transition: ${isLeader ? 'leader' : 'follower'} lease=${leaseNamespace}/${leaseName} identity=${identity}${suffix}`,
    )
    try {
      state.metrics?.changesCounter.add(1, { to: isLeader ? 'leader' : 'follower' })
    } catch {
      // Metrics must not affect leader election.
    }
  }
}

export const getLeaderElectionStatus = (): LeaderElectionStatus => {
  const existing = globalState.__agentsLeaderElection?.status
  if (existing) return { ...existing }

  const identity = resolveIdentity()
  const config = resolveLeaderElectionConfig()
  const required = isLeaderElectionRequired()
  const leaseNamespace = config.leaseNamespace || resolveLeaderElectionSettings(process.env).podNamespace

  return {
    enabled: config.enabled,
    required,
    isLeader: !config.enabled || !required,
    leaseName: config.leaseName,
    leaseNamespace,
    identity,
    lastTransitionAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }
}

export const isLeaderForControllers = () => {
  const status = getLeaderElectionStatus()
  if (!status.enabled || !status.required) return true
  return status.isLeader
}

export const requireLeaderForMutationHttp = (): Response | null => {
  const leaderElection = getLeaderElectionStatus()
  if (!leaderElection.enabled || !leaderElection.required) return null
  if (leaderElection.isLeader) return null

  const body = JSON.stringify({
    ok: false,
    error: 'Not leader; retry on the elected controller replica.',
  })
  return new Response(body, {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
      'retry-after': String(NOT_LEADER_RETRY_AFTER_SECONDS),
    },
  })
}

export const stopLeaderElectionRuntime = () => {
  globalState.__agentsLeaderElection?.stop?.()
  Reflect.deleteProperty(globalState, '__agentsLeaderElection')
}

export const ensureLeaderElectionRuntime = (callbacks: LeaderElectionCallbacks) => {
  if (isRuntimeTestEnv(process.env)) return
  const required = isLeaderElectionRequired()
  const config = resolveLeaderElectionConfig()
  const kubeGateway = createKubeGateway()

  if (!config.enabled || !required) {
    if (!globalState.__agentsLeaderElection) {
      const identity = resolveIdentity()
      const leaseNamespace = config.leaseNamespace || resolveLeaderElectionSettings(process.env).podNamespace
      globalState.__agentsLeaderElection = {
        started: false,
        config: { ...config, leaseNamespace },
        status: {
          enabled: config.enabled,
          required,
          isLeader: true,
          leaseName: config.leaseName,
          leaseNamespace,
          identity,
          lastTransitionAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastError: null,
        } as LeaderElectionStatus,
      }
    }
    callbacks.onLeader()
    return
  }

  if (globalState.__agentsLeaderElection?.started) {
    globalState.__agentsLeaderElection.callbacks = callbacks
    return
  }

  const identity = resolveIdentity()
  const leaseNamespace = config.leaseNamespace || resolveLeaderElectionSettings(process.env).podNamespace
  const state = {
    started: true,
    callbacks,
    config: { ...config, leaseNamespace },
    status: {
      enabled: config.enabled,
      required,
      isLeader: false,
      leaseName: config.leaseName,
      leaseNamespace,
      identity,
      lastTransitionAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    } as LeaderElectionStatus,
    lastLease: null as V1Lease | null,
    metrics: undefined as { changesCounter: Counter } | undefined,
    stop: undefined as (() => void) | undefined,
  }
  globalState.__agentsLeaderElection = state
  ensureMetrics()

  let stopped = false
  let lastSuccessMs = 0
  let timeout: ReturnType<typeof setTimeout> | null = null
  let appliedLeader: boolean | null = null

  const stop = () => {
    stopped = true
    if (timeout) clearTimeout(timeout)
    timeout = null
  }
  state.stop = stop

  const tick = async () => {
    if (stopped) return

    const now = new Date()
    state.status.lastAttemptAt = now.toISOString()

    try {
      let lease = await kubeGateway.getLease(leaseNamespace, state.config.leaseName)

      if (!lease) {
        try {
          lease = await kubeGateway.createLease(
            leaseNamespace,
            buildNewLease(state.config, identity, leaseNamespace, state.config.leaseName),
          )
        } catch (createError) {
          const createKind = classifyKubernetesLeaseError(createError)
          if (createKind === 'alreadyExists') {
            lease = await kubeGateway.getLease(leaseNamespace, state.config.leaseName)
          } else {
            throw createError
          }
        }
      }

      if (!lease) {
        setLeaderStatus(false, 'lease missing after read/create')
      } else {
        state.lastLease = lease
        const holder = (lease.spec?.holderIdentity ?? '').trim()
        const nowMs = now.getTime()

        const expired = isLeaseExpired(lease, nowMs, state.config.leaseDurationSeconds)
        const canAcquire = !holder || expired || holder === identity

        if (!canAcquire) {
          setLeaderStatus(false, null)
        } else {
          const updated = updateLeaseForAcquireOrRenew(lease, state.config, identity, now)
          const replaced = await kubeGateway.replaceLease(leaseNamespace, updated)
          state.lastLease = replaced
          lastSuccessMs = nowMs
          state.status.lastSuccessAt = now.toISOString()
          setLeaderStatus(true, null)
        }
      }
    } catch (error) {
      const message = formatKubeError(error)
      if (classifyKubernetesLeaseError(error) === 'conflict') {
        setLeaderStatus(false, null)
      } else {
        setLeaderStatus(false, message)
      }
    }

    const renewDeadlineMs = state.config.renewDeadlineSeconds * 1000
    if (state.status.isLeader && lastSuccessMs > 0 && now.getTime() - lastSuccessMs > renewDeadlineMs) {
      setLeaderStatus(false, `renew deadline exceeded (${state.config.renewDeadlineSeconds}s)`)
    }

    const leaderNow = state.status.isLeader
    if (appliedLeader !== leaderNow) {
      appliedLeader = leaderNow
      if (leaderNow) {
        state.callbacks?.onLeader()
      } else {
        state.callbacks?.onFollower()
      }
    }

    timeout = setTimeout(tick, state.config.retryPeriodSeconds * 1000)
  }

  const tryRelease = async () => {
    const snapshot = globalState.__agentsLeaderElection
    if (!snapshot) return

    let lease: V1Lease
    try {
      const currentLease = await kubeGateway.getLease(leaseNamespace, snapshot.config.leaseName)
      if (!currentLease) return
      lease = currentLease
    } catch {
      return
    }

    const holder = (lease.spec?.holderIdentity ?? '').trim()
    if (holder !== identity) return

    const released = clearLeaseHolder(lease, snapshot.config, new Date())
    try {
      await kubeGateway.replaceLease(leaseNamespace, released)
    } catch {
      // Best-effort only.
    }
  }

  process.once('SIGTERM', () => {
    stop()
    setLeaderStatus(false, 'terminating')
    state.callbacks?.onFollower()
    void tryRelease().catch(() => undefined)
  })
  process.once('SIGINT', () => {
    stop()
    setLeaderStatus(false, 'interrupt')
    state.callbacks?.onFollower()
    void tryRelease().catch(() => undefined)
  })

  state.callbacks.onFollower()
  appliedLeader = false
  void tick()
}

export const createLeaderElectionService = (): LeaderElectionService => ({
  ensureRuntime: (callbacks) =>
    Effect.try({
      try: () => ensureLeaderElectionRuntime(callbacks),
      catch: (cause) => new LeaderElectionRuntimeError({ operation: 'ensure', cause }),
    }),
  getStatus: Effect.sync(() => getLeaderElectionStatus()),
  isLeaderForControllers: Effect.sync(() => isLeaderForControllers()),
  stop: Effect.sync(() => stopLeaderElectionRuntime()),
})

export const LeaderElectionLive = Layer.scoped(
  LeaderElection,
  Effect.gen(function* () {
    const service = createLeaderElectionService()
    yield* Effect.addFinalizer(() => service.stop)
    return service
  }),
)

const leaderElectionRuntime = ManagedRuntime.make(LeaderElectionLive)

export const ensureLeaderElectionRuntimeEffect = (callbacks: LeaderElectionCallbacks) =>
  Effect.flatMap(LeaderElection, (service) => service.ensureRuntime(callbacks))

export const getLeaderElectionStatusEffect = Effect.flatMap(LeaderElection, (service) => service.getStatus)

export const runLeaderElectionEffect = <A, E>(effect: Effect.Effect<A, E, LeaderElection>): Promise<A> =>
  leaderElectionRuntime.runPromise(effect)

export const __test__ = {
  buildNewLease,
  classifyKubernetesLeaseError,
  clearLeaseHolder,
  isLeaseExpired,
  parseLeaseTime,
  stopLeaderElectionRuntime,
  updateLeaseForAcquireOrRenew,
}
