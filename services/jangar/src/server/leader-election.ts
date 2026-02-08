import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

import { type V1Lease } from '@kubernetes/client-node'
import { type Counter, metrics as otelMetrics } from '@proompteng/otel/api'

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

type LeaderElectionCallbacks = {
  onLeader: () => void
  onFollower: () => void
}

const DEFAULT_CONFIG: Omit<LeaderElectionConfig, 'leaseNamespace'> & { leaseNamespace: '' } = {
  enabled: true,
  leaseName: 'jangar-controller-leader',
  leaseNamespace: '',
  leaseDurationSeconds: 30,
  renewDeadlineSeconds: 20,
  retryPeriodSeconds: 5,
}

const EXPIRY_SAFETY_MARGIN_MS = 2_000
const NOT_LEADER_RETRY_AFTER_SECONDS = 5

const globalState = globalThis as typeof globalThis & {
  __jangarLeaderElection?: {
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
const toMicroTime = (date: Date) => date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'n') return false
  return fallback
}

const parseNumberEnv = (value: string | undefined, fallback: number, min: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.floor(parsed)
  return rounded >= min ? rounded : fallback
}

const isControllerWorkloadFlagEnabled = (value: string | undefined, defaultValue: boolean) => {
  const normalized = (value ?? (defaultValue ? '1' : '0')).trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false'
}

export const isLeaderElectionRequired = () => {
  if (process.env.NODE_ENV === 'test') return false
  // Only gate when this process is actually running leader-gated controller loops.
  const agents = isControllerWorkloadFlagEnabled(process.env.JANGAR_AGENTS_CONTROLLER_ENABLED, true)
  const orchestration = isControllerWorkloadFlagEnabled(process.env.JANGAR_ORCHESTRATION_CONTROLLER_ENABLED, true)
  const supporting = isControllerWorkloadFlagEnabled(process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED, true)
  const primitives = isControllerWorkloadFlagEnabled(process.env.JANGAR_PRIMITIVES_RECONCILER, true)
  return agents || orchestration || supporting || primitives
}

const resolveIdentity = () => {
  const podName = (process.env.HOSTNAME ?? '').trim()
  const uid = (process.env.JANGAR_POD_UID ?? '').trim()
  if (podName && uid) return `${podName}_${uid}`
  if (podName) return `${podName}_${randomUUID()}`
  return `unknown_${randomUUID()}`
}

export const resolveLeaderElectionConfig = (): LeaderElectionConfig => {
  const enabled = parseBooleanEnv(process.env.JANGAR_LEADER_ELECTION_ENABLED, DEFAULT_CONFIG.enabled)
  const leaseName = (process.env.JANGAR_LEADER_ELECTION_LEASE_NAME ?? DEFAULT_CONFIG.leaseName).trim()
  const leaseNamespace = (process.env.JANGAR_LEADER_ELECTION_LEASE_NAMESPACE ?? DEFAULT_CONFIG.leaseNamespace).trim()
  const leaseDurationSeconds = parseNumberEnv(
    process.env.JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS,
    DEFAULT_CONFIG.leaseDurationSeconds,
    1,
  )
  const renewDeadlineSeconds = parseNumberEnv(
    process.env.JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
    DEFAULT_CONFIG.renewDeadlineSeconds,
    1,
  )
  const retryPeriodSeconds = parseNumberEnv(
    process.env.JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS,
    DEFAULT_CONFIG.retryPeriodSeconds,
    1,
  )

  // Enforce timing invariants to avoid pathological flapping.
  const normalized = {
    enabled,
    leaseName: leaseName || DEFAULT_CONFIG.leaseName,
    leaseNamespace,
    leaseDurationSeconds,
    renewDeadlineSeconds,
    retryPeriodSeconds,
  }

  if (!(normalized.retryPeriodSeconds < normalized.renewDeadlineSeconds)) {
    console.warn(
      `[jangar] leader election timing invalid: retryPeriodSeconds (${normalized.retryPeriodSeconds}) must be < renewDeadlineSeconds (${normalized.renewDeadlineSeconds}); using defaults`,
    )
    normalized.renewDeadlineSeconds = DEFAULT_CONFIG.renewDeadlineSeconds
    normalized.retryPeriodSeconds = DEFAULT_CONFIG.retryPeriodSeconds
  }
  if (!(normalized.renewDeadlineSeconds < normalized.leaseDurationSeconds)) {
    console.warn(
      `[jangar] leader election timing invalid: renewDeadlineSeconds (${normalized.renewDeadlineSeconds}) must be < leaseDurationSeconds (${normalized.leaseDurationSeconds}); using defaults`,
    )
    normalized.leaseDurationSeconds = DEFAULT_CONFIG.leaseDurationSeconds
    normalized.renewDeadlineSeconds = DEFAULT_CONFIG.renewDeadlineSeconds
    normalized.retryPeriodSeconds = DEFAULT_CONFIG.retryPeriodSeconds
  }

  return normalized
}

