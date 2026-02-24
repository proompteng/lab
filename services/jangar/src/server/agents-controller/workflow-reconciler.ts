import { asRecord, asString, readNested } from '~/server/primitives-http'
import { type createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

import { type Condition, upsertCondition } from './conditions'
import { parseStringList } from './env-config'
import { hashAgentRunImmutableSpec } from './immutable-spec'
import { resolveMemory } from './namespace-state'
import { type ImagePolicyCandidate, validateAuthSecretPolicy, validateImagePolicy } from './policy'
import { resolveImplementation, resolveParameters } from './run-utils'
import { buildRuntimeRef, parseRuntimeRef, type RuntimeRef } from './runtime-resources'
import { resolveSystemPrompt } from './system-prompt'
import { collectBlockedSecrets, resolveAuthSecretConfig, resolveVcsContext } from './vcs-context'
import {
  normalizeWorkflowStatus,
  parseWorkflowSteps,
  setWorkflowPhase,
  setWorkflowStepPhase,
  shouldRetryStep,
  validateWorkflowSteps,
  type WorkflowStepSpec,
} from './workflow'

type KubeClient = ReturnType<typeof createKubernetesClient>

type WorkflowContractCheck =
  | { ok: true; requiredKeys: string[] }
  | { ok: false; reason: string; message: string; requiredKeys: string[]; missing?: string[] }

type WorkflowReconcilerDependencies = {
  resolveRunnerServiceAccount: (runtimeConfig: Record<string, unknown>) => string | null | undefined
  resolveJobImage: (workload: Record<string, unknown>) => string | null
  validateImplementationContract: (
    implementation: Record<string, unknown>,
    parameters: Record<string, string>,
  ) => WorkflowContractCheck
  buildContractStatus: (result: WorkflowContractCheck) => Record<string, unknown> | undefined
  buildConditions: (resource: Record<string, unknown>) => Condition[]
  setStatus: (kube: KubeClient, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>
  nowIso: () => string
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
  applyJobTtlAfterStatus: (
    kube: KubeClient,
    job: Record<string, unknown>,
    namespace: string,
    runtimeConfig: Record<string, unknown>,
  ) => Promise<void>
  normalizeLabelValue: (value: string) => string
  isJobComplete: (job: Record<string, unknown>) => boolean
  isJobFailed: (job: Record<string, unknown>) => boolean
}

export const createWorkflowReconciler = (deps: WorkflowReconcilerDependencies) => {
  const loadWorkflowDependencies = async (
    kube: KubeClient,
    agentRun: Record<string, unknown>,
    namespace: string,
    memories: Record<string, unknown>[],
    runtimeConfig: Record<string, unknown>,
  ) => {
    const spec = asRecord(agentRun.spec) ?? {}
    const agentName = asString(readNested(spec, ['agentRef', 'name']))
    if (!agentName) {
      return {
        ok: false as const,
        reason: 'MissingAgent',
        message: 'spec.agentRef.name is required',
      }
    }
    const agent = await kube.get(RESOURCE_MAP.Agent, agentName, namespace)
    if (!agent) {
      return {
        ok: false as const,
        reason: 'MissingAgent',
        message: `agent ${agentName} not found`,
      }
    }

    const providerName = asString(readNested(agent, ['spec', 'providerRef', 'name']))
    const provider = providerName ? await kube.get(RESOURCE_MAP.AgentProvider, providerName, namespace) : null
    if (!provider) {
      return {
        ok: false as const,
        reason: 'MissingProvider',
        message: `agent provider ${providerName ?? 'unknown'} not found`,
      }
    }

    let implResource = resolveImplementation(agentRun)
    if (!implResource) {
      const implRefName = asString(readNested(spec, ['implementationSpecRef', 'name']))
      if (implRefName) {
        const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, implRefName, namespace)
        implResource = asRecord(impl?.spec) ?? null
      }
    }
    if (!implResource) {
      return {
        ok: false as const,
        reason: 'MissingImplementation',
        message: 'implementationSpecRef or implementation.inline is required',
      }
    }

    const memory = resolveMemory(agentRun, agent, memories)
    const runMemoryRef = asString(readNested(spec, ['memoryRef', 'name']))
    const agentMemoryRef = asString(readNested(agent, ['spec', 'memoryRef', 'name']))
    if ((runMemoryRef || agentMemoryRef) && !memory) {
      const missingName = runMemoryRef || agentMemoryRef || 'unknown'
      return {
        ok: false as const,
        reason: 'MissingMemory',
        message: `memory ${missingName} not found`,
      }
    }

    const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
    const allowedSecrets = parseStringList(security.allowedSecrets)
    const allowedServiceAccounts = parseStringList(security.allowedServiceAccounts)
    const runSecrets = parseStringList(spec.secrets)
    const authSecret = resolveAuthSecretConfig()
    if (allowedSecrets.length > 0) {
      const forbidden = runSecrets.filter((secret) => !allowedSecrets.includes(secret))
      if (forbidden.length > 0) {
        return {
          ok: false as const,
          reason: 'SecretNotAllowed',
          message: `spec.secrets contains disallowed entries: ${forbidden.join(', ')}`,
        }
      }
    }

    const memorySecretName = asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name']))
    const blockedSecrets = collectBlockedSecrets([
      ...runSecrets,
      ...(memorySecretName ? [memorySecretName] : []),
      ...(authSecret ? [authSecret.name] : []),
    ])
    if (blockedSecrets.length > 0) {
      return {
        ok: false as const,
        reason: 'SecretBlocked',
        message: `secrets blocked by controller policy: ${blockedSecrets.join(', ')}`,
      }
    }

    const authSecretPolicy = validateAuthSecretPolicy(allowedSecrets, authSecret)
    if (!authSecretPolicy.ok) {
      return authSecretPolicy
    }
    if (memorySecretName) {
      if (allowedSecrets.length > 0 && !allowedSecrets.includes(memorySecretName)) {
        return {
          ok: false as const,
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not allowlisted by the Agent`,
        }
      }
      if (runSecrets.length > 0 && !runSecrets.includes(memorySecretName)) {
        return {
          ok: false as const,
          reason: 'SecretNotAllowed',
          message: `memory secret ${memorySecretName} is not included in spec.secrets`,
        }
      }
    }

    if (allowedServiceAccounts.length > 0) {
      const rawServiceAccount = deps.resolveRunnerServiceAccount(runtimeConfig)
      const effectiveServiceAccount = rawServiceAccount || 'default'
      if (!allowedServiceAccounts.includes(effectiveServiceAccount)) {
        return {
          ok: false as const,
          reason: 'ServiceAccountNotAllowed',
          message: `serviceAccount ${effectiveServiceAccount} is not allowlisted`,
        }
      }
    }

    return {
      ok: true as const,
      agent,
      provider,
      implementation: implResource,
      memory,
      allowedSecrets,
    }
  }

  const resolveWorkflowStepImplementation = async (
    kube: KubeClient,
    agentRun: Record<string, unknown>,
    namespace: string,
    step: WorkflowStepSpec,
    fallback: Record<string, unknown>,
  ) => {
    if (step.implementationInline) return step.implementationInline
    if (step.implementationSpecRefName) {
      const impl = await kube.get(RESOURCE_MAP.ImplementationSpec, step.implementationSpecRefName, namespace)
      return asRecord(impl?.spec) ?? null
    }
    const inline = resolveImplementation(agentRun)
    if (inline) return inline
    return fallback
  }

  const reconcileWorkflowRun = async (
    kube: KubeClient,
    agentRun: Record<string, unknown>,
    namespace: string,
    memories: Record<string, unknown>[],
    options: { initialSubmit?: boolean } = {},
  ) => {
    const metadata = asRecord(agentRun.metadata) ?? {}
    const runName = asString(metadata.name) ?? 'agentrun'
    const status = asRecord(agentRun.status) ?? {}
    const observedGeneration = asRecord(agentRun.metadata)?.generation ?? 0
    const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
    const workflowSteps = parseWorkflowSteps(agentRun)
    const baseWorkload = asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
    const workflowValidation = validateWorkflowSteps(workflowSteps)
    const conditions = deps.buildConditions(agentRun)

    if (!workflowValidation.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: workflowValidation.reason,
        message: workflowValidation.message,
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: deps.nowIso(),
        conditions: updated,
      })
      return
    }

    const imageCandidates = workflowSteps
      .map((step): ImagePolicyCandidate | null => {
        const workload = step.workload ?? baseWorkload
        const image = workload ? deps.resolveJobImage(workload) : null
        if (!image) return null
        return { image, context: `workflow step ${step.name}` }
      })
      .filter((candidate): candidate is ImagePolicyCandidate => candidate !== null)
    const imagePolicy = validateImagePolicy(imageCandidates)
    if (!imagePolicy.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: imagePolicy.reason,
        message: imagePolicy.message,
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: deps.nowIso(),
        conditions: updated,
      })
      return
    }

    const dependencies = await loadWorkflowDependencies(kube, agentRun, namespace, memories, runtimeConfig)
    if (!dependencies.ok) {
      const updated = upsertCondition(conditions, {
        type: 'InvalidSpec',
        status: 'True',
        reason: dependencies.reason,
        message: dependencies.message,
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: deps.nowIso(),
        conditions: updated,
      })
      return
    }

    let baseConditions = conditions
    let vcsStatus: Record<string, unknown> | undefined
    let workflowContractStatus: Record<string, unknown> | undefined

    const baseParameters = resolveParameters(agentRun)
    const allowedSecrets = dependencies.allowedSecrets
    const runSecrets = parseStringList(readNested(agentRun, ['spec', 'secrets']))
    const systemPromptResolution = await resolveSystemPrompt({
      kube,
      namespace,
      agentRun,
      agent: dependencies.agent,
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
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: deps.nowIso(),
        conditions: updated,
      })
      return
    }
    const systemPromptHashUpdate =
      asString(readNested(status, ['systemPromptHash'])) || !systemPromptResolution.systemPromptHash
        ? undefined
        : systemPromptResolution.systemPromptHash
    const workflowStatus = normalizeWorkflowStatus(asRecord(status.workflow) ?? null, workflowSteps)
    let runtimeRefUpdate: RuntimeRef | null = null
    let workflowFailure: { reason: string; message: string } | null = null
    let workflowRunning = false
    const now = Date.now()
    const completedJobs: Array<{ job: Record<string, unknown>; namespace: string }> = []

    for (let index = 0; index < workflowSteps.length; index += 1) {
      const stepSpec = workflowSteps[index]
      const stepStatus = workflowStatus.steps[index]
      if (stepStatus.phase === 'Succeeded') {
        continue
      }
      const maxAttempts = stepSpec.retries + 1

      if (stepStatus.phase === 'Failed') {
        workflowFailure = {
          reason: 'WorkflowStepFailed',
          message: `workflow step ${stepSpec.name} failed`,
        }
        break
      }

      if (stepStatus.phase === 'Retrying' && !shouldRetryStep(stepStatus, now)) {
        workflowRunning = true
        runtimeRefUpdate = buildRuntimeRef('workflow', asString(stepStatus.jobRef?.name) ?? '', namespace, {
          runName,
          stepName: stepSpec.name,
        })
        break
      }

      if (stepStatus.phase === 'Pending' || stepStatus.phase === 'Retrying') {
        const attempt = stepStatus.attempt + 1
        if (attempt > maxAttempts) {
          setWorkflowStepPhase(stepStatus, 'Failed', 'Retry limit exceeded')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: 'WorkflowStepRetriesExhausted',
            message: `workflow step ${stepSpec.name} exceeded retry limit`,
          }
          break
        }

        const implementation = await resolveWorkflowStepImplementation(
          kube,
          agentRun,
          namespace,
          stepSpec,
          dependencies.implementation,
        )
        if (!implementation) {
          setWorkflowStepPhase(stepStatus, 'Failed', 'Implementation not found')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: 'MissingImplementation',
            message: `workflow step ${stepSpec.name} implementation not found`,
          }
          break
        }

        const stepWorkload = stepSpec.workload ?? baseWorkload
        const workloadImage = deps.resolveJobImage(stepWorkload)
        if (!workloadImage) {
          setWorkflowStepPhase(stepStatus, 'Failed', 'Missing workload image')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: 'MissingWorkloadImage',
            message:
              'spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for workflow runtime',
          }
          break
        }

        const stepParameters = { ...baseParameters, ...stepSpec.parameters }
        const contractCheck = deps.validateImplementationContract(implementation, stepParameters)
        const contractStatus = deps.buildContractStatus(contractCheck)
        if (contractStatus) {
          workflowContractStatus = contractStatus
        }
        if (!contractCheck.ok) {
          setWorkflowStepPhase(stepStatus, 'Failed', contractCheck.message)
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: contractCheck.reason,
            message: `workflow step ${stepSpec.name} ${contractCheck.message}`,
          }
          break
        }

        const stepVcs = await resolveVcsContext({
          kube,
          namespace,
          agentRun,
          agent: dependencies.agent,
          implementation,
          parameters: stepParameters,
          allowedSecrets,
        })
        if (!stepVcs.ok) {
          setWorkflowStepPhase(stepStatus, 'Failed', stepVcs.message ?? 'vcs provider unavailable')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: stepVcs.reason ?? 'VcsUnavailable',
            message: `workflow step ${stepSpec.name} ${stepVcs.message ?? 'vcs provider unavailable'}`,
          }
          break
        }
        if (stepVcs.skip && stepVcs.reason) {
          baseConditions = upsertCondition(baseConditions, {
            type: 'VcsSkipped',
            status: 'True',
            reason: stepVcs.reason,
            message: stepVcs.message ?? '',
          })
        }
        if (stepVcs.status) {
          vcsStatus = stepVcs.status
        }
        const jobSuffix = `step-${index + 1}-attempt-${attempt}`
        const stepLabels = {
          'agents.proompteng.ai/step': deps.normalizeLabelValue(stepSpec.name),
          'agents.proompteng.ai/step-index': String(index + 1),
        }
        const stepRuntimeRef = await deps.submitJobRun(
          kube,
          agentRun,
          dependencies.agent,
          dependencies.provider,
          implementation,
          dependencies.memory,
          namespace,
          workloadImage,
          'workflow',
          {
            nameSuffix: jobSuffix,
            labels: stepLabels,
            workload: stepWorkload,
            parameters: stepParameters,
            runtimeConfig,
            vcs: stepVcs,
            systemPrompt: systemPromptResolution.systemPrompt,
            systemPromptRef: systemPromptResolution.systemPromptRef,
          },
        )

        stepStatus.attempt = attempt
        stepStatus.startedAt = deps.nowIso()
        stepStatus.finishedAt = undefined
        stepStatus.nextRetryAt = undefined
        stepStatus.jobRef = {
          name: asString(stepRuntimeRef.name) ?? '',
          namespace: asString(stepRuntimeRef.namespace) ?? namespace,
          uid: asString(stepRuntimeRef.uid) ?? undefined,
        }
        setWorkflowStepPhase(stepStatus, 'Running')
        runtimeRefUpdate = buildRuntimeRef('workflow', asString(stepRuntimeRef.name) ?? '', namespace, {
          uid: asString(stepRuntimeRef.uid) ?? undefined,
          runName,
          stepName: stepSpec.name,
        })
        workflowRunning = true
        break
      }

      if (stepStatus.phase === 'Running') {
        if (stepSpec.timeoutSeconds > 0) {
          const startedAt = stepStatus.startedAt
          const startTime = startedAt ? Date.parse(startedAt) : Number.NaN
          if (Number.isFinite(startTime) && now >= startTime + stepSpec.timeoutSeconds * 1000) {
            if (stepStatus.attempt < maxAttempts) {
              setWorkflowStepPhase(stepStatus, 'Retrying', 'Step timed out; retrying')
              stepStatus.finishedAt = deps.nowIso()
              stepStatus.nextRetryAt =
                stepSpec.retryBackoffSeconds > 0
                  ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
                  : deps.nowIso()
              workflowRunning = true
              break
            }
            setWorkflowStepPhase(stepStatus, 'Failed', 'Step timed out')
            stepStatus.finishedAt = deps.nowIso()
            workflowFailure = {
              reason: 'WorkflowStepTimedOut',
              message: `workflow step ${stepSpec.name} timed out`,
            }
            break
          }
        }
        const jobName = asString(stepStatus.jobRef?.name) ?? ''
        if (!jobName) {
          setWorkflowStepPhase(stepStatus, 'Failed', 'Job reference missing')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: 'WorkflowJobMissing',
            message: `workflow step ${stepSpec.name} is missing a job reference`,
          }
          break
        }
        const jobNamespace = asString(stepStatus.jobRef?.namespace) ?? namespace
        const job = await kube.get('job', jobName, jobNamespace)
        if (!job) {
          if (!stepStatus.jobObservedAt) {
            setWorkflowStepPhase(stepStatus, 'Running', 'Waiting for job to be created')
            runtimeRefUpdate = buildRuntimeRef('workflow', jobName, jobNamespace, {
              runName,
              stepName: stepSpec.name,
            })
            workflowRunning = true
            break
          }
          baseConditions = upsertCondition(baseConditions, {
            type: 'Warning',
            status: 'True',
            reason: 'WorkflowJobMissing',
            message: `workflow step ${stepSpec.name} job ${jobName} not found`,
          })
          if (stepStatus.attempt < maxAttempts) {
            setWorkflowStepPhase(stepStatus, 'Retrying', 'Job missing; retrying')
            stepStatus.finishedAt = deps.nowIso()
            stepStatus.nextRetryAt =
              stepSpec.retryBackoffSeconds > 0
                ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
                : deps.nowIso()
            workflowRunning = true
            break
          }
          setWorkflowStepPhase(stepStatus, 'Failed', 'Job missing')
          stepStatus.finishedAt = deps.nowIso()
          workflowFailure = {
            reason: 'WorkflowJobMissing',
            message: `workflow step ${stepSpec.name} job ${jobName} not found`,
          }
          break
        }
        const jobStatus = asRecord(job.status) ?? {}
        if (!stepStatus.jobObservedAt) {
          stepStatus.jobObservedAt = deps.nowIso()
        }
        const succeeded = Number(jobStatus.succeeded ?? 0)
        const failed = Number(jobStatus.failed ?? 0)
        if (succeeded > 0 || deps.isJobComplete(job)) {
          setWorkflowStepPhase(stepStatus, 'Succeeded')
          stepStatus.startedAt = asString(jobStatus.startTime) ?? stepStatus.startedAt ?? undefined
          stepStatus.finishedAt = asString(jobStatus.completionTime) ?? deps.nowIso()
          stepStatus.nextRetryAt = undefined
          completedJobs.push({ job, namespace: jobNamespace })
          continue
        }
        if (failed > 0 && deps.isJobFailed(job)) {
          if (stepStatus.attempt < maxAttempts) {
            setWorkflowStepPhase(stepStatus, 'Retrying', 'Step failed; retrying')
            stepStatus.finishedAt = deps.nowIso()
            stepStatus.nextRetryAt =
              stepSpec.retryBackoffSeconds > 0
                ? new Date(now + stepSpec.retryBackoffSeconds * 1000).toISOString()
                : deps.nowIso()
            completedJobs.push({ job, namespace: jobNamespace })
            workflowRunning = true
            break
          }
          setWorkflowStepPhase(stepStatus, 'Failed', 'Step failed')
          stepStatus.finishedAt = deps.nowIso()
          completedJobs.push({ job, namespace: jobNamespace })
          workflowFailure = {
            reason: 'WorkflowStepFailed',
            message: `workflow step ${stepSpec.name} failed`,
          }
          break
        }
        runtimeRefUpdate = buildRuntimeRef('workflow', jobName, jobNamespace, {
          uid: asString(readNested(job, ['metadata', 'uid'])) ?? undefined,
          runName,
          stepName: stepSpec.name,
        })
        workflowRunning = true
        break
      }
    }

    if (workflowFailure) {
      setWorkflowPhase(workflowStatus, 'Failed')
      const failureType =
        workflowFailure.reason === 'MissingRequiredMetadata' || workflowFailure.reason === 'InvalidContract'
          ? 'InvalidSpec'
          : 'Failed'
      const updated = upsertCondition(baseConditions, {
        type: failureType,
        status: 'True',
        reason: workflowFailure.reason,
        message: workflowFailure.message,
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Failed',
        finishedAt: deps.nowIso(),
        runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
        workflow: workflowStatus,
        conditions: updated,
        vcs: vcsStatus ?? undefined,
        contract: workflowContractStatus,
        ...(systemPromptHashUpdate ? { systemPromptHash: systemPromptHashUpdate } : {}),
      })
      for (const entry of completedJobs) {
        await deps.applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
      }
      return
    }

    const allSucceeded = workflowStatus.steps.every((step) => step.phase === 'Succeeded')
    if (allSucceeded) {
      setWorkflowPhase(workflowStatus, 'Succeeded')
      const updated = upsertCondition(baseConditions, {
        type: 'Succeeded',
        status: 'True',
        reason: 'Completed',
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Succeeded',
        finishedAt: deps.nowIso(),
        runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
        workflow: workflowStatus,
        conditions: updated,
        vcs: vcsStatus ?? undefined,
        ...(systemPromptHashUpdate ? { systemPromptHash: systemPromptHashUpdate } : {}),
      })
      for (const entry of completedJobs) {
        await deps.applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
      }
      return
    }

    if (workflowRunning) {
      setWorkflowPhase(workflowStatus, 'Running')
      let updated = baseConditions
      if (options.initialSubmit) {
        updated = upsertCondition(updated, { type: 'Accepted', status: 'True', reason: 'Submitted' })
      }
      updated = upsertCondition(updated, { type: 'InProgress', status: 'True', reason: 'Running' })
      await deps.setStatus(kube, agentRun, {
        observedGeneration,
        phase: 'Running',
        startedAt: asString(status.startedAt) ?? deps.nowIso(),
        runtimeRef: runtimeRefUpdate ?? parseRuntimeRef(status.runtimeRef) ?? undefined,
        workflow: workflowStatus,
        conditions: updated,
        vcs: vcsStatus ?? undefined,
        contract: workflowContractStatus,
        ...(options.initialSubmit ? { specHash: hashAgentRunImmutableSpec(agentRun) } : {}),
        ...(systemPromptHashUpdate ? { systemPromptHash: systemPromptHashUpdate } : {}),
      })
      for (const entry of completedJobs) {
        await deps.applyJobTtlAfterStatus(kube, entry.job, entry.namespace, runtimeConfig)
      }
    }
  }

  return {
    loadWorkflowDependencies,
    resolveWorkflowStepImplementation,
    reconcileWorkflowRun,
  }
}
