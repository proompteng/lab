import { afterEach, describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '~/server/primitives-kube'
import {
  getWhitepaperFinalizeConsumerHealth,
  startWhitepaperFinalizeConsumer,
  stopWhitepaperFinalizeConsumer,
} from '~/server/whitepaper-finalize-consumer'
import type { WhitepaperFinalizeTerminalStatusInput } from '~/server/whitepaper-finalize'

const ORIGINAL_ENV = { ...process.env }

const buildAgentRun = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name: 'whitepaper-run',
    namespace: 'agents',
    uid: 'uid-1',
    annotations: {},
  },
  spec: {
    parameters: {
      runId: 'wp-consumer',
    },
  },
  status: {
    phase: 'Succeeded',
  },
  ...overrides,
})

const buildKube = (items: Record<string, unknown>[] = []) =>
  ({
    list: vi.fn(async () => ({ items })),
    patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  }) as unknown as KubernetesClient

describe('whitepaper finalize consumer', () => {
  afterEach(() => {
    stopWhitepaperFinalizeConsumer()
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  it('scans terminal whitepaper AgentRuns and annotates completed finalization', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_NAMESPACES = 'agents'

    const kube = buildKube([buildAgentRun()])
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})
    const watchStop = vi.fn()
    const startWatch = vi.fn(() => ({ stop: watchStop }))

    startWhitepaperFinalizeConsumer({ kube, finalize, startWatch })

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1))
    expect(kube.list).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'agents')
    expect(kube.patch).toHaveBeenCalledWith(
      RESOURCE_MAP.AgentRun,
      'whitepaper-run',
      'agents',
      expect.objectContaining({
        metadata: {
          annotations: expect.objectContaining({
            'jangar.proompteng.ai/whitepaper-finalized-phase': 'Succeeded',
            'jangar.proompteng.ai/whitepaper-finalized-run-id': 'wp-consumer',
          }),
        },
      }),
    )
    expect(getWhitepaperFinalizeConsumerHealth()).toMatchObject({
      enabled: true,
      started: true,
      namespaces: ['agents'],
    })

    stopWhitepaperFinalizeConsumer()
    expect(watchStop).toHaveBeenCalledTimes(1)
  })

  it('ignores already-finalized watch events', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'

    const finalizedRun = buildAgentRun({
      metadata: {
        name: 'whitepaper-run',
        namespace: 'agents',
        uid: 'uid-1',
        annotations: {
          'jangar.proompteng.ai/whitepaper-finalized-phase': 'Succeeded',
          'jangar.proompteng.ai/whitepaper-finalized-run-id': 'wp-consumer',
        },
      },
    })
    const kube = buildKube([])
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})
    const watchHandlers: Array<(event: { type?: string; object?: Record<string, unknown> }) => void | Promise<void>> =
      []
    const startWatch = vi.fn((options) => {
      watchHandlers.push(options.onEvent)
      return { stop: vi.fn() }
    })

    startWhitepaperFinalizeConsumer({ kube, finalize, startWatch })
    expect(watchHandlers[0]).toBeDefined()
    await watchHandlers[0]?.({ type: 'MODIFIED', object: finalizedRun })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(finalize).not.toHaveBeenCalled()
    expect(kube.patch).not.toHaveBeenCalled()
  })
})
