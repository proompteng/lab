import { temporalCallOptions } from '@proompteng/temporal-bun-sdk'

import { asRecord, asString, readNested } from '~/server/primitives-http'
import { type Condition, upsertCondition } from './conditions'
import { parseOptionalNumber } from './env-config'
import { buildRuntimeRef, type RuntimeRef } from './runtime-resources'

type TemporalClient = {
  workflow: {
    start: (...args: unknown[]) => Promise<{ workflowId: string; namespace: string; runId: string }>
    result: (...args: unknown[]) => Promise<unknown>
  }
}

type TemporalRuntimeDependencies = {
  getTemporalClient: () => Promise<unknown>
  resolveParameters: (agentRun: Record<string, unknown>) => Record<string, string>
  buildRunSpec: (
    agentRun: Record<string, unknown>,
    agent: Record<string, unknown> | null,
    implementation: Record<string, unknown>,
    parameters: Record<string, string>,
    memory: Record<string, unknown> | null,
    artifacts?: Array<Record<string, unknown>>,
    providerName?: string,
    vcs?: Record<string, unknown> | null,
    systemPrompt?: string | null,
  ) => Record<string, unknown>
  makeName: (base: string, suffix: string) => string
  buildConditions: (resource: Record<string, unknown>) => Condition[]
  nowIso: () => string
  setStatus: (kube: unknown, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>
}

const isTemporalPollPending = (error: unknown) => {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    const message = error.message.toLowerCase()
    if (message.includes('deadline') || message.includes('timeout')) return true
  }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number' && code === 4) return true
  if (typeof code === 'string' && code.toLowerCase().includes('deadline')) return true
  return false
}

const classifyTemporalResult = (error: unknown) => {
  if (isTemporalPollPending(error)) {
    return { kind: 'pending' as const }
  }
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('workflow canceled')) {
    return { kind: 'cancelled' as const, reason: 'Cancelled', message }
  }
  if (lower.includes('workflow terminated')) {
    return { kind: 'failed' as const, reason: 'Terminated', message }
  }
  if (lower.includes('workflow timed out')) {
    return { kind: 'failed' as const, reason: 'TimedOut', message }
  }
  if (lower.includes('workflow failed')) {
    return { kind: 'failed' as const, reason: 'Failed', message }
  }
  if (lower.includes('connect') || lower.includes('unavailable') || lower.includes('handshake')) {
    return { kind: 'pending' as const }
  }
  return { kind: 'failed' as const, reason: 'TemporalError', message }
}

export const createTemporalRuntimeTools = (deps: TemporalRuntimeDependencies) => {
  const submitCustomRun = async (
    agentRun: Record<string, unknown>,
    implementation: Record<string, unknown>,
    memory: Record<string, unknown> | null,
  ) => {
    const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
    const endpoint = asString(runtimeConfig.endpoint)
    if (!endpoint) {
      throw new Error('spec.runtime.config.endpoint is required for custom runtime')
    }
    const payload = runtimeConfig.payload ?? {
      agentRun,
      implementation,
      memory,
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(`custom runtime POST failed: ${response.status} ${response.statusText}`)
    }
    let data: Record<string, unknown> | null = null
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      data = null
    }
    return buildRuntimeRef('custom', endpoint, 'external', { response: data ?? {} })
  }

  const submitTemporalRun = async (
    agentRun: Record<string, unknown>,
    agent: Record<string, unknown>,
    provider: Record<string, unknown>,
    implementation: Record<string, unknown>,
    memory: Record<string, unknown> | null,
    vcs?: Record<string, unknown> | null,
    parametersOverride?: Record<string, string>,
    systemPrompt?: string | null,
  ) => {
    const runtimeConfig = asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
    const workflowType = asString(runtimeConfig.workflowType)
    const taskQueue = asString(runtimeConfig.taskQueue)
    if (!workflowType) {
      throw new Error('spec.runtime.config.workflowType is required for temporal runtime')
    }
    if (!taskQueue) {
      throw new Error('spec.runtime.config.taskQueue is required for temporal runtime')
    }

    const namespace = asString(runtimeConfig.namespace) ?? undefined
    const workflowId =
      asString(runtimeConfig.workflowId) ??
      asString(readNested(agentRun, ['spec', 'idempotencyKey'])) ??
      deps.makeName(asString(readNested(agentRun, ['metadata', 'name'])) ?? 'agentrun', 'temporal')

    const timeouts = asRecord(runtimeConfig.timeouts) ?? {}

    const parameters = parametersOverride ?? deps.resolveParameters(agentRun)
    const providerSpec = asRecord(provider.spec) ?? {}
    const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''
    const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
    const payload = deps.buildRunSpec(
      agentRun,
      agent,
      implementation,
      parameters,
      memory,
      outputArtifacts,
      providerName,
      vcs,
      systemPrompt ?? null,
    )

    const client = (await deps.getTemporalClient()) as TemporalClient
    const result = await client.workflow.start({
      workflowId,
      workflowType,
      taskQueue,
      namespace,
      args: [payload],
      workflowExecutionTimeoutMs: parseOptionalNumber(timeouts.workflowExecutionTimeoutMs),
      workflowRunTimeoutMs: parseOptionalNumber(timeouts.workflowRunTimeoutMs),
      workflowTaskTimeoutMs: parseOptionalNumber(timeouts.workflowTaskTimeoutMs),
    })

    return buildRuntimeRef('temporal', result.workflowId, result.namespace, {
      workflowId: result.workflowId,
      runId: result.runId,
      taskQueue,
    })
  }

  const reconcileTemporalRun = async (kube: unknown, agentRun: Record<string, unknown>, runtimeRef: RuntimeRef) => {
    const workflowId = asString(runtimeRef.workflowId) ?? asString(runtimeRef.name)
    if (!workflowId) return
    const client = (await deps.getTemporalClient()) as TemporalClient
    const handle = {
      workflowId,
      runId: asString(runtimeRef.runId) ?? undefined,
      namespace: asString(runtimeRef.namespace) ?? undefined,
    }
    try {
      await client.workflow.result(handle, temporalCallOptions({ timeoutMs: 500 }))
      const conditions = deps.buildConditions(agentRun)
      const updated = upsertCondition(conditions, { type: 'Succeeded', status: 'True', reason: 'Completed' })
      await deps.setStatus(kube, agentRun, {
        observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
        phase: 'Succeeded',
        finishedAt: deps.nowIso(),
        runtimeRef,
        conditions: updated,
        vcs: asRecord(agentRun.status)?.vcs ?? undefined,
      })
    } catch (error) {
      const outcome = classifyTemporalResult(error)
      if (outcome.kind === 'pending') {
        return
      }
      const conditions = deps.buildConditions(agentRun)
      const updated = upsertCondition(conditions, {
        type: 'Failed',
        status: 'True',
        reason: outcome.reason,
        message: outcome.message,
      })
      await deps.setStatus(kube, agentRun, {
        observedGeneration: asRecord(agentRun.metadata)?.generation ?? 0,
        phase: outcome.kind === 'cancelled' ? 'Cancelled' : 'Failed',
        finishedAt: deps.nowIso(),
        runtimeRef,
        conditions: updated,
        vcs: asRecord(agentRun.status)?.vcs ?? undefined,
      })
    }
  }

  return {
    submitCustomRun,
    submitTemporalRun,
    reconcileTemporalRun,
  }
}
