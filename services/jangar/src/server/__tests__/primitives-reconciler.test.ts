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
      AgentRun: 'agent-runs',
      OrchestrationRun: 'orchestration-runs',
      Memory: 'memories',
    },
    createKubernetesClient: () => ({
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => null),
      apply: vi.fn(async (resource) => resource),
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
