import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP } from '../../../server/kube-types'
import { buildExecutionTrustResponse } from './execution-trust'

const createKube = (items: Record<string, unknown>[]) => ({
  list: vi.fn(async () => ({ items })),
})

describe('control-plane execution trust route', () => {
  it('evaluates tracked Swarms from the Agents-owned Kubernetes client', async () => {
    const kube = createKube([
      {
        metadata: { name: 'platform-control-plane', namespace: 'agents', generation: 3 },
        status: {
          phase: 'Active',
          observedGeneration: 3,
          requirements: { pending: 0 },
          lastDiscoverAt: '2026-05-20T12:00:00Z',
          lastPlanAt: '2026-05-20T12:00:00Z',
          lastImplementAt: '2026-05-20T12:00:00Z',
          lastVerifyAt: '2026-05-20T12:00:00Z',
          stageStates: {
            discover: { phase: 'Active', healthy: true, cadence: '1m', lastRunTime: '2026-05-20T12:00:00Z' },
            plan: { phase: 'Active', healthy: true, cadence: '1m', lastRunTime: '2026-05-20T12:00:00Z' },
            implement: { phase: 'Active', healthy: true, cadence: '1m', lastRunTime: '2026-05-20T12:00:00Z' },
            verify: { phase: 'Active', healthy: true, cadence: '1m', lastRunTime: '2026-05-20T12:00:00Z' },
          },
        },
      },
    ])

    const response = await buildExecutionTrustResponse(
      new Request('http://agents.test/v1/control-plane/execution-trust?namespace=agents&swarms=platform-control-plane'),
      {
        kubeClient: kube as never,
        now: () => new Date('2026-05-20T12:00:30Z'),
      },
    )

    expect(response.status).toBe(200)
    expect(kube.list).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'agents')
    const payload = await response.json()
    expect(payload).toMatchObject({
      executionTrust: { status: 'healthy' },
      swarms: [expect.objectContaining({ name: 'platform-control-plane', ready: true })],
    })
  })

  it('uses AGENTS_CONTROL_PLANE_EXECUTION_TRUST_SWARMS when the query omits tracked Swarms', async () => {
    const kube = createKube([])

    const response = await buildExecutionTrustResponse(
      new Request('http://agents.test/v1/control-plane/execution-trust?namespace=agents'),
      {
        kubeClient: kube as never,
        now: () => new Date('2026-05-20T12:00:30Z'),
        env: { AGENTS_CONTROL_PLANE_EXECUTION_TRUST_SWARMS: 'platform-control-plane' },
      },
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.executionTrust).toMatchObject({ status: 'blocked' })
    expect(payload.executionTrust.reason).toContain('tracked swarm not found')
  })
})
