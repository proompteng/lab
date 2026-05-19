import { afterEach, describe, expect, it, vi } from 'vitest'

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
    process.env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS = '300000'

    const listAgentRuns = vi.fn(async (_namespace: string) => [buildAgentRun()])
    const patchAgentRunAnnotations = vi.fn(async () => {})
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})

    startWhitepaperFinalizeConsumer({ listAgentRuns, patchAgentRunAnnotations, finalize })

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1))
    expect(listAgentRuns).toHaveBeenCalledWith('agents')
    expect(patchAgentRunAnnotations).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'whitepaper-run',
        namespace: 'agents',
        annotations: expect.objectContaining({
          'jangar.proompteng.ai/whitepaper-finalized-phase': 'Succeeded',
          'jangar.proompteng.ai/whitepaper-finalized-run-id': 'wp-consumer',
        }),
      }),
    )
    expect(getWhitepaperFinalizeConsumerHealth()).toMatchObject({
      enabled: true,
      mode: 'agents-service-poll',
      started: true,
      namespaces: ['agents'],
      scanIntervalMs: 300000,
    })

    stopWhitepaperFinalizeConsumer()
    expect(getWhitepaperFinalizeConsumerHealth()).toMatchObject({
      started: false,
      scanIntervalMs: null,
    })
  })

  it('ignores already-finalized AgentRun resources from the Agents service', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS = '300000'

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
    const listAgentRuns = vi.fn(async (_namespace: string) => [finalizedRun])
    const patchAgentRunAnnotations = vi.fn(async () => {})
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})

    startWhitepaperFinalizeConsumer({ listAgentRuns, patchAgentRunAnnotations, finalize })

    await vi.waitFor(() => expect(listAgentRuns).toHaveBeenCalledTimes(1))
    expect(finalize).not.toHaveBeenCalled()
    expect(patchAgentRunAnnotations).not.toHaveBeenCalled()
  })
})
