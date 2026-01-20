import { describe, expect, it, vi } from 'vitest'

import { startPrimitivesReconciler, stopPrimitivesReconciler } from '~/server/primitives-reconciler'

vi.mock('~/server/primitives-store', () => {
  return {
    createPrimitivesStore: () => ({
      ready: Promise.resolve(),
      close: vi.fn(async () => {}),
      createAgentRun: vi.fn(async (input) => ({ id: 'agent-run-1', ...input })),
      updateAgentRunDetails: vi.fn(async (input) => ({ id: input.id, ...input })),
      getAgentRunByDeliveryId: vi.fn(async () => null),
      getAgentRunByExternalRunId: vi.fn(async () => null),
      createOrchestrationRun: vi.fn(async (input) => ({ id: 'orchestration-run-1', ...input })),
      updateOrchestrationRunDetails: vi.fn(async (input) => ({ id: input.id, ...input })),
      getOrchestrationRunByDeliveryId: vi.fn(async () => null),
      getOrchestrationRunByExternalRunId: vi.fn(async () => null),
      upsertMemoryResource: vi.fn(async (input) => ({ id: 'memory-1', ...input })),
    }),
  }
})

vi.mock('~/server/primitives-kube', () => {
  return {
    RESOURCE_MAP: {
      Agent: 'agents.agents.proompteng.ai',
      AgentRun: 'agentruns.agents.proompteng.ai',
      AgentProvider: 'agentproviders.agents.proompteng.ai',
      ImplementationSpec: 'implementationspecs.agents.proompteng.ai',
      ImplementationSource: 'implementationsources.agents.proompteng.ai',
      Memory: 'memories.agents.proompteng.ai',
      Orchestration: 'orchestrations.orchestration.proompteng.ai',
      OrchestrationRun: 'orchestrationruns.orchestration.proompteng.ai',
      ApprovalPolicy: 'approvalpolicies.approvals.proompteng.ai',
      Budget: 'budgets.budgets.proompteng.ai',
      SecretBinding: 'secretbindings.security.proompteng.ai',
      SignalDelivery: 'signaldeliveries.signals.proompteng.ai',
    },
    createKubernetesClient: () => ({
      list: vi.fn(async () => ({ items: [] })),
      listEvents: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource) => resource),
      applyStatus: vi.fn(async (resource) => resource),
      patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
    }),
  }
})

vi.mock('~/server/primitives-memory', () => {
  return {
    hydrateMemoryRecord: vi.fn(async () => ({ id: 'memory-1' })),
  }
})

describe('primitives reconciler', () => {
  it('starts and stops without throwing', () => {
    expect(() => startPrimitivesReconciler()).not.toThrow()
    expect(() => stopPrimitivesReconciler()).not.toThrow()
  })
})
