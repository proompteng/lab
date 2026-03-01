import { isCelError, run as runCel, type CelInput } from '@bufbuild/cel'
import { Effect } from 'effect'
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
  resolveWorkflowLoopStatusHistoryLimit,
  setWorkflowPhase,
  setWorkflowStepPhase,
  shouldRetryStep,
  validateWorkflowSteps,
  type WorkflowLoopSpec,
  type WorkflowLoopStatus,
  type WorkflowStepStatus,
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

const LOOP_CONTROL_ANNOTATION = 'agents.proompteng.ai/loop-control'

type LoopConditionEvaluationContext = {
  index: number
  maxIterations: number
  phase: 'Succeeded' | 'Failed' | 'Cancelled'
  control: Record<string, unknown>
}

const toCelInput = (value: unknown): CelInput => {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toCelInput(entry))
  }
  if (typeof value === 'object') {
    const output: Record<string, CelInput> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toCelInput(entry)
    }
    return output
  }
  return null
}

const buildLoopConditionBindings = (context: LoopConditionEvaluationContext) => ({
  iteration: {
    index: context.index,
    maxIterations: context.maxIterations,
    last: {
      phase: context.phase,
      control: toCelInput(context.control),
    },
  },
})

const evaluateLoopConditionExpression = (expression: string, context: LoopConditionEvaluationContext) => {
  return Effect.runSync(
    Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => runCel(expression, buildLoopConditionBindings(context)),
        catch: (error) =>
          new Error(
            `failed to evaluate loop condition expression: ${error instanceof Error ? error.message : String(error)}`,
          ),
      })
      if (isCelError(result)) {
        return yield* Effect.fail(new Error(result.message))
      }
      if (typeof result !== 'boolean') {
        return yield* Effect.fail(new Error(`loop condition expression must evaluate to bool, got ${typeof result}`))
      }
      return { ok: true as const, value: result }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  )
}

const ensureWorkflowLoopStatus = (stepStatus: WorkflowStepStatus, loopSpec: WorkflowLoopSpec): WorkflowLoopStatus => {
  const existing = stepStatus.loop
  if (existing) {
    existing.maxIterations = loopSpec.maxIterations
    if (existing.currentIteration < 1) {
      existing.currentIteration = Math.max(1, existing.completedIterations + 1)
    }
    if (!Array.isArray(existing.iterations)) {
      existing.iterations = []
    }
    existing.retainedIterations = existing.iterations.length
    return existing
  }
  const created: WorkflowLoopStatus = {
    currentIteration: 1,
    completedIterations: 0,
    maxIterations: loopSpec.maxIterations,
    retainedIterations: 0,
    prunedIterations: 0,
    iterations: [],
  }
  stepStatus.loop = created
  return created
}

const compactWorkflowLoopIterations = (loopStatus: WorkflowLoopStatus) => {
  const limit = resolveWorkflowLoopStatusHistoryLimit()
  if (loopStatus.iterations.length <= limit) {
    loopStatus.retainedIterations = loopStatus.iterations.length
    return
  }
  const removed = loopStatus.iterations.length - limit
  const dropped = loopStatus.iterations.slice(0, removed)
  const kept = loopStatus.iterations.slice(removed)
  const latestTerminalDropped = [...dropped]
    .reverse()
    .find((entry) => entry.phase === 'Failed' || entry.phase === 'Cancelled')
  if (latestTerminalDropped && !kept.some((entry) => entry.index === latestTerminalDropped.index)) {
    kept[0] = latestTerminalDropped
    kept.sort((a, b) => a.index - b.index)
  }
  loopStatus.prunedIterations += removed
  loopStatus.iterations = kept
  loopStatus.retainedIterations = kept.length
}

const upsertWorkflowLoopIteration = (
  loopStatus: WorkflowLoopStatus,
  iterationIndex: number,
  update: Partial<WorkflowLoopStatus['iterations'][number]>,
) => {
  const existing = loopStatus.iterations.find((item) => item.index === iterationIndex)
  if (existing) {
    Object.assign(existing, update)
  } else {
    loopStatus.iterations.push({
      index: iterationIndex,
      phase: update.phase ?? 'Pending',
      attempts: update.attempts ?? 0,
      startedAt: update.startedAt,
      finishedAt: update.finishedAt,
      message: update.message,
      jobRef: update.jobRef,
    })
  }
  loopStatus.iterations.sort((a, b) => a.index - b.index)
  compactWorkflowLoopIterations(loopStatus)
}

