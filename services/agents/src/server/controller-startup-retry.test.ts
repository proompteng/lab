import { afterEach, describe, expect, it, vi } from 'vitest'

import { createControllerStartupRetry } from './controller-startup-retry'

const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

describe('createControllerStartupRetry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries when the start call returns without a started controller', async () => {
    vi.useFakeTimers()
    let started = false
    const start = vi.fn(async () => {
      started = start.mock.calls.length >= 2
    })
    const logger = { warn: vi.fn() }
    const retry = createControllerStartupRetry({
      name: 'agents-controller',
      start,
      isStarted: () => started,
      minDelayMs: 100,
      maxDelayMs: 100,
      logger,
    })

    retry.start()
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(1)
    expect(retry.pending()).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      '[agents] agents-controller startup retry scheduled',
      expect.objectContaining({ attempt: 1, delayMs: 100 }),
    )

    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(2)
    expect(started).toBe(true)
    expect(retry.pending()).toBe(false)
  })

  it('does not schedule a retry when the controller starts', async () => {
    vi.useFakeTimers()
    const start = vi.fn(async () => {})
    const logger = { warn: vi.fn() }
    const retry = createControllerStartupRetry({
      name: 'orchestration-controller',
      start,
      isStarted: () => true,
      minDelayMs: 100,
      logger,
    })

    retry.start()
    await flushPromises()

    expect(start).not.toHaveBeenCalled()
    expect(retry.pending()).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('cancels a pending retry', async () => {
    vi.useFakeTimers()
    const start = vi.fn(async () => {})
    const retry = createControllerStartupRetry({
      name: 'supporting-controller',
      start,
      isStarted: () => false,
      minDelayMs: 100,
      logger: { warn: vi.fn() },
    })

    retry.start()
    await flushPromises()
    retry.cancel()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(1)
    expect(retry.pending()).toBe(false)
  })

  it('honors non-retryable errors', async () => {
    vi.useFakeTimers()
    const error = new Error('namespace scope is invalid')
    const start = vi.fn(async () => {
      throw error
    })
    const logger = { warn: vi.fn() }
    const retry = createControllerStartupRetry({
      name: 'agents-controller',
      start,
      isStarted: () => false,
      shouldRetry: () => false,
      minDelayMs: 100,
      logger,
    })

    retry.start()
    await flushPromises()

    expect(start).toHaveBeenCalledTimes(1)
    expect(retry.pending()).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      '[agents] agents-controller startup retry stopped after non-retryable error',
      expect.objectContaining({ reason: 'namespace scope is invalid' }),
    )
  })
})
