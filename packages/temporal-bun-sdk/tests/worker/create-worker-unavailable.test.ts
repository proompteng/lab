import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const { createWorker, __testing } = await import('../../src/worker')
const { NativeBridgeError } = await import('../../src/internal/core-bridge/native')

const ORIGINAL_USE_ZIG = process.env.TEMPORAL_BUN_SDK_USE_ZIG

describe('createWorker diagnostics', () => {
  const originalConsoleError = console.error
  const logs: unknown[][] = []

  beforeEach(() => {
    process.env.TEMPORAL_BUN_SDK_USE_ZIG = '0'
    logs.length = 0
    console.error = (...args: unknown[]) => {
      logs.push(args)
    }
  })

  afterEach(() => {
    if (ORIGINAL_USE_ZIG === undefined) {
      delete process.env.TEMPORAL_BUN_SDK_USE_ZIG
    } else {
      process.env.TEMPORAL_BUN_SDK_USE_ZIG = ORIGINAL_USE_ZIG
    }
    console.error = originalConsoleError
  })

  test('throws NativeBridgeError with friendly message when Zig bridge disabled', async () => {
    await expect(createWorker()).rejects.toThrow(NativeBridgeError)
    expect(logs.length).toBeGreaterThan(0)
    const [firstLog] = logs
    const message = firstLog?.[0]
    expect(typeof message).toBe('string')
    expect(String(message)).toContain(__testing.BRIDGE_UNAVAILABLE_MESSAGE)
  })
})