const parseLoopControlPayload = (job: Record<string, unknown>) => {
  const raw = asString(readNested(job, ['metadata', 'annotations', LOOP_CONTROL_ANNOTATION]))
  if (!raw) {
    return { kind: 'missing' as const }
  }
  return Effect.runSync(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (error) =>
          new Error(`invalid loop control annotation JSON: ${error instanceof Error ? error.message : String(error)}`),
      })
      const control = asRecord(parsed)
      if (!control) {
        return yield* Effect.fail(new Error('loop control annotation must be a JSON object'))
      }
      return { kind: 'ok' as const, control }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          kind: 'invalid' as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  )
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
    const workflowValidation = validateWorkflowSteps(workflowSteps, { baseWorkload })
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
      const loopSpec = stepSpec.loop
      const loopStatus = loopSpec ? ensureWorkflowLoopStatus(stepStatus, loopSpec) : null
      if (stepStatus.phase === 'Succeeded') {
        continue
      }
      const maxAttempts = stepSpec.retries + 1

      if (stepStatus.phase === 'Failed') {
        if (loopStatus && !loopStatus.stopReason) {
          loopStatus.stopReason = 'LoopIterationFailed'
        }
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
        const iterationIndex = loopStatus
          ? Math.max(1, loopStatus.currentIteration || loopStatus.completedIterations + 1)
          : 0
        if (loopStatus) {
          loopStatus.currentIteration = iterationIndex
        }
        if (attempt > maxAttempts) {
          setWorkflowStepPhase(stepStatus, 'Failed', 'Retry limit exceeded')
          stepStatus.finishedAt = deps.nowIso()
          if (loopStatus) {
            upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
              phase: 'Failed',
              attempts: stepStatus.attempt,
              finishedAt: stepStatus.finishedAt,
              message: 'Retry limit exceeded',
              jobRef: stepStatus.jobRef,
            })
            loopStatus.stopReason = 'LoopIterationFailed'
          }
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
        const jobSuffix = loopStatus
          ? `step-${index + 1}-iter-${iterationIndex}-attempt-${attempt}`
          : `step-${index + 1}-attempt-${attempt}`
        const stepLabels = {
          'agents.proompteng.ai/step': deps.normalizeLabelValue(stepSpec.name),
          'agents.proompteng.ai/step-index': String(index + 1),
          ...(loopStatus ? { 'agents.proompteng.ai/step-iteration': String(iterationIndex) } : {}),
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
            systemPromptHash: systemPromptResolution.systemPromptHash,
            systemPromptRef: systemPromptResolution.systemPromptRef,
          },
        )

        const startedAt = deps.nowIso()
        stepStatus.attempt = attempt
        stepStatus.startedAt = startedAt
        stepStatus.finishedAt = undefined
        stepStatus.nextRetryAt = undefined
        stepStatus.jobObservedAt = undefined
        stepStatus.jobRef = {
          name: asString(stepRuntimeRef.name) ?? '',
          namespace: asString(stepRuntimeRef.namespace) ?? namespace,
          uid: asString(stepRuntimeRef.uid) ?? undefined,
        }
        if (loopStatus) {
          loopStatus.stopReason = undefined
          upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
            phase: 'Running',
            attempts: attempt,
            startedAt,
            finishedAt: undefined,
            message: undefined,
            jobRef: stepStatus.jobRef,
          })
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
        const iterationIndex = loopStatus
          ? Math.max(1, loopStatus.currentIteration || loopStatus.completedIterations + 1)
          : 0
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
              if (loopStatus) {
                upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
                  phase: 'Running',
                  attempts: stepStatus.attempt,
                  startedAt: stepStatus.startedAt,
                  finishedAt: stepStatus.finishedAt,
                  message: 'Step timed out; retrying',
                  jobRef: stepStatus.jobRef,
                })
              }
              workflowRunning = true
              break
            }
            setWorkflowStepPhase(stepStatus, 'Failed', 'Step timed out')
            stepStatus.finishedAt = deps.nowIso()
            if (loopStatus) {
              upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
                phase: 'Failed',
                attempts: stepStatus.attempt,
                startedAt: stepStatus.startedAt,
                finishedAt: stepStatus.finishedAt,
                message: 'Step timed out',
                jobRef: stepStatus.jobRef,
              })
              loopStatus.stopReason = 'LoopIterationFailed'
            }
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
          if (loopStatus) {
            upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
              phase: 'Failed',
              attempts: stepStatus.attempt,
              startedAt: stepStatus.startedAt,
              finishedAt: stepStatus.finishedAt,
              message: 'Job reference missing',
              jobRef: stepStatus.jobRef,
            })
            loopStatus.stopReason = 'LoopIterationFailed'
          }
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
            if (loopStatus) {
              upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
                phase: 'Running',
                attempts: stepStatus.attempt,
                startedAt: stepStatus.startedAt,
                finishedAt: stepStatus.finishedAt,
                message: 'Job missing; retrying',
                jobRef: stepStatus.jobRef,
              })
            }
            workflowRunning = true
            break
          }
          setWorkflowStepPhase(stepStatus, 'Failed', 'Job missing')
          stepStatus.finishedAt = deps.nowIso()
          if (loopStatus) {
            upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
              phase: 'Failed',
              attempts: stepStatus.attempt,
              startedAt: stepStatus.startedAt,
              finishedAt: stepStatus.finishedAt,
              message: 'Job missing',
              jobRef: stepStatus.jobRef,
            })
            loopStatus.stopReason = 'LoopIterationFailed'
          }
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
          const startedAt = asString(jobStatus.startTime) ?? stepStatus.startedAt ?? undefined
          const finishedAt = asString(jobStatus.completionTime) ?? deps.nowIso()
          if (loopStatus && loopSpec) {
            loopStatus.currentIteration = iterationIndex
            loopStatus.completedIterations = Math.max(loopStatus.completedIterations, iterationIndex)

            let shouldContinue = false
            let stopReason = 'LoopConditionFalse'
            let conditionFailure: { reason: string; message: string } | null = null
            if (loopStatus.completedIterations >= loopStatus.maxIterations) {
              shouldContinue = false
              stopReason = 'LoopMaxIterationsReached'
            } else if (!loopSpec.condition) {
              shouldContinue = true
              stopReason = ''
            } else {
              const controlResult = parseLoopControlPayload(job)
              let control: Record<string, unknown> = {}
              if (controlResult.kind === 'missing') {
                if (loopSpec.condition.source.onMissing === 'fail') {
                  conditionFailure = {
                    reason: 'WorkflowLoopConditionError',
                    message: `workflow step ${stepSpec.name} loop control payload is missing`,
                  }
                } else {
                  shouldContinue = false
                  stopReason = 'LoopConditionFalse'
                  loopStatus.lastControl = undefined
                }
              } else if (controlResult.kind === 'invalid') {
                if (loopSpec.condition.source.onInvalid === 'fail') {
                  conditionFailure = {
                    reason: 'WorkflowLoopConditionError',
                    message: `workflow step ${stepSpec.name} ${controlResult.message}`,
                  }
                } else {
                  shouldContinue = false
                  stopReason = 'LoopConditionFalse'
                  loopStatus.lastControl = undefined
                }
              } else {
                control = controlResult.control
                loopStatus.lastControl = control
                const evaluated = evaluateLoopConditionExpression(loopSpec.condition.expression, {
                  index: loopStatus.completedIterations,
                  maxIterations: loopStatus.maxIterations,
                  phase: 'Succeeded',
                  control,
                })
                if (!evaluated.ok) {
                  conditionFailure = {
                    reason: 'WorkflowLoopConditionError',
                    message: `workflow step ${stepSpec.name}: ${evaluated.message}`,
                  }
                } else {
                  shouldContinue = evaluated.value
                  stopReason = shouldContinue ? '' : 'LoopConditionFalse'
                }
              }
            }

            if (conditionFailure) {
              setWorkflowStepPhase(stepStatus, 'Failed', conditionFailure.message)
              stepStatus.startedAt = startedAt
              stepStatus.finishedAt = finishedAt
              loopStatus.stopReason = 'LoopConditionError'
              upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
                phase: 'Failed',
                attempts: stepStatus.attempt,
                startedAt,
                finishedAt,
                message: conditionFailure.message,
                jobRef: stepStatus.jobRef,
              })
              completedJobs.push({ job, namespace: jobNamespace })
              workflowFailure = {
                reason: conditionFailure.reason,
                message: conditionFailure.message,
              }
              break
            }

            upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
              phase: 'Succeeded',
              attempts: stepStatus.attempt,
              startedAt,
              finishedAt,
              message: stopReason || undefined,
              jobRef: stepStatus.jobRef,
            })

            if (shouldContinue) {
              loopStatus.stopReason = undefined
              loopStatus.currentIteration = loopStatus.completedIterations + 1
              setWorkflowStepPhase(stepStatus, 'Pending', 'Loop continuing')
              stepStatus.attempt = 0
              stepStatus.startedAt = undefined
              stepStatus.finishedAt = undefined
              stepStatus.nextRetryAt = undefined
              stepStatus.jobObservedAt = undefined
              stepStatus.jobRef = undefined
              completedJobs.push({ job, namespace: jobNamespace })
              workflowRunning = true
              break
            }

            setWorkflowStepPhase(stepStatus, 'Succeeded')
            stepStatus.startedAt = startedAt
            stepStatus.finishedAt = finishedAt
            stepStatus.nextRetryAt = undefined
            loopStatus.stopReason = stopReason || 'LoopConditionFalse'
            completedJobs.push({ job, namespace: jobNamespace })
            continue
          }

          setWorkflowStepPhase(stepStatus, 'Succeeded')
          stepStatus.startedAt = startedAt
          stepStatus.finishedAt = finishedAt
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
            if (loopStatus) {
              upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
                phase: 'Running',
                attempts: stepStatus.attempt,
                startedAt: stepStatus.startedAt,
                finishedAt: stepStatus.finishedAt,
                message: 'Step failed; retrying',
                jobRef: stepStatus.jobRef,
              })
            }
            completedJobs.push({ job, namespace: jobNamespace })
            workflowRunning = true
            break
          }
          setWorkflowStepPhase(stepStatus, 'Failed', 'Step failed')
          stepStatus.finishedAt = deps.nowIso()
          if (loopStatus) {
            upsertWorkflowLoopIteration(loopStatus, iterationIndex, {
              phase: 'Failed',
              attempts: stepStatus.attempt,
              startedAt: stepStatus.startedAt,
              finishedAt: stepStatus.finishedAt,
              message: 'Step failed',
              jobRef: stepStatus.jobRef,
            })
            loopStatus.stopReason = 'LoopIterationFailed'
          }
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
