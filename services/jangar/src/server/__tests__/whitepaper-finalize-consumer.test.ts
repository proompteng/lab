import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentsAgentRunTerminalEvent } from '@proompteng/agent-contracts'

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

const buildTerminalEvent = (overrides: Partial<AgentsAgentRunTerminalEvent> = {}): AgentsAgentRunTerminalEvent => {
  const resource = buildAgentRun(overrides.resource ?? {})
  return {
    eventId: 'agents/whitepaper-run/uid-1/Succeeded',
    name: 'whitepaper-run',
    namespace: 'agents',
    uid: 'uid-1',
    phase: 'Succeeded',
    runId: 'wp-consumer',
    observedAt: '2026-05-20T00:00:00.000Z',
    acked: false,
    ackedAt: null,
    ackOutcome: null,
    resource,
    status: resource.status as Record<string, unknown>,
    ...overrides,
  }
}

describe('whitepaper finalize consumer', () => {
  afterEach(() => {
    stopWhitepaperFinalizeConsumer()
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  it('scans terminal whitepaper AgentRun events and acks completed finalization', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_NAMESPACES = 'agents'
    process.env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS = '300000'

    const listTerminalEvents = vi.fn(async (_namespace: string) => [buildTerminalEvent()])
    const ackTerminalEvent = vi.fn(async () => {})
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})

    startWhitepaperFinalizeConsumer({ listTerminalEvents, ackTerminalEvent, finalize })

    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1))
    expect(listTerminalEvents).toHaveBeenCalledWith('agents')
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({ kind: 'AgentRun' }),
        nextStatus: expect.objectContaining({ phase: 'Succeeded' }),
        previousPhase: null,
        nextPhase: 'Succeeded',
      }),
    )
    expect(ackTerminalEvent).toHaveBeenCalledWith({
      eventId: 'agents/whitepaper-run/uid-1/Succeeded',
      consumer: 'whitepaper-finalize',
      outcome: 'finalized',
      message: 'Finalized whitepaper run wp-consumer',
    })
    expect(getWhitepaperFinalizeConsumerHealth()).toMatchObject({
      enabled: true,
      mode: 'agents-terminal-events',
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

  it('ignores already-acked terminal AgentRun events from the Agents service', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS = '300000'

    const listTerminalEvents = vi.fn(async (_namespace: string) => [
      buildTerminalEvent({
        acked: true,
        ackedAt: '2026-05-20T00:01:00.000Z',
        ackOutcome: 'finalized',
      }),
    ])
    const ackTerminalEvent = vi.fn(async () => {})
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})

    startWhitepaperFinalizeConsumer({ listTerminalEvents, ackTerminalEvent, finalize })

    await vi.waitFor(() => expect(listTerminalEvents).toHaveBeenCalledTimes(1))
    expect(finalize).not.toHaveBeenCalled()
    expect(ackTerminalEvent).not.toHaveBeenCalled()
  })

  it('ignores Agents namespace aliases when resolving Jangar finalization namespaces', async () => {
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_CONSUMER_ENABLED = 'true'
    process.env.AGENTS_NAMESPACE = 'wrong-agents-namespace'
    process.env.JANGAR_WHITEPAPER_FINALIZE_SCAN_INTERVAL_MS = '300000'

    const listTerminalEvents = vi.fn(async (_namespace: string) => [])
    const ackTerminalEvent = vi.fn(async () => {})
    const finalize = vi.fn(async (_input: WhitepaperFinalizeTerminalStatusInput) => {})

    startWhitepaperFinalizeConsumer({ listTerminalEvents, ackTerminalEvent, finalize })

    await vi.waitFor(() => expect(listTerminalEvents).toHaveBeenCalledTimes(1))
    expect(listTerminalEvents).toHaveBeenCalledWith('agents')
    expect(listTerminalEvents).not.toHaveBeenCalledWith('wrong-agents-namespace')
  })
})
