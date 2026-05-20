import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildSwarmRequirementSignalResource, submitSwarmRequirementSignalToAgentsService } from './signals-client'

describe('signals-client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('builds a Signal resource from the typed swarm requirement contract', () => {
    const resource = buildSwarmRequirementSignalResource({
      deliveryId: 'requirement-1',
      name: 'material-reentry-torghut-abc123',
      namespace: 'agents',
      sourceSwarm: 'Jangar Control Plane',
      targetSwarm: 'Torghut Quant',
      channel: 'agentrun.general.requirement',
      description: 'repair executable alpha evidence',
      priority: 'High Priority',
      payload: { value_gate: 'routeable_candidate_count' },
      annotations: {
        'swarm.proompteng.ai/material-reentry-dispatch': 'requirement-1',
      },
    })

    expect(resource).toMatchObject({
      apiVersion: 'signals.proompteng.ai/v1alpha1',
      kind: 'Signal',
      metadata: {
        name: 'material-reentry-torghut-abc123',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/type': 'requirement',
          'swarm.proompteng.ai/from': 'jangar-control-plane',
          'swarm.proompteng.ai/to': 'torghut-quant',
          'swarm.proompteng.ai/requirement-channel': 'nats',
          priority: 'high-priority',
        },
        annotations: {
          'swarm.proompteng.ai/material-reentry-dispatch': 'requirement-1',
        },
      },
      spec: {
        channel: 'agentrun.general.requirement',
        description: 'repair executable alpha evidence',
        priority: 'High Priority',
        payload: { value_gate: 'routeable_candidate_count' },
      },
    })
  })

  it('submits the generated Signal resource through the Agents service resource endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, resource: { kind: 'Signal' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await submitSwarmRequirementSignalToAgentsService(
      {
        deliveryId: 'requirement-1',
        name: 'material-reentry-torghut-abc123',
        namespace: 'agents',
        sourceSwarm: 'jangar-control-plane',
        targetSwarm: 'torghut-quant',
        channel: 'agentrun.general.requirement',
        description: 'repair executable alpha evidence',
        priority: 'high',
        payload: { value_gate: 'routeable_candidate_count' },
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'signals-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://agents.test/api/agents/control-plane/resource')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'requirement-1',
        'x-agents-client': 'signals-test',
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      apiVersion: 'signals.proompteng.ai/v1alpha1',
      kind: 'Signal',
      metadata: {
        name: 'material-reentry-torghut-abc123',
        namespace: 'agents',
      },
    })
  })
})
