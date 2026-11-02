import { describe, expect, it, vi } from 'vitest'

import { createRunnerTelemetry } from './telemetry'

describe('runner telemetry', () => {
  it('separates liveness from activity and keeps cumulative usage without double counting', async () => {
    let date = new Date('2026-11-01T00:00:00Z')
    const lines: string[] = []
    const publish = vi.fn(async () => {})
    const telemetry = createRunnerTelemetry({
      model: 'gpt-6-astra',
      effort: 'ultra',
      now: () => date,
      publish,
      write: (line) => lines.push(line),
    })
    telemetry.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
    telemetry.observe({
      method: 'item/started',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'commandExecution', id: 'command', command: 'cargo test' },
      },
    })
    const total = {
      totalTokens: 120,
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 5,
    }
    telemetry.observe({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { total } } })
    telemetry.observe({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { total } } })
    date = new Date('2026-11-01T00:01:00Z')
    await telemetry.flush()
    expect(telemetry.snapshot()).toMatchObject({
      heartbeatAt: date.toISOString(),
      lastActivityAt: '2026-11-01T00:00:00.000Z',
      usage: total,
      effort: 'ultra',
      activeToolCount: 1,
    })
    telemetry.observe({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'commandExecution', id: 'command', command: 'cargo test', exitCode: 0 },
      },
    })
    await telemetry.finish()
    expect(telemetry.snapshot()).toMatchObject({ state: 'finished', activeTools: [], activeToolCount: 0 })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(lines.join('')).toContain('"exitCode":0')
  })

  it('captures continuation turns while omitting authentication and MCP argument values', async () => {
    const lines: string[] = []
    const telemetry = createRunnerTelemetry({ write: (line) => lines.push(line) })
    telemetry.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'first' } } })
    telemetry.observe({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'first', status: 'completed' } },
    })
    telemetry.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'second' } } })
    telemetry.observe({
      method: 'item/started',
      params: {
        threadId: 'thread',
        turnId: 'second',
        item: { type: 'mcpToolCall', id: 'call', tool: 'search', arguments: { token: 'never-log-me' } },
      },
    })
    telemetry.observe({ method: 'account/login/completed', params: { token: 'never-log-me' } })
    telemetry.observe({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1234 },
          secondary: null,
          credentials: 'never-log-me',
        },
      },
    })
    await telemetry.finish()
    expect(telemetry.snapshot()).toMatchObject({ turnId: 'second', quota: { primary: { usedPercent: 61 } } })
    expect(lines.join('')).toContain('"turnId":"second"')
    expect(lines.join('')).not.toContain('never-log-me')
  })

  it('makes publication failures observable and retries without failing execution', async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(undefined)
    const lines: string[] = []
    const telemetry = createRunnerTelemetry({ publish, write: (line) => lines.push(line) })
    await telemetry.flush()
    await telemetry.finish()
    expect(telemetry.snapshot().publishErrors).toBe(1)
    expect(lines.join('')).toContain('telemetry_error')
    expect(publish).toHaveBeenCalledTimes(2)
  })
})
