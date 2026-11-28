import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRunnerTelemetry, createTelemetryPublisher } from './telemetry'

describe('runner telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('separates liveness from activity and keeps cumulative usage without double counting', async () => {
    let date = new Date('2026-11-01T00:00:00Z')
    const lines: string[] = []
    const publish = vi.fn(async () => {})
    const telemetry = createRunnerTelemetry({
      model: 'gpt-6.2-sol',
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

  it('logs 30-second heartbeats without queueing overlapping PUTs and awaits one final PUT', async () => {
    vi.useFakeTimers()
    const periodic = Promise.withResolvers<void>()
    const final = Promise.withResolvers<void>()
    const finalStarted = Promise.withResolvers<void>()
    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(periodic.promise)
      .mockImplementationOnce(() => {
        finalStarted.resolve()
        return final.promise
      })
    const lines: string[] = []
    const telemetry = createRunnerTelemetry({ publish, write: (line) => lines.push(line) })

    await telemetry.start()
    vi.advanceTimersByTime(29_999)
    expect(lines).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_000)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(lines).toHaveLength(4)
    expect(lines.slice(1).every((line) => JSON.parse(line).event.type === 'heartbeat')).toBe(true)

    const finished = telemetry.finish()
    expect(telemetry.finish()).toBe(finished)
    expect(publish).toHaveBeenCalledTimes(2)
    periodic.resolve()
    await finalStarted.promise
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'finished', publishErrors: 0 }))

    let returned = false
    void finished.then(() => {
      returned = true
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    final.resolve()
    await expect(finished).resolves.toMatchObject({ state: 'finished', publishErrors: 0 })

    vi.advanceTimersByTime(60_000)
    expect(publish).toHaveBeenCalledTimes(3)
    expect(lines).toHaveLength(5)
  })

  it('aborts a stalled periodic S3 PUT and still writes terminal telemetry', async () => {
    vi.useFakeTimers()
    const periodic = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(new AbortController().signal)
    timeout.mockReturnValueOnce(periodic.signal).mockReturnValueOnce(new AbortController().signal)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(null, { status: 200 }))
      .mockImplementationOnce(async () => new Response(null, { status: 200 }))
      .mockImplementationOnce(
        async (_, init) =>
          new Promise((_, reject) => {
            const signal = init?.signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      )
    const publish = createTelemetryPublisher(
      {
        AGENT_RUN_NAMESPACE: 'agents',
        AGENT_RUN_UID: 'run-uid',
        AGENTS_ARTIFACTS_ENDPOINT: 'http://storage.test',
        AGENTS_ARTIFACTS_BUCKET: 'agents-artifacts',
        AWS_ACCESS_KEY_ID: 'test-access',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
      },
      fetch,
    )
    const lines: string[] = []
    const telemetry = createRunnerTelemetry({
      heartbeatIntervalMs: 100,
      publish,
      write: (line) => lines.push(line),
    })
    await telemetry.start()
    vi.advanceTimersByTime(100)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(timeout).toHaveBeenNthCalledWith(2, 8_000)
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(periodic.signal)

    const finished = telemetry.finish()
    periodic.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await expect(finished).resolves.toMatchObject({ state: 'finished', publishErrors: 1 })
    expect(fetch).toHaveBeenCalledTimes(3)
    const body = fetch.mock.calls[2]?.[1]?.body as ArrayBuffer
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ state: 'finished', publishErrors: 1 })
    expect(lines.join('')).toContain('"type":"telemetry_error","message":"The operation timed out."')
  })
})
