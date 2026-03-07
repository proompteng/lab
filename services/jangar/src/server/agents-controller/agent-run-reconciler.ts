import { recordAgentQueueDepth, recordAgentRateLimitRejection } from '~/server/metrics'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { type createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import type { createPrimitivesStore } from '~/server/primitives-store'

import { type Condition, upsertCondition } from './conditions'
import { parseStringList } from './env-config'
import { hashAgentRunImmutableSpec } from './immutable-spec'
import { extractJobFailureDetail } from './job-status'
import { resolveMemory } from './namespace-state'
import { normalizeLabelMap, validateAuthSecretPolicy, validateImagePolicy, validateLabelPolicy } from './policy'
import {
  buildQueueCounts,
  type ControllerState,
  normalizeRepositoryKey,
  type RepoConcurrencyConfig,
  resolveRepoConcurrencyLimit,
} from './queue-state'
import {
  type ControllerRateState,
  checkControllerRateLimits as evaluateControllerRateLimits,
  type RateLimits,
} from './rate-limits'
import {
  applyVcsMetadataToParameters,
  normalizeRepository,
  resolveImplementation,
  resolveParameters,
  resolveRunRepository,
} from './run-utils'
import { cancelRuntime, parseRuntimeRef, type RuntimeRef } from './runtime-resources'
import { resolveSystemPrompt } from './system-prompt'
import { collectBlockedSecrets, resolveAuthSecretConfig, resolveVcsContext } from './vcs-context'
import { validateParameters } from './workflow'
import { logAgentsControllerInfo, logAgentsControllerWarn, toLogError } from './operational-logging'

type KubeClient = ReturnType<typeof createKubernetesClient>

type ConcurrencyConfig = {
  perNamespace: number
  perAgent: number
  cluster: number
  repoConcurrency: RepoConcurrencyConfig
}

type InFlightCounts = {
  total: number
  perAgent: Map<string, number>
  perRepository: Map<string, number>
}

type QueueLimits = {
  perNamespace: number
  perRepo: number
  cluster: number
}

type PrimitivesStore = ReturnType<typeof createPrimitivesStore>

type ContractCheck =
  | { ok: true; requiredKeys: string[] }
  | { ok: false; reason: string; message: string; requiredKeys: string[]; missing?: string[] }

type TemporalCancelClient = {
  workflow: {
    cancel: (handle: { workflowId: string; runId?: string; namespace?: string }) => Promise<void>
  }
}

type AgentRunReconcilerDependencies = {
  setStatus: (kube: KubeClient, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>
  nowIso: () => string
  isKubeNotFoundError: (error: unknown) => boolean
  resolveJobImage: (workload: Record<string, unknown>) => string | null
  resolveAgentRunRetentionSeconds: (spec: Record<string, unknown>) => number
  getPrimitivesStore: () => Promise<PrimitivesStore | null>
  runKubectl: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number | null }>
  getTemporalClient: () => Promise<unknown>
  reconcileWorkflowRun: (
    kube: KubeClient,
    agentRun: Record<string, unknown>,
    namespace: string,
    memories: Record<string, unknown>[],
    options?: { initialSubmit?: boolean },
  ) => Promise<void>
  submitJobRun: (
    kube: KubeClient,
    agentRun: Record<string, unknown>,
    agent: Record<string, unknown>,
    provider: Record<string, unknown>,
    implementation: Record<string, unknown>,
    memory: Record<string, unknown> | null,
    namespace: string,
    workloadImage: string,
    runtimeType: 'job' | 'workflow',
    options?: Record<string, unknown>,
  ) => Promise<RuntimeRef>
  submitCustomRun: (
    agentRun: Record<string, unknown>,
    implementation: Record<string, unknown>,
    memory: Record<string, unknown> | null,
    systemPrompt?: string | null,
  ) => Promise<RuntimeRef>
  submitTemporalRun: (
    agentRun: Record<string, unknown>,
    agent: Record<string, unknown>,
    provider: Record<string, unknown>,
    implementation: Record<string, unknown>,
    memory: Record<string, unknown> | null,
    vcs?: Record<string, unknown> | null,
    parametersOverride?: Record<string, string>,
    systemPrompt?: string | null,
  ) => Promise<RuntimeRef>
  reconcileTemporalRun: (kube: KubeClient, agentRun: Record<string, unknown>, runtimeRef: RuntimeRef) => Promise<void>
  buildConditions: (resource: Record<string, unknown>) => Condition[]
  isAgentRunImmutabilityEnforced: () => boolean
  isAgentRunIdempotencyEnabled: () => boolean
  parseQueueLimits: () => QueueLimits
  parseRateLimits: () => RateLimits
  getControllerSnapshot: () => ControllerState | null
  getControllerRateState: () => ControllerRateState
  validateImplementationContract: (
    implementation: Record<string, unknown>,
    parameters: Record<string, string>,
  ) => ContractCheck
  buildContractStatus: (result: ContractCheck) => Record<string, unknown> | undefined
  resolveRunnerServiceAccount: (runtimeConfig: Record<string, unknown>) => string | null | undefined
  applyJobTtlAfterStatus: (
    kube: KubeClient,
    job: Record<string, unknown>,
    namespace: string,
    runtimeConfig: Record<string, unknown>,
  ) => Promise<void>
  isJobComplete: (job: Record<string, unknown>) => boolean
  isJobFailed: (job: Record<string, unknown>) => boolean
}

export const createAgentRunReconciler = (deps: AgentRunReconcilerDependencies) => {
  const {
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
    getControllerSnapshot,
    getControllerRateState,
    validateImplementationContract,
    buildContractStatus,
    resolveRunnerServiceAccount,
    applyJobTtlAfterStatus,
    isJobComplete,
    isJobFailed,
  } = deps
  const reconcileAgentRun = async (
    kube: ReturnType<typeof createKubernetesClient>,
    agentRun: Record<string, unknown>,
    namespace: string,
    memories: Record<string, unknown>[],
    existingRuns: Record<string, unknown>[],
    concurrency: ConcurrencyConfig,
    inFlight: InFlightCounts,
    globalInFlight: number,
  ) => {
    const reconcileStartedAt = Date.now()
    const metadata = asRecord(agentRun.metadata) ?? {}
    const name = asString(metadata.name) ?? ''
    const spec = asRecord(agentRun.spec) ?? {}
    const status = asRecord(agentRun.status) ?? {}
    const phase = asString(status.phase) ?? 'Pending'
    const finishedAt = asString(status.finishedAt)
    const agentName = asString(readNested(spec, ['agentRef', 'name']))
    const finalizer = 'agents.proompteng.ai/runtime-cleanup'
    let finalizers = Array.isArray(metadata.finalizers)
      ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
      : []
    let hasFinalizer = finalizers.includes(finalizer)
    const deleting = Boolean(metadata.deletionTimestamp)

    let conditions = buildConditions(agentRun)
    const observedGeneration = asRecord(agentRun.metadata)?.generation ?? 0
    const storedSpecHash = asString(status.specHash)
    const acceptedCondition = conditions.find((condition) => condition.type === 'Accepted')
    const acceptedLocked = acceptedCondition?.status === 'True' || phase !== 'Pending'

    if (acceptedLocked) {
      const currentHash = hashAgentRunImmutableSpec(agentRun)
      if (storedSpecHash && storedSpecHash !== currentHash) {
        const message = `immutable AgentRun spec fields changed after acceptance (expected ${storedSpecHash}, got ${currentHash})`
        if (isAgentRunImmutabilityEnforced()) {
          const runtimeRef = parseRuntimeRef(status.runtimeRef)
          if (runtimeRef) {
            try {
              await cancelRuntime({
                runtimeRef,
                namespace,
                runKubectl,
                getTemporalClient: getTemporalClient as () => Promise<TemporalCancelClient>,
              })
            } catch (error) {
              console.warn('[jangar] failed to cancel runtime after spec immutability violation', error)
            }
          }

          const updated = upsertCondition(conditions, {
            type: 'Failed',
            status: 'True',
            reason: 'SpecImmutableViolation',
            message,
          })
          await setStatus(kube, agentRun, {
            ...status,
            observedGeneration,
            phase: 'Failed',
            finishedAt: nowIso(),
            conditions: updated,
          })
          return
        }

        console.warn('[jangar] agent run spec immutability violation (warn-only)', { name, namespace, message })
        const existingWarning = conditions.find(
          (condition) => condition.type === 'Warning' && condition.reason === 'SpecImmutableViolation',
        )
        if (existingWarning?.status !== 'True' || existingWarning?.message !== message) {
          conditions = upsertCondition(conditions, {
            type: 'Warning',
            status: 'True',
            reason: 'SpecImmutableViolation',
            message,
          })
          await setStatus(kube, agentRun, {
            ...status,
            observedGeneration,
            phase,
            conditions,
          })
        }
      }
    }

    const runtimeType = asString(readNested(spec, ['runtime', 'type']))
    const runtimeConfig = asRecord(readNested(spec, ['runtime', 'config'])) ?? {}
    const workload = asRecord(readNested(spec, ['workload'])) ?? {}
    let workloadImage: string | null = null
    const repository = resolveRunRepository(agentRun)
    const logContext = {
      namespace,
      runName: name,
      generation: observedGeneration,
      runtimeType: runtimeType ?? 'unknown',
      repository: repository || '',
    }
    const logBlocked = (reason: string, message: string) => {
      logAgentsControllerInfo('reconcile_blocked', {
        ...logContext,
        decision: 'blocked',
        reason,
        message,
        durationMs: Date.now() - reconcileStartedAt,
      })
    }
    const logInvalidSpec = (reason: string, message: string) => {
      logAgentsControllerInfo('reconcile_invalid_spec', {
        ...logContext,
        decision: 'invalid_spec',
        reason,
        message,
        durationMs: Date.now() - reconcileStartedAt,
      })
    }
    const logSubmitted = (runtimeRef: RuntimeRef | null) => {
      logAgentsControllerInfo('reconcile_submitted', {
        ...logContext,
        decision: 'submitted',
        runtimeRefType: runtimeRef?.type ?? 'unknown',
        runtimeRefName: runtimeRef?.name ?? '',
        durationMs: Date.now() - reconcileStartedAt,
      })
    }
    const logSubmitFailed = (reason: string, message: string) => {
      logAgentsControllerWarn('reconcile_submit_failed', {
        ...logContext,
        decision: 'submit_failed',
        reason,
        message,
        durationMs: Date.now() - reconcileStartedAt,
      })
    }
    const logTerminalOutcome = (outcome: 'Succeeded' | 'Failed', reason: string, message: string) => {
      logAgentsControllerInfo('reconcile_terminal', {
        ...logContext,
        decision: 'terminal',
        outcome,
        reason,
        message,
        durationMs: Date.now() - reconcileStartedAt,
      })
    }

    logAgentsControllerInfo('reconcile_started', {
      ...logContext,
      decision: 'start',
      phase,
    })

    if (deleting) {
      if (hasFinalizer) {
        const runtimeRef = parseRuntimeRef(status.runtimeRef)
        if (runtimeRef) {
          try {
            await cancelRuntime({
              runtimeRef,
              namespace,
              runKubectl,
              getTemporalClient: getTemporalClient as () => Promise<TemporalCancelClient>,
            })
          } catch (error) {
            logAgentsControllerWarn('runtime_cleanup_failed', {
              ...logContext,
              ...toLogError(error),
            })
          }
        }
        try {
          await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
            metadata: { finalizers: finalizers.filter((item) => item !== finalizer) },
          })
        } catch (error) {
          if (!isKubeNotFoundError(error)) {
            throw error
          }
        }
      }
      return
    }

    if (!hasFinalizer) {
      try {
        await kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
          metadata: { finalizers: [...finalizers, finalizer] },
        })
      } catch (error) {
        if (isKubeNotFoundError(error)) return
        throw error
      }
      finalizers = [...finalizers, finalizer]
      hasFinalizer = true
    }

    if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') {
      const idempotencyKey = asString(readNested(spec, ['idempotencyKey']))
      if (isAgentRunIdempotencyEnabled() && idempotencyKey && agentName) {
        const store = await getPrimitivesStore()
        if (store) {
          try {
            await store.markAgentRunIdempotencyKeyTerminal({
              namespace,
              agentName,
              idempotencyKey,
              terminalPhase: phase,
              terminalAt: finishedAt ?? null,
            })
          } catch (error) {
            console.warn('[jangar] failed to mark AgentRun idempotency terminal state', error)
          }
        }
      }

      const retentionSeconds = resolveAgentRunRetentionSeconds(spec)
      if (retentionSeconds > 0 && finishedAt) {
        const finishedAtMs = Date.parse(finishedAt)
        if (!Number.isNaN(finishedAtMs)) {
          const expiresAtMs = finishedAtMs + retentionSeconds * 1000
          if (Date.now() >= expiresAtMs) {
            // Use non-blocking delete to avoid stalling the namespace reconcile queue on finalizers.
            await kube.delete(RESOURCE_MAP.AgentRun, name, namespace, { wait: false })
            return
          }
        }
      }
    }

    const runtimeRef = parseRuntimeRef(status.runtimeRef)
    const shouldSubmit =
      !runtimeRef && phase !== 'Running' && phase !== 'Succeeded' && phase !== 'Failed' && phase !== 'Cancelled'

    if (shouldSubmit && isAgentRunIdempotencyEnabled()) {
      const idempotencyKey = asString(readNested(spec, ['idempotencyKey']))
      if (idempotencyKey && agentName) {
        const store = await getPrimitivesStore()
        if (store) {
          try {
            const reservation = await store.reserveAgentRunIdempotencyKey({
              namespace,
              agentName,
              idempotencyKey,
            })
            let canonicalRunName = reservation.record.agentRunName
            if (!canonicalRunName) {
              const assigned = await store.assignAgentRunIdempotencyKey({
                namespace,
                agentName,
                idempotencyKey,
                agentRunName: name,
                agentRunUid: asString(metadata.uid) ?? null,
              })
              canonicalRunName = assigned?.agentRunName ?? name
            }

            let canonicalRun: Record<string, unknown> | null = null
            if (canonicalRunName && canonicalRunName !== name) {
              canonicalRun = await kube.get(RESOURCE_MAP.AgentRun, canonicalRunName, namespace)
              if (!canonicalRun) {
                // Reclaim stale idempotency reservations when the canonical run was deleted.
                const reassigned = await store.assignAgentRunIdempotencyKey({
                  namespace,
                  agentName,
                  idempotencyKey,
                  agentRunName: name,
                  agentRunUid: asString(metadata.uid) ?? null,
                })
                canonicalRunName = reassigned?.agentRunName ?? name
                if (canonicalRunName && canonicalRunName !== name) {
                  canonicalRun = await kube.get(RESOURCE_MAP.AgentRun, canonicalRunName, namespace)
                }
              }
            }

            if (canonicalRunName && canonicalRunName !== name) {
              const existingPhase = asString(readNested(canonicalRun, ['status', 'phase'])) ?? 'Pending'
              const duplicateReason =
                canonicalRun &&
                (existingPhase === 'Succeeded' || existingPhase === 'Failed' || existingPhase === 'Cancelled')
                  ? 'IdempotencyKeyCompleted'
                  : 'IdempotencyKeyInUse'
              const updated = upsertCondition(conditions, {
                type: 'Duplicate',
                status: 'True',
                reason: duplicateReason,
                message: `AgentRun ${canonicalRunName} already claimed idempotencyKey ${idempotencyKey}`,
              })
              await setStatus(kube, agentRun, {
                observedGeneration,
                phase: 'Failed',
                finishedAt: nowIso(),
                conditions: updated,
              })
              return
            }
          } catch (error) {
            console.warn('[jangar] failed to enforce AgentRun idempotency', error)
          }
        }
      }
    }

    if (shouldSubmit && agentName && (inFlight.perAgent.get(agentName) ?? 0) >= concurrency.perAgent) {
      const message = `Agent ${agentName} reached concurrency limit`
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message,
      })
      logBlocked('ConcurrencyLimit', message)
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
      return
    }

    const repoLimit = resolveRepoConcurrencyLimit(repository, concurrency.repoConcurrency)
    if (shouldSubmit && repoLimit !== null) {
      const repoKey = normalizeRepositoryKey(repository)
      if ((inFlight.perRepository.get(repoKey) ?? 0) >= repoLimit) {
        const message = `Repository ${repository} reached concurrency limit`
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'ConcurrencyLimit',
          message,
        })
        logBlocked('ConcurrencyLimit', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }
    }

    if (shouldSubmit && inFlight.total >= concurrency.perNamespace) {
      const message = `Namespace ${namespace} reached concurrency limit`
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message,
      })
      logBlocked('ConcurrencyLimit', message)
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
      return
    }

    if (shouldSubmit && globalInFlight >= concurrency.cluster) {
      const message = 'Cluster concurrency limit reached'
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message,
      })
      logBlocked('ConcurrencyLimit', message)
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
      return
    }

    if (shouldSubmit) {
      const queueLimits = parseQueueLimits()
      const repository = resolveRunRepository(agentRun)
      const normalizedRepo = repository ? normalizeRepository(repository) : ''
      const queueCounts = buildQueueCounts({
        namespace,
        runName: name,
        normalizedRepo,
        namespaceRuns: existingRuns,
        controllerSnapshot: getControllerSnapshot(),
      })

      recordAgentQueueDepth(queueCounts.queuedNamespace, { scope: 'namespace', namespace })
      recordAgentQueueDepth(queueCounts.queuedCluster, { scope: 'cluster' })
      if (normalizedRepo) {
        recordAgentQueueDepth(queueCounts.queuedRepo, { scope: 'repo', repository: normalizedRepo, namespace })
      }

      if (queueLimits.perNamespace > 0 && queueCounts.queuedNamespace >= queueLimits.perNamespace) {
        const message = `Namespace ${namespace} reached queue limit`
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message,
        })
        logBlocked('QueueLimit', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }

      if (queueLimits.cluster > 0 && queueCounts.queuedCluster >= queueLimits.cluster) {
        const message = 'Cluster queue limit reached'
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message,
        })
        logBlocked('QueueLimit', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }

      if (normalizedRepo && queueLimits.perRepo > 0 && queueCounts.queuedRepo >= queueLimits.perRepo) {
        const message = `Repository ${repository} reached queue limit`
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message,
        })
        logBlocked('QueueLimit', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }

      const rateDecision = evaluateControllerRateLimits({
        namespace,
        repository: repository || null,
        state: getControllerRateState(),
        limits: parseRateLimits(),
        now: Date.now(),
        normalizeRepository,
      })
      if (!rateDecision.ok) {
        const rateAttributes: Record<string, string> = { namespace }
        if (normalizedRepo) {
          rateAttributes.repository = normalizedRepo
        }
        recordAgentRateLimitRejection(rateDecision.scope, rateAttributes)
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'RateLimit',
          message: `${rateDecision.message} (retry after ${rateDecision.retryAfterSeconds}s)`,
        })
        logBlocked('RateLimit', `${rateDecision.message} (retry after ${rateDecision.retryAfterSeconds}s)`)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }
    }

    if (shouldSubmit) {
      if (!runtimeType) {
        const message = 'spec.runtime.type is required'
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingRuntime',
          message,
        })
        logInvalidSpec('MissingRuntime', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }

      const parameterCheck = validateParameters(asRecord(spec.parameters) ?? {})
      if (!parameterCheck.ok) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: parameterCheck.reason,
          message: parameterCheck.message,
        })
        logInvalidSpec(parameterCheck.reason, parameterCheck.message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
      const labelPolicy = validateLabelPolicy(normalizeLabelMap(asRecord(metadata.labels) ?? {}))
      if (!labelPolicy.ok) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: labelPolicy.reason,
          message: labelPolicy.message,
        })
        logInvalidSpec(labelPolicy.reason, labelPolicy.message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
      const parameters = resolveParameters(agentRun)

      if (runtimeType === 'job') {
        workloadImage = resolveJobImage(workload)
        if (!workloadImage) {
          const message =
            'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime'
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingWorkloadImage',
            message,
          })
          logInvalidSpec('MissingWorkloadImage', message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
        const imagePolicy = validateImagePolicy([{ image: workloadImage, context: 'job runtime' }])
        if (!imagePolicy.ok) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: imagePolicy.reason,
            message: imagePolicy.message,
          })
          logInvalidSpec(imagePolicy.reason, imagePolicy.message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (runtimeType === 'custom') {
        const endpoint = asString(runtimeConfig.endpoint)
        if (!endpoint) {
          const message = 'spec.runtime.config.endpoint is required for custom runtime'
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingEndpoint',
            message,
          })
          logInvalidSpec('MissingEndpoint', message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (runtimeType === 'temporal') {
        const workflowType = asString(runtimeConfig.workflowType)
        const taskQueue = asString(runtimeConfig.taskQueue)
        if (!workflowType || !taskQueue) {
          const message =
            'spec.runtime.config.workflowType and spec.runtime.config.taskQueue are required for temporal runtime'
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingTemporalConfig',
            message,
          })
          logInvalidSpec('MissingTemporalConfig', message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (runtimeType === 'workflow') {
        await reconcileWorkflowRun(kube, agentRun, namespace, memories, { initialSubmit: true })
        return
      }

      const agent = agentName ? await kube.get(RESOURCE_MAP.Agent, agentName, namespace) : null
      if (!agent) {
        const message = `agent ${agentName} not found`
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingAgent',
          message,
        })
        logInvalidSpec('MissingAgent', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }

      const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
      const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
      if (!provider) {
        const message = `agent provider ${providerName ?? 'unknown'} not found`
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingProvider',
          message,
        })
        logInvalidSpec('MissingProvider', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }

      const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
      const allowedSecrets = parseStringList(security.allowedSecrets)
      const allowedServiceAccounts = parseStringList(security.allowedServiceAccounts)
      const runSecrets = parseStringList(spec.secrets)
      const authSecret = resolveAuthSecretConfig()

      if (allowedSecrets.length > 0) {
        const forbidden = runSecrets.filter((secret) => !allowedSecrets.includes(secret))
        if (forbidden.length > 0) {
          const message = `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message,
          })
          logInvalidSpec('SecretNotAllowed', message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (allowedServiceAccounts.length > 0 && (runtimeType === 'job' || runtimeType === 'workflow')) {
        const rawServiceAccount = resolveRunnerServiceAccount(runtimeConfig)
        const effectiveServiceAccount = rawServiceAccount || 'default'
        if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
          const message = `serviceAccount ${effectiveServiceAccount} is not allowlisted`
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'ServiceAccountNotAllowed',
            message,
          })
          logInvalidSpec('ServiceAccountNotAllowed', message)
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      const implementation = resolveImplementation(agentRun)
      let implResource = implementation
      if (!implementation) {
        const implRefName = asString(readNested(spec, ['implementationSpecRef', 'name']))
        if (implRefName) {
          const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, implRefName, namespace)
          implResource = asRecord(impl?.spec) ?? null
        }
      }

      if (!implResource) {
        const message = 'implementationSpecRef or implementation.inline is required'
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingImplementation',
          message,
        })
        logInvalidSpec('MissingImplementation', message)
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }

      const contractCheck = validateImplementationContract(implResource, parameters)
      const contractStatus = buildContractStatus(contractCheck)
      if (!contractCheck.ok) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: contractCheck.reason,
          message: contractCheck.message,
        })
        logInvalidSpec(contractCheck.reason, contractCheck.message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          conditions: updated,
          phase: 'Failed',
          contract: contractStatus,
        })
        return
      }

      const memory = resolveMemory(agentRun, agent, memories)
      const runMemoryRef = asString(readNested(spec, ['memoryRef', 'name']))
      const agentMemoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
      if ((runMemoryRef || agentMemoryRef) && !memory) {
        const missingName = runMemoryRef || agentMemoryRef || 'unknown'
        const message = `memory ${missingName} not found`
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingMemory',
          message,
        })
        logInvalidSpec('MissingMemory', message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          conditions: updated,
          phase: 'Failed',
          contract: contractStatus,
        })
        return
      }
      const memorySecretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
      const blockedSecrets = collectBlockedSecrets([
        ...runSecrets,
        ...(memorySecretName ? [memorySecretName] : []),
        ...(authSecret ? [authSecret.name] : []),
      ])
      if (blockedSecrets.length > 0) {
        const message = `secrets blocked by controller policy: ${blockedSecrets.join(', ')}`
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretBlocked',
          message,
        })
        logInvalidSpec('SecretBlocked', message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          conditions: updated,
          phase: 'Failed',
          contract: contractStatus,
        })
        return
      }

      const authSecretPolicy = validateAuthSecretPolicy(allowedSecrets, authSecret)
      if (!authSecretPolicy.ok) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: authSecretPolicy.reason,
          message: authSecretPolicy.message,
        })
        logInvalidSpec(authSecretPolicy.reason, authSecretPolicy.message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          conditions: updated,
          phase: 'Failed',
          contract: contractStatus,
        })
        return
      }
      if (memorySecretName) {
        if (allowedSecrets.length > 0 && !allowedSecrets.includes(memorySecretName)) {
          const message = `memory secret ${memorySecretName} is not allowlisted by the Agent`
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message,
          })
          logInvalidSpec('SecretNotAllowed', message)
          await setStatus(kube, agentRun, {
            observedGeneration,
            conditions: updated,
            phase: 'Failed',
            contract: contractStatus,
          })
          return
        }
        if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
          const message = `memory secret ${memorySecretName} is not included in spec.secrets`
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message,
          })
          logInvalidSpec('SecretNotAllowed', message)
          await setStatus(kube, agentRun, {
            observedGeneration,
            conditions: updated,
            phase: 'Failed',
            contract: contractStatus,
          })
          return
        }
      }

      const systemPromptResolution = await resolveSystemPrompt({
        kube,
        namespace,
        agentRun,
        agent,
        runSecrets,
        allowedSecrets,
      })
      if (!systemPromptResolution.ok) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: systemPromptResolution.reason,
          message: systemPromptResolution.message,
        })
        logInvalidSpec(systemPromptResolution.reason, systemPromptResolution.message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          conditions: updated,
          phase: 'Failed',
          contract: contractStatus,
        })
        return
      }

      const vcsResolution = await resolveVcsContext({
        kube,
        namespace,
        agentRun,
        agent,
        implementation: implResource,
        parameters,
        allowedSecrets,
        existingRuns,
      })
      if (!vcsResolution.ok) {
        const reason = vcsResolution.reason ?? 'VcsUnavailable'
        const message = vcsResolution.message ?? 'vcs provider unavailable'
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason,
          message,
        })
        logInvalidSpec(reason, message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Failed',
          finishedAt: nowIso(),
          conditions: updated,
          vcs: vcsResolution.status ?? undefined,
          contract: contractStatus,
        })
        return
      }
      const warnedConditions =
        (vcsResolution.warnings ?? []).length > 0
          ? upsertCondition(conditions, {
              type: 'Warning',
              status: 'True',
              reason: vcsResolution.warnings?.[0]?.reason ?? 'Warning',
              message: (vcsResolution.warnings ?? []).map((warning) => warning.message).join('; '),
            })
          : upsertCondition(conditions, { type: 'Warning', status: 'False', reason: 'None', message: '' })
      const baseConditions =
        vcsResolution.skip && vcsResolution.reason
          ? upsertCondition(warnedConditions, {
              type: 'VcsSkipped',
              status: 'True',
              reason: vcsResolution.reason,
              message: vcsResolution.message ?? '',
            })
          : warnedConditions
      const vcsContext = vcsResolution.context ?? null
      const vcsStatus = vcsResolution.status ?? undefined
      const resolvedParameters = applyVcsMetadataToParameters(parameters, vcsContext)

      let newRuntimeRef: RuntimeRef | null = null
      try {
        if (runtimeType === 'job') {
          newRuntimeRef = await submitJobRun(
            kube,
            agentRun,
            agent,
            provider,
            implResource,
            memory,
            namespace,
            workloadImage ?? '',
            runtimeType,
            {
              vcs: vcsResolution,
              parameters: resolvedParameters,
              systemPrompt: systemPromptResolution.systemPrompt,
              systemPromptHash: systemPromptResolution.systemPromptHash,
              systemPromptRef: systemPromptResolution.systemPromptRef,
            },
          )
        } else if (runtimeType === 'custom') {
          newRuntimeRef = await submitCustomRun(
            agentRun,
            implResource,
            memory,
            systemPromptResolution.resolvedSystemPrompt,
          )
        } else if (runtimeType === 'temporal') {
          newRuntimeRef = await submitTemporalRun(
            agentRun,
            agent,
            provider,
            implResource,
            memory,
            vcsContext,
            resolvedParameters,
            systemPromptResolution.resolvedSystemPrompt,
          )
        } else {
          throw new Error(`unknown runtime type: ${runtimeType}`)
        }

        const updated = upsertCondition(baseConditions, {
          type: 'Accepted',
          status: 'True',
          reason: 'Submitted',
        })
        logSubmitted(newRuntimeRef)
        await setStatus(kube, agentRun, {
          observedGeneration,
          runtimeRef: newRuntimeRef,
          phase: 'Running',
          startedAt: nowIso(),
          conditions: upsertCondition(updated, { type: 'InProgress', status: 'True', reason: 'Running' }),
          vcs: vcsStatus ?? undefined,
          contract: contractStatus,
          specHash: hashAgentRunImmutableSpec(agentRun),
          ...(systemPromptResolution.systemPromptHash
            ? { systemPromptHash: systemPromptResolution.systemPromptHash }
            : {}),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const updated = upsertCondition(baseConditions, {
          type: 'Failed',
          status: 'True',
          reason: 'SubmitFailed',
          message,
        })
        logSubmitFailed('SubmitFailed', message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Failed',
          finishedAt: nowIso(),
          conditions: updated,
          vcs: vcsStatus ?? undefined,
          contract: contractStatus,
        })
      }
      return
    }

    if (phase !== 'Running') return

    if (runtimeType === 'workflow' || runtimeRef?.type === 'workflow') {
      await reconcileWorkflowRun(kube, agentRun, namespace, memories)
      return
    }

    if (!runtimeRef) return

    if (runtimeRef.type === 'job') {
      const job = await kube.get('job', asString(runtimeRef.name) ?? '', asString(runtimeRef.namespace) ?? namespace)
      const runtimeRefRecord = asRecord(status.runtimeRef) ?? {}
      const jobObservedAt = asString(runtimeRefRecord.jobObservedAt)
      if (!job) {
        if (jobObservedAt) {
          const message = `job ${asString(runtimeRef.name) ?? 'unknown'} not found`
          const updated = upsertCondition(conditions, {
            type: 'Warning',
            status: 'True',
            reason: 'JobMissing',
            message,
          })
          logAgentsControllerWarn('reconcile_runtime_orphaned', {
            ...logContext,
            decision: 'runtime_orphaned',
            reason: 'JobMissing',
            message,
            durationMs: Date.now() - reconcileStartedAt,
          })
          await setStatus(kube, agentRun, {
            observedGeneration,
            phase: 'Running',
            startedAt: asString(status.startedAt) ?? nowIso(),
            runtimeRef,
            conditions: updated,
            vcs: asRecord(status.vcs) ?? undefined,
          })
        }
        return
      }
      const jobStatus = asRecord(job.status) ?? {}
      const succeeded = Number(jobStatus.succeeded ?? 0)
      const failed = Number(jobStatus.failed ?? 0)
      if (succeeded > 0 || isJobComplete(job)) {
        const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
        logTerminalOutcome('Succeeded', 'Completed', `job ${asString(runtimeRef.name) ?? 'unknown'} completed`)
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Succeeded',
          reason: undefined,
          message: undefined,
          startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
          finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
          runtimeRef,
          conditions: updated,
          vcs: asRecord(status.vcs) ?? undefined,
        })
        await applyJobTtlAfterStatus(kube, job, asString(runtimeRef.namespace) ?? namespace, runtimeConfig)
      } else if (failed > 0 && isJobFailed(job)) {
        const failureDetail = extractJobFailureDetail(job, {
          reason: 'JobFailed',
          message: `job ${asString(runtimeRef.name) ?? 'unknown'} failed`,
        })
        const updated = upsertCondition(conditions, {
          type: 'Failed',
          status: 'True',
          reason: failureDetail.reason,
          message: failureDetail.message,
        })
        logTerminalOutcome('Failed', failureDetail.reason, failureDetail.message)
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Failed',
          reason: failureDetail.reason,
          message: failureDetail.message,
          finishedAt: nowIso(),
          runtimeRef,
          conditions: updated,
          vcs: asRecord(status.vcs) ?? undefined,
        })
        await applyJobTtlAfterStatus(kube, job, asString(runtimeRef.namespace) ?? namespace, runtimeConfig)
      } else if (!jobObservedAt) {
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Running',
          reason: undefined,
          message: undefined,
          startedAt: asString(status.startedAt) ?? nowIso(),
          runtimeRef: {
            ...runtimeRef,
            jobObservedAt: nowIso(),
          },
          conditions,
          vcs: asRecord(status.vcs) ?? undefined,
        })
      }
    }

    if (runtimeRef.type === 'temporal') {
      await reconcileTemporalRun(kube, agentRun, runtimeRef)
    }
  }

  return {
    reconcileAgentRun,
  }
}
