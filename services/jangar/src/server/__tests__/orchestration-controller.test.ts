import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/audit-client', () => ({
  emitAuditEventBestEffort: vi.fn(async () => {}),
}))

import { emitAuditEventBestEffort } from '~/server/audit-client'
import { __test__ } from '~/server/orchestration-controller'
import type { KubernetesClient } from '~/server/primitives-kube'

describe('orchestration controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets standard conditions and updatedAt for invalid orchestrations', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { applyStatus } as unknown as KubernetesClient

    const orchestration = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'Orchestration',
      metadata: { name: 'bad-orchestration', namespace: 'agents', generation: 1 },
      spec: { steps: [] },
    }

    await __test__.reconcileOrchestration(kube, orchestration)

    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}

    expect(status.updatedAt).toBe('2026-01-20T00:00:00.000Z')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    const progressing = conditions.find((condition) => condition.type === 'Progressing')
    const degraded = conditions.find((condition) => condition.type === 'Degraded')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
  })

  it('fans out steps when dependencies are satisfied', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const generateName = typeof metadata.generateName === 'string' ? metadata.generateName : ''
      const name = typeof metadata.name === 'string' ? metadata.name : generateName ? `${generateName}unit` : 'unit'
      return { ...resource, metadata: { ...metadata, name } }
    })
    const get = vi.fn(async (resource: string) => {
      if (resource === 'orchestrations.orchestration.proompteng.ai') {
        return {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'demo-orchestration', namespace: 'agents' },
          spec: {
            steps: [
              { name: 'checkpoint', kind: 'Checkpoint' },
              {
                name: 'run-agent',
                kind: 'AgentRun',
                dependsOn: ['checkpoint'],
                agentRef: { name: 'agent-a' },
                implementationSpecRef: { name: 'impl-a' },
              },
              { name: 'tool-step', kind: 'ToolRun', dependsOn: ['checkpoint'], toolRef: { name: 'tool-a' } },
            ],
          },
        }
      }
      return null
    })
    const kube = { applyStatus, apply, get } as unknown as KubernetesClient

    const orchestrationRun = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'demo-run', namespace: 'agents', generation: 1 },
      spec: { orchestrationRef: { name: 'demo-orchestration' } },
    }

    await __test__.reconcileOrchestrationRun(kube, orchestrationRun, 'agents')

    expect(apply).toHaveBeenCalledTimes(2)
    expect(emitAuditEventBestEffort).toHaveBeenCalledTimes(2)
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}
    const stepStatuses = Array.isArray(status.stepStatuses) ? status.stepStatuses : []
    const checkpoint = stepStatuses.find((step) => step.name === 'checkpoint')
    const agent = stepStatuses.find((step) => step.name === 'run-agent')
    const tool = stepStatuses.find((step) => step.name === 'tool-step')

    expect(checkpoint?.phase).toBe('Succeeded')
    expect(agent?.phase).toBe('Running')
    expect(tool?.phase).toBe('Running')
  })

  it('defaults workflow steps for workflow AgentRun steps', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const generateName = typeof metadata.generateName === 'string' ? metadata.generateName : ''
      const name = typeof metadata.name === 'string' ? metadata.name : generateName ? `${generateName}unit` : 'unit'
      return { ...resource, metadata: { ...metadata, name } }
    })
    const get = vi.fn(async (resource: string) => {
      if (resource === 'orchestrations.orchestration.proompteng.ai') {
        return {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'workflow-orchestration', namespace: 'agents' },
          spec: {
            steps: [
              {
                name: 'run-agent',
                kind: 'AgentRun',
                agentRef: { name: 'agent-a' },
                implementationSpecRef: { name: 'impl-a' },
                runtime: { type: 'workflow' },
              },
            ],
          },
        }
      }
      return null
    })
    const kube = { applyStatus, apply, get } as unknown as KubernetesClient

    const orchestrationRun = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'workflow-run', namespace: 'agents', generation: 1 },
      spec: { orchestrationRef: { name: 'workflow-orchestration' } },
    }

    await __test__.reconcileOrchestrationRun(kube, orchestrationRun, 'agents')

    expect(apply).toHaveBeenCalledTimes(1)
    const submitted = apply.mock.calls[0]?.[0] as { spec?: Record<string, unknown> }
    const spec = submitted.spec ?? {}
    expect((spec.runtime as Record<string, unknown> | undefined)?.type).toBe('workflow')
    expect((spec.workflow as Record<string, unknown> | undefined)?.steps).toEqual([{ name: 'main' }])
  })

  it('sets retry metadata when a step fails with retries remaining', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string, name: string) => {
      if (resource === 'orchestrations.orchestration.proompteng.ai') {
        return {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'retry-orchestration', namespace: 'agents' },
          spec: {
            steps: [
              {
                name: 'run-agent',
                kind: 'AgentRun',
                retries: 1,
                retryBackoffSeconds: 30,
                agentRef: { name: 'agent-a' },
                implementationSpecRef: { name: 'impl-a' },
              },
            ],
          },
        }
      }
      if (resource === 'agentruns.agents.proompteng.ai' && name === 'agent-run-1') {
        return {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: { name: 'agent-run-1', namespace: 'agents' },
          status: { phase: 'Failed', finishedAt: '2026-01-20T00:00:10.000Z' },
        }
      }
      return null
    })
    const kube = { applyStatus, apply, get } as unknown as KubernetesClient

    const orchestrationRun = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'retry-run', namespace: 'agents', generation: 1 },
      spec: { orchestrationRef: { name: 'retry-orchestration' } },
      status: {
        phase: 'Running',
        stepStatuses: [
          {
            name: 'run-agent',
            kind: 'AgentRun',
            phase: 'Running',
            attempt: 1,
            resourceRef: { name: 'agent-run-1', namespace: 'agents' },
          },
        ],
      },
    }

    await __test__.reconcileOrchestrationRun(kube, orchestrationRun, 'agents')

    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}
    const stepStatuses = Array.isArray(status.stepStatuses) ? status.stepStatuses : []
    const step = stepStatuses.find((entry) => entry.name === 'run-agent')
    expect(step?.phase).toBe('Retrying')
    expect(step?.nextRetryAt).toBe('2026-01-20T00:00:30.000Z')
  })

  it('fails running steps when timeout is exceeded', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === 'orchestrations.orchestration.proompteng.ai') {
        return {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'timeout-orchestration', namespace: 'agents' },
          spec: {
            steps: [
              {
                name: 'run-agent',
                kind: 'AgentRun',
                timeoutSeconds: 30,
                agentRef: { name: 'agent-a' },
                implementationSpecRef: { name: 'impl-a' },
              },
            ],
          },
        }
      }
      return null
    })
    const kube = { applyStatus, apply, get } as unknown as KubernetesClient

    const orchestrationRun = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'timeout-run', namespace: 'agents', generation: 1 },
      spec: { orchestrationRef: { name: 'timeout-orchestration' } },
      status: {
        phase: 'Running',
        stepStatuses: [
          {
            name: 'run-agent',
            kind: 'AgentRun',
            phase: 'Running',
            attempt: 1,
            startedAt: '2026-01-19T23:58:00.000Z',
            resourceRef: { name: 'agent-run-1', namespace: 'agents' },
          },
        ],
      },
    }

    await __test__.reconcileOrchestrationRun(kube, orchestrationRun, 'agents')

    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}
    const stepStatuses = Array.isArray(status.stepStatuses) ? status.stepStatuses : []
    const step = stepStatuses.find((entry) => entry.name === 'run-agent')
    expect(step?.phase).toBe('Failed')
    expect(step?.message).toBe('Step timed out')
    expect(status.phase).toBe('Failed')
  })

  it('emits an event when a step fails without retries', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string, name: string) => {
      if (resource === 'orchestrations.orchestration.proompteng.ai') {
        return {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'fail-orchestration', namespace: 'agents' },
          spec: {
            steps: [
              {
                name: 'tool-step',
                kind: 'ToolRun',
                toolRef: { name: 'tool-a' },
              },
            ],
          },
        }
      }
      if (resource === 'toolruns.tools.proompteng.ai' && name === 'tool-run-1') {
        return {
          apiVersion: 'tools.proompteng.ai/v1alpha1',
          kind: 'ToolRun',
          metadata: { name: 'tool-run-1', namespace: 'agents' },
          status: { phase: 'Failed', finishedAt: '2026-01-20T00:00:05.000Z' },
        }
      }
      return null
    })
    const kube = { applyStatus, apply, get } as unknown as KubernetesClient

    const orchestrationRun = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'fail-run', namespace: 'agents', generation: 1 },
      spec: { orchestrationRef: { name: 'fail-orchestration' } },
      status: {
        phase: 'Running',
        stepStatuses: [
          {
            name: 'tool-step',
            kind: 'ToolRun',
            phase: 'Running',
            attempt: 1,
            resourceRef: { name: 'tool-run-1', namespace: 'agents' },
          },
        ],
      },
    }

    await __test__.reconcileOrchestrationRun(kube, orchestrationRun, 'agents')

    const eventCall = apply.mock.calls.find((call) => (call[0] as Record<string, unknown>).kind === 'Event')
    expect(eventCall).toBeTruthy()
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const failed = conditions.find((condition) => condition.type === 'Failed')
    expect(failed?.status).toBe('True')
  })
})
