import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __test__ } from '~/server/orchestration-controller'
import type { KubernetesClient } from '~/server/primitives-kube'

describe('orchestration controller', () => {
  beforeEach(() => {
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
})
