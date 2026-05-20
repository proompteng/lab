import { describe, expect, it, vi } from 'vitest'

import {
  buildTorghutMarketContextAgentRunPayload,
  resolveSubmittedTorghutMarketContextAgentRunName,
  submitTorghutMarketContextAgentRun,
  type TorghutMarketContextAgentRunSettings,
} from '~/server/torghut-market-context-agentrun'

const settings: TorghutMarketContextAgentRunSettings = {
  onDemandDispatchNamespace: 'agents',
  onDemandDispatchServiceAccountName: 'agents-sa',
  onDemandDispatchPriorityClassName: 'torghut-market-context-low',
  onDemandDispatchCallbackUrl: 'http://jangar/api/torghut/market-context',
  onDemandDispatchTtlSeconds: 7200,
  onDemandDispatchRepository: 'proompteng/lab',
  onDemandDispatchBaseBranch: 'main',
  onDemandDispatchHeadBranch: 'codex/market-context',
  onDemandDispatchVcsRefName: 'lab-main',
}

describe('torghut-market-context-agentrun', () => {
  it('builds on-demand market-context AgentRun API payloads as repository-bound batch tasks', () => {
    const payload = buildTorghutMarketContextAgentRunPayload({
      symbol: 'NVDA',
      domain: 'news',
      snapshotState: 'missing',
      provider: 'news-provider',
      requestId: 'market-context-news-nvda-request',
      now: new Date('2026-05-20T12:00:00.000Z'),
      settings,
    })

    expect(payload).toMatchObject({
      namespace: 'agents',
      metadata: {
        generateName: 'torghut-market-context-news-nvda-',
        labels: {
          'torghut.proompteng.ai/purpose': 'market-context-on-demand',
          'torghut.proompteng.ai/domain': 'news',
          'torghut.proompteng.ai/symbol': 'nvda',
        },
      },
      agentRef: { name: 'torghut-news-agent' },
      implementationSpecRef: { name: 'torghut-market-context-news-v1' },
      runtime: {
        type: 'job',
        config: {
          serviceAccountName: 'agents-sa',
          priorityClassName: 'torghut-market-context-low',
        },
      },
      ttlSecondsAfterFinished: 7200,
      vcsRef: { name: 'lab-main' },
      vcsPolicy: {
        required: true,
        mode: 'read-only',
      },
      parameters: {
        executionMode: 'batch_task',
        symbol: 'NVDA',
        domain: 'news',
        asOfUtc: '2026-05-20T12:00:00.000Z',
        reason: 'on_demand_missing_snapshot_refresh',
        provider: 'news-provider',
        callbackUrl: 'http://jangar/api/torghut/market-context',
        requestId: 'market-context-news-nvda-request',
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/market-context',
      },
    })
  })

  it('uses the fundamentals references for fundamentals refresh AgentRuns', () => {
    const payload = buildTorghutMarketContextAgentRunPayload({
      symbol: 'BRK.B',
      domain: 'fundamentals',
      snapshotState: 'stale',
      provider: 'fundamentals-provider',
      requestId: 'market-context-fundamentals-brkb-request',
      now: new Date('2026-05-20T12:00:00.000Z'),
      settings,
    })

    expect(payload.metadata.generateName).toBe('torghut-market-context-fundamentals-brk-b-')
    expect(payload.agentRef).toEqual({ name: 'torghut-fundamentals-agent' })
    expect(payload.implementationSpecRef).toEqual({ name: 'torghut-market-context-fundamentals-v1' })
    expect(payload.parameters.reason).toBe('on_demand_stale_snapshot_refresh')
  })

  it('resolves submitted AgentRun names from Agents service responses', () => {
    expect(
      resolveSubmittedTorghutMarketContextAgentRunName({
        ok: true,
        status: 201,
        body: {
          resource: { metadata: { name: 'resource-name' } },
          agentRun: { externalRunId: 'external-id' },
        },
      }),
    ).toBe('resource-name')

    expect(
      resolveSubmittedTorghutMarketContextAgentRunName({
        ok: true,
        status: 200,
        body: { agentRun: { externalRunId: 'external-id' } },
      }),
    ).toBe('external-id')

    expect(
      resolveSubmittedTorghutMarketContextAgentRunName({
        ok: true,
        status: 200,
        body: { existingAgentRunName: 'existing-name' },
      }),
    ).toBe('existing-name')
  })

  it('submits on-demand market-context AgentRuns through the Agents service boundary', async () => {
    const submitAgentRun = vi.fn(async () => ({
      ok: true as const,
      status: 201,
      body: {
        resource: {
          metadata: {
            name: 'torghut-market-context-news-nvda-abcde',
          },
        },
      },
    }))

    const runName = await submitTorghutMarketContextAgentRun({
      symbol: 'NVDA',
      domain: 'news',
      snapshotState: 'missing',
      provider: 'news-provider',
      requestId: 'market-context-news-nvda-request',
      now: new Date('2026-05-20T12:00:00.000Z'),
      settings,
      submitAgentRun,
    })

    expect(runName).toBe('torghut-market-context-news-nvda-abcde')
    expect(submitAgentRun).toHaveBeenCalledWith({
      deliveryId: 'market-context-news-nvda-request',
      payload: expect.objectContaining({
        metadata: expect.objectContaining({
          generateName: 'torghut-market-context-news-nvda-',
        }),
        implementationSpecRef: { name: 'torghut-market-context-news-v1' },
      }),
    })
  })
})
