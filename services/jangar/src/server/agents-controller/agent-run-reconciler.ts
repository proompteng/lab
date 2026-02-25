import { recordAgentQueueDepth, recordAgentRateLimitRejection } from '~/server/metrics'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { type createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import type { createPrimitivesStore } from '~/server/primitives-store'

import { type Condition, upsertCondition } from './conditions'
import { parseStringList } from './env-config'
import { hashAgentRunImmutableSpec } from './immutable-spec'
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
    const metadata = asRecord(agentRun.metadata) ?? {}
    const name = asString(metadata.name) ?? ''
    const spec = asRecord(agentRun.spec) ?? {}
    const status = asRecord(agentRun.status) ?? {}
    const phase = asString(status.phase) ?? 'Pending'
    const finishedAt = asString(status.finishedAt)
    const agentName = asString(readNested(spec, ['agentRef', 'name']))
    const finalizer = 'agents.proompteng.ai/runtime-cleanup'
    const finalizers = Array.isArray(metadata.finalizers)
      ? metadata.finalizers.filter((item): item is string => typeof item === 'string')
      : []
    const hasFinalizer = finalizers.includes(finalizer)
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
            console.warn('[jangar] runtime cleanup failed', error)
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
        if (!isKubeNotFoundError(error)) {
          throw error
        }
      }
      return
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

            if (canonicalRunName && canonicalRunName !== name) {
              const existing = await kube.get(RESOURCE_MAP.AgentRun, canonicalRunName, namespace)
              const existingPhase = asString(readNested(existing, ['status', 'phase'])) ?? 'Pending'
              const duplicateReason =
                existing &&
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
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message: `Agent ${agentName} reached concurrency limit`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
      return
    }

    const repoLimit = resolveRepoConcurrencyLimit(repository, concurrency.repoConcurrency)
    if (shouldSubmit && repoLimit !== null) {
      const repoKey = normalizeRepositoryKey(repository)
      if ((inFlight.perRepository.get(repoKey) ?? 0) >= repoLimit) {
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'ConcurrencyLimit',
          message: `Repository ${repository} reached concurrency limit`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }
    }

    if (shouldSubmit && inFlight.total >= concurrency.perNamespace) {
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message: `Namespace ${namespace} reached concurrency limit`,
      })
      await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
      return
    }

    if (shouldSubmit && globalInFlight >= concurrency.cluster) {
      const updated = upsertCondition(conditions, {
        type: 'Blocked',
        status: 'True',
        reason: 'ConcurrencyLimit',
        message: 'Cluster concurrency limit reached',
      })
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
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message: `Namespace ${namespace} reached queue limit`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }

      if (queueLimits.cluster > 0 && queueCounts.queuedCluster >= queueLimits.cluster) {
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message: 'Cluster queue limit reached',
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }

      if (normalizedRepo && queueLimits.perRepo > 0 && queueCounts.queuedRepo >= queueLimits.perRepo) {
        const updated = upsertCondition(conditions, {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message: `Repository ${repository} reached queue limit`,
        })
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
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Pending' })
        return
      }
    }

    if (shouldSubmit) {
      if (!runtimeType) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingRuntime',
          message: 'spec.runtime.type is required',
        })
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
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }
      const parameters = resolveParameters(agentRun)

      if (runtimeType === 'job') {
        workloadImage = resolveJobImage(workload)
        if (!workloadImage) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingWorkloadImage',
            message:
              'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime',
          })
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
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (runtimeType === 'custom') {
        const endpoint = asString(runtimeConfig.endpoint)
        if (!endpoint) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingEndpoint',
            message: 'spec.runtime.config.endpoint is required for custom runtime',
          })
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (runtimeType === 'temporal') {
        const workflowType = asString(runtimeConfig.workflowType)
        const taskQueue = asString(runtimeConfig.taskQueue)
        if (!workflowType || !taskQueue) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'MissingTemporalConfig',
            message:
              'spec.runtime.config.workflowType and spec.runtime.config.taskQueue are required for temporal runtime',
          })
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
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingAgent',
          message: `agent ${agentName} not found`,
        })
        await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
        return
      }

      const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
      const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
      if (!provider) {
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingProvider',
          message: `agent provider ${providerName ?? 'unknown'} not found`,
        })
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
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message: `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`,
          })
          await setStatus(kube, agentRun, { observedGeneration, conditions: updated, phase: 'Failed' })
          return
        }
      }

      if (allowedServiceAccounts.length > 0 && (runtimeType === 'job' || runtimeType === 'workflow')) {
        const rawServiceAccount = resolveRunnerServiceAccount(runtimeConfig)
        const effectiveServiceAccount = rawServiceAccount || 'default'
        if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'ServiceAccountNotAllowed',
            message: `serviceAccount ${effectiveServiceAccount} is not allowlisted`,
          })
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
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingImplementation',
          message: 'implementationSpecRef or implementation.inline is required',
        })
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
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'MissingMemory',
          message: `memory ${missingName} not found`,
        })
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
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: 'SecretBlocked',
          message: `secrets blocked by controller policy: ${blockedSecrets.join(', ')}`,
        })
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
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message: `memory secret ${memorySecretName} is not allowlisted by the Agent`,
          })
          await setStatus(kube, agentRun, {
            observedGeneration,
            conditions: updated,
            phase: 'Failed',
            contract: contractStatus,
          })
          return
        }
        if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
          const updated = upsertCondition(conditions, {
            type: 'InvalidSpec',
            status: 'True',
            reason: 'SecretNotAllowed',
            message: `memory secret ${memorySecretName} is not included in spec.secrets`,
          })
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
        const updated = upsertCondition(conditions, {
          type: 'InvalidSpec',
          status: 'True',
          reason: vcsResolution.reason ?? 'VcsUnavailable',
          message: vcsResolution.message ?? 'vcs provider unavailable',
        })
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
          newRuntimeRef = await submitCustomRun(agentRun, implResource, memory)
        } else if (runtimeType === 'temporal') {
          newRuntimeRef = await submitTemporalRun(
            agentRun,
            agent,
            provider,
            implResource,
            memory,
            vcsContext,
            resolvedParameters,
            systemPromptResolution.systemPrompt,
          )
        } else {
          throw new Error(`unknown runtime type: ${runtimeType}`)
        }

        const updated = upsertCondition(baseConditions, {
          type: 'Accepted',
          status: 'True',
          reason: 'Submitted',
        })
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
        const updated = upsertCondition(baseConditions, {
          type: 'Failed',
          status: 'True',
          reason: 'SubmitFailed',
          message: error instanceof Error ? error.message : String(error),
        })
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
          const updated = upsertCondition(conditions, {
            type: 'Warning',
            status: 'True',
            reason: 'JobMissing',
            message: `job ${asString(runtimeRef.name) ?? 'unknown'} not found`,
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
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Succeeded',
          startedAt: asString(jobStatus.startTime) ?? asString(status.startedAt) ?? undefined,
          finishedAt: asString(jobStatus.completionTime) ?? nowIso(),
          runtimeRef,
          conditions: updated,
          vcs: asRecord(status.vcs) ?? undefined,
        })
        await applyJobTtlAfterStatus(kube, job, asString(runtimeRef.namespace) ?? namespace, runtimeConfig)
      } else if (failed > 0 && isJobFailed(job)) {
        const updated = upsertCondition(conditions, {
          type: 'Failed',
          status: 'True',
          reason: 'JobFailed',
        })
        await setStatus(kube, agentRun, {
          observedGeneration,
          phase: 'Failed',
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
