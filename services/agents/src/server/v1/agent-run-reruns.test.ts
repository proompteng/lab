import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import type { AgentRunRecord, AgentRunRerunSubmissionRecord } from '../primitives-store'

import { postAgentRunRerunsHandler, type AgentRunRerunsApiDependencies } from './agent-run-reruns'

const parentRun: AgentRunRecord = {
  id: 'agent-run-record-1',
  agentName: 'codex',
  deliveryId: 'agent-run-delivery-1',
  provider: 'job',
  status: 'Succeeded',
  externalRunId: 'agent-run-1',
  payload: {
    request: {
      parameters: {
        repository: 'proompteng/lab',
        issueNumber: '7152',
        base: 'main',
        head: 'codex/agents-split',
      },
    },
    resource: {
      metadata: {
        name: 'agent-run-1',
        namespace: 'agents',
        uid: 'agent-run-uid-1',
      },
    },
  },
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
}

const submission: AgentRunRerunSubmissionRecord = {
  id: 'rerun-submission-1',
  parentRef: 'agent_runs:agent-run-record-1',
  parentAgentRunId: 'agent-run-record-1',
  parentAgentRunName: 'agent-run-1',
  parentAgentRunNamespace: 'agents',
  attempt: 2,
  deliveryId: 'rerun-delivery-1',
  status: 'queued',
  submissionAttempt: 0,
  responseStatus: null,
  error: null,
  requestPayload: {},
  responsePayload: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
  submittedAt: null,
}

const createStore = (overrides: Record<string, unknown> = {}) =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => []),
    getAgentRunById: vi.fn(async (id: string) => (id === parentRun.id ? parentRun : null)),
    getAgentRunByExternalRunId: vi.fn(async (externalRunId: string) =>
      externalRunId === parentRun.externalRunId ? parentRun : null,
    ),
    getAgentRunByDeliveryId: vi.fn(async () => null),
    getAgentRunIdempotencyKey: vi.fn(async () => null),
    reserveAgentRunIdempotencyKey: vi.fn(async () => ({ record: {}, created: true })),
    deleteAgentRunIdempotencyKey: vi.fn(async () => true),
    assignAgentRunIdempotencyKey: vi.fn(async () => null),
    createAgentRun: vi.fn(async (input) => ({ id: 'unused-agent-run', ...input })),
    updateAgentRunDetails: vi.fn(async (input) => ({ ...parentRun, status: input.status, payload: input.payload })),
    enqueueAgentRunRerunSubmission: vi.fn(async () => ({ submission, created: true })),
    claimAgentRunRerunSubmission: vi.fn(async () => ({
      submission: { ...submission, status: 'pending' },
      shouldSubmit: true,
    })),
    updateAgentRunRerunSubmission: vi.fn(async (input) => ({ ...submission, ...input })),
    getOrchestrationRunByDeliveryId: vi.fn(async () => null),
    createOrchestrationRun: vi.fn(async (input) => ({
      id: 'orchestration-record-1',
      orchestrationName: input.orchestrationName,
      deliveryId: input.deliveryId,
      provider: input.provider,
      status: input.status,
      externalRunId: input.externalRunId,
      payload: input.payload,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    })),
    createAuditEvent: vi.fn(async () => ({})),
    ...overrides,
  }) as unknown as AgentRunRerunsApiDependencies['storeFactory'] extends () => infer Store ? Store : never

const createKube = (): KubernetesClient =>
  ({
    apply: vi.fn(async (resource) => ({
      ...resource,
      metadata: {
        ...((resource.metadata ?? {}) as Record<string, unknown>),
        name: 'codex-rerun-run-1',
        namespace: 'agents',
        uid: 'orchestration-run-uid-1',
      },
      status: { phase: 'Running' },
    })),
    applyManifest: vi.fn(async () => ({})),
    applyStatus: vi.fn(async (resource) => resource),
    createManifest: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
    get: vi.fn(async (resource, name, namespace) => {
      if (resource === RESOURCE_MAP.Orchestration && name === 'codex-rerun' && namespace === 'agents') {
        return { metadata: { name, namespace }, spec: { steps: [] } }
      }
      return null
    }),
    list: vi.fn(async () => ({ items: [] })),
    logs: vi.fn(async () => ''),
    listEvents: vi.fn(async () => ({ items: [] })),
  }) satisfies KubernetesClient

const request = (payload: Record<string, unknown>) =>
  new Request('http://agents.local/v1/agent-runs/agent-run-record-1/reruns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'rerun-delivery-1' },
    body: JSON.stringify(payload),
  })

describe('AgentRun reruns v1 API', () => {
  it('owns rerun queueing and submits the configured Agents orchestration', async () => {
    const store = createStore()
    const kube = createKube()

    const response = await postAgentRunRerunsHandler(
      'agent-run-record-1',
      request({ attempt: 2, prompt: 'Try again.', deliveryId: 'rerun-delivery-1' }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: {
          env: {
            AGENTS_CODEX_RERUN_ORCHESTRATION: 'codex-rerun',
            AGENTS_CODEX_RERUN_ORCHESTRATION_NAMESPACE: 'agents',
          },
        },
      },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(store.enqueueAgentRunRerunSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRef: 'agent_runs:agent-run-record-1',
        attempt: 2,
        deliveryId: 'rerun-delivery-1',
      }),
    )
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OrchestrationRun',
        spec: expect.objectContaining({
          orchestrationRef: { name: 'codex-rerun' },
          deliveryId: 'rerun-delivery-1',
          parameters: expect.objectContaining({
            repository: 'proompteng/lab',
            issueNumber: '7152',
            codexPrompt: 'Try again.',
            stage: 'implementation',
            parentRunUid: 'agent-run-uid-1',
          }),
        }),
      }),
    )
    expect(store.updateAgentRunRerunSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rerun-submission-1', status: 'submitted', responseStatus: 201 }),
    )
    expect(store.updateAgentRunDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-run-record-1',
        status: 'needs_iteration',
        payload: expect.objectContaining({
          rerun: expect.objectContaining({ attempt: 2, deliveryId: 'rerun-delivery-1', status: 'pending' }),
        }),
      }),
    )
  })

  it('returns the existing submission without re-submitting when the rerun is already claimed', async () => {
    const store = createStore({
      claimAgentRunRerunSubmission: vi.fn(async () => ({
        submission: { ...submission, status: 'submitted' },
        shouldSubmit: false,
      })),
    })
    const kube = createKube()

    const response = await postAgentRunRerunsHandler(
      'agent-run-1',
      request({ agentRunName: 'agent-run-1', attempt: 2, prompt: 'Try again.', deliveryId: 'rerun-delivery-1' }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: {
          env: {
            AGENTS_CODEX_RERUN_ORCHESTRATION: 'codex-rerun',
          },
        },
      },
    )

    expect(response.status).toBe(200)
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.updateAgentRunDetails).not.toHaveBeenCalled()
  })
})