const ensureMetrics = () => {
  const state = globalState.__jangarLeaderElection
  if (!state) return
  if (state.metrics) return

  const meter = otelMetrics.getMeter('jangar')
  const changesCounter = meter.createCounter('jangar_leader_changes_total', {
    description: 'Count of leader election transitions (leader<->follower).',
  })

  state.metrics = { changesCounter }
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

const runCommand = (command: string, args: string[], input?: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }))
    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })

const kubectl = async (args: string[], input?: string, context?: string) => {
  const result = await runCommand('kubectl', args, input)
  if (result.exitCode === 0) {
    return result.stdout.trim()
  }
  const details = result.stderr.trim() || result.stdout.trim()
  throw new Error(`${context ?? 'kubectl'} failed: ${details || `exit ${result.exitCode}`}`)
}

const parseJson = <T>(raw: string, context: string): T => {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type KubectlErrorKind = 'notFound' | 'alreadyExists' | 'conflict' | 'unknown'

const classifyKubectlError = (error: unknown): KubectlErrorKind => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('(NotFound)') || message.toLowerCase().includes('notfound')) return 'notFound'
  if (message.includes('(AlreadyExists)') || message.toLowerCase().includes('alreadyexists')) return 'alreadyExists'
  if (message.includes('(Conflict)') || message.toLowerCase().includes('conflict')) return 'conflict'
  if (message.toLowerCase().includes('the object has been modified')) return 'conflict'
  return 'unknown'
}

const getLease = async (namespace: string, name: string): Promise<V1Lease> => {
  const output = await kubectl(['get', 'lease', name, '-n', namespace, '-o', 'json'], undefined, 'kubectl get lease')
  return parseJson<V1Lease>(output, 'kubectl get lease')
}

const createLease = async (namespace: string, lease: V1Lease): Promise<V1Lease> => {
  const output = await kubectl(
    ['create', '-f', '-', '-n', namespace, '-o', 'json'],
    JSON.stringify(lease),
    'kubectl create lease',
  )
  return parseJson<V1Lease>(output, 'kubectl create lease')
}

const replaceLease = async (namespace: string, lease: V1Lease): Promise<V1Lease> => {
  const output = await kubectl(
    ['replace', '-f', '-', '-n', namespace, '-o', 'json'],
    JSON.stringify(lease),
    'kubectl replace lease',
  )
  return parseJson<V1Lease>(output, 'kubectl replace lease')
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
      ...(current.spec ?? {}),
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
    ...(current.spec ?? {}),
    holderIdentity: '',
    leaseDurationSeconds: config.leaseDurationSeconds,
    renewTime: toMicroTime(now),
  },
})

const formatKubeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const setLeaderStatus = (isLeader: boolean, error?: string | null) => {
  const state = globalState.__jangarLeaderElection
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
    console.info(
      `[jangar] leader election transition: ${isLeader ? 'leader' : 'follower'} lease=${leaseNamespace}/${leaseName} identity=${identity}${suffix}`,
    )
    try {
      state.metrics?.changesCounter.add(1, { to: isLeader ? 'leader' : 'follower' })
    } catch {
      // ignore metrics failures
    }
  }
}

export const getLeaderElectionStatus = (): LeaderElectionStatus => {
  const existing = globalState.__jangarLeaderElection?.status
  if (existing) return { ...existing }

  const identity = resolveIdentity()
  const config = resolveLeaderElectionConfig()
  const required = isLeaderElectionRequired()
  const leaseNamespace = config.leaseNamespace || process.env.JANGAR_POD_NAMESPACE?.trim() || 'default'

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

export const ensureLeaderElectionRuntime = (callbacks: LeaderElectionCallbacks) => {
  if (process.env.NODE_ENV === 'test') return
  const required = isLeaderElectionRequired()
  const config = resolveLeaderElectionConfig()

  if (!config.enabled || !required) {
    // Keep a stable status object available for endpoint gating and status pages.
    if (!globalState.__jangarLeaderElection) {
      const identity = resolveIdentity()
      const leaseNamespace = config.leaseNamespace || process.env.JANGAR_POD_NAMESPACE?.trim() || 'default'
      globalState.__jangarLeaderElection = {
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

  if (globalState.__jangarLeaderElection?.started) {
    globalState.__jangarLeaderElection.callbacks = callbacks
    return
  }

  const identity = resolveIdentity()
  const leaseNamespace = config.leaseNamespace || process.env.JANGAR_POD_NAMESPACE?.trim() || 'default'
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
    kube: undefined as { api: CoordinationV1Api } | undefined,
    metrics: undefined as { changesCounter: Counter } | undefined,
    stop: undefined as (() => void) | undefined,
  }
  globalState.__jangarLeaderElection = state
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
      let lease: V1Lease | null = null
      try {
        lease = await getLease(leaseNamespace, state.config.leaseName)
      } catch (error) {
        const kind = classifyKubectlError(error)
        if (kind === 'notFound') {
          try {
            lease = await createLease(
              leaseNamespace,
              buildNewLease(state.config, identity, leaseNamespace, state.config.leaseName),
            )
          } catch (createError) {
            const createKind = classifyKubectlError(createError)
            if (createKind === 'alreadyExists') {
              lease = await getLease(leaseNamespace, state.config.leaseName)
            } else {
              throw createError
            }
          }
        } else {
          throw error
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
          // Ensure optimistic concurrency: replace will fail on resourceVersion mismatch.
          const replaced = await replaceLease(leaseNamespace, updated)
          state.lastLease = replaced
          lastSuccessMs = nowMs
          state.status.lastSuccessAt = now.toISOString()
          setLeaderStatus(true, null)
        }
      }
    } catch (error) {
      const message = formatKubeError(error)
      // Conflicts are expected under contention; treat as follower and retry.
      if (classifyKubectlError(error) === 'conflict') {
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
    const snapshot = globalState.__jangarLeaderElection
    if (!snapshot) return

    // Best-effort release: clear holderIdentity so another replica can take leadership sooner.
    // This must run even during shutdown after `stop()` / `setLeaderStatus(false, ...)`.
    let lease: V1Lease
    try {
      lease = await getLease(leaseNamespace, snapshot.config.leaseName)
    } catch {
      return
    }

    const holder = (lease.spec?.holderIdentity ?? '').trim()
    if (holder !== identity) return

    const released = clearLeaseHolder(lease, snapshot.config, new Date())
    try {
      await replaceLease(leaseNamespace, released)
    } catch {
      // Best-effort only.
    }
  }

  process.once('SIGTERM', () => {
    // Fail readiness quickly. Releasing the Lease is best-effort.
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

  // Ensure follower state at startup until a Lease is acquired.
  state.callbacks.onFollower()
  appliedLeader = false
  void tick()
}
