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
      name: 'runtime-requirement-codex-abc123',
      namespace: 'agents',
      sourceSwarm: 'Platform Scheduler',
      targetSwarm: 'Codex Runtime',
      channel: 'agentrun.general.requirement',
      description: 'repair runtime evidence',
      priority: 'High Priority',
      payload: { runtime_gate: 'artifact_collection' },
      annotations: {
        'swarm.proompteng.ai/runtime-requirement-dispatch': 'requirement-1',
      },
    })

    expect(resource).toMatchObject({
      apiVersion: 'signals.proompteng.ai/v1alpha1',
      kind: 'Signal',
      metadata: {
        name: 'runtime-requirement-codex-abc123',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/type': 'requirement',
          'swarm.proompteng.ai/from': 'platform-scheduler',
          'swarm.proompteng.ai/to': 'codex-runtime',
          'swarm.proompteng.ai/requirement-channel': 'nats',
          priority: 'high-priority',
        },
        annotations: {
          'swarm.proompteng.ai/runtime-requirement-dispatch': 'requirement-1',
        },
      },
      spec: {
        channel: 'agentrun.general.requirement',
        description: 'repair runtime evidence',
        priority: 'High Priority',
        payload: { runtime_gate: 'artifact_collection' },
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
        name: 'runtime-requirement-codex-abc123',
        namespace: 'agents',
        sourceSwarm: 'platform-scheduler',
        targetSwarm: 'codex-runtime',
        channel: 'agentrun.general.requirement',
        description: 'repair runtime evidence',
        priority: 'high',
        payload: { runtime_gate: 'artifact_collection' },
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'signals-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://agents.test/v1/signals/resources')
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
        name: 'runtime-requirement-codex-abc123',
        namespace: 'agents',
      },
    })
  })
})
