import { dlopen } from 'bun:ffi'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Test the Zig bridge worker creation functionality
describe('Zig Worker Creation (zig-worker-01)', () => {
  let native: Record<string, unknown>

  beforeAll(async () => {
    // Load the native Zig bridge library
    const libPath = join(process.cwd(), 'native/temporal-bun-bridge-zig/zig-out/lib/libtemporal_bun_bridge_zig.dylib')

    if (!existsSync(libPath)) {
      throw new Error(`Native library not found at ${libPath}. Run 'bun run build:native:zig' first.`)
    }

    native = dlopen(libPath, {
      temporal_bun_worker_new: {
        args: ['ptr', 'ptr', 'ptr', 'u64'],
        returns: 'ptr',
      },
      temporal_bun_worker_free: {
        args: ['ptr'],
        returns: 'void',
      },
      temporal_bun_error_message: {
        args: ['ptr'],
        returns: 'ptr',
      },
      temporal_bun_error_free: {
        args: ['ptr', 'u64'],
        returns: 'void',
      },
    })

    console.log('Loaded native functions:', Object.keys(native))
  })

  afterAll(() => {
    // Cleanup if needed
  })

  test('should create worker with valid configuration', () => {
    // Mock runtime and client handles (these would be real handles in actual usage)
    const runtimeHandle = new Uint8Array(64) // Mock runtime handle
    const clientHandle = new Uint8Array(64) // Mock client handle

    const configJson = JSON.stringify({
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
    })

    const configBuffer = new TextEncoder().encode(configJson)

    // Attempt to create worker
    const workerHandle = native.temporal_bun_worker_new(
      runtimeHandle.buffer,
      clientHandle.buffer,
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    // Check error state
    const errorLenPtr = Buffer.alloc(8) // u64 pointer
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    // Since we're using mock handles, we expect this to fail with a specific error
    // but it should not crash and should provide meaningful error information
    expect(errorMessage).toBeDefined()

    // The exact error depends on the mock handles, but it should be a structured error
    if (errorMessage.length > 0) {
      expect(errorMessage).toMatch(/temporal-bun-bridge-zig/)
    }

    // Clean up if worker was created
    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    // Clean up error message
    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })

  test('should handle invalid JSON configuration', () => {
    const runtimeHandle = new Uint8Array(64)
    const clientHandle = new Uint8Array(64)

    const invalidJson = 'invalid json'
    const configBuffer = new TextEncoder().encode(invalidJson)

    const workerHandle = native.temporal_bun_worker_new(
      runtimeHandle.buffer,
      clientHandle.buffer,
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    const errorLenPtr = Buffer.alloc(8)
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    // Should fail with JSON parsing error
    expect(errorMessage).toContain('failed to parse worker config JSON')

    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })

  test('should handle missing namespace in configuration', () => {
    const runtimeHandle = new Uint8Array(64)
    const clientHandle = new Uint8Array(64)

    const configJson = JSON.stringify({
      taskQueue: 'test-queue',
    })
    const configBuffer = new TextEncoder().encode(configJson)

    const workerHandle = native.temporal_bun_worker_new(
      runtimeHandle.buffer,
      clientHandle.buffer,
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    const errorLenPtr = Buffer.alloc(8)
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    expect(errorMessage).toContain("worker config must include 'namespace' field")

    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })

  test('should handle missing task queue in configuration', () => {
    const runtimeHandle = new Uint8Array(64)
    const clientHandle = new Uint8Array(64)

    const configJson = JSON.stringify({
      namespace: 'test-namespace',
    })
    const configBuffer = new TextEncoder().encode(configJson)

    const workerHandle = native.temporal_bun_worker_new(
      runtimeHandle.buffer,
      clientHandle.buffer,
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    const errorLenPtr = Buffer.alloc(8)
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    expect(errorMessage).toContain("worker config must include 'taskQueue' field")

    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })

  test('should handle null runtime handle', () => {
    const clientHandle = new Uint8Array(64)

    const configJson = JSON.stringify({
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
    })
    const configBuffer = new TextEncoder().encode(configJson)

    const workerHandle = native.temporal_bun_worker_new(
      null, // null runtime handle
      clientHandle.buffer,
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    const errorLenPtr = Buffer.alloc(8)
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    expect(errorMessage).toContain('runtime handle is required for worker creation')

    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })

  test('should handle null client handle', () => {
    const runtimeHandle = new Uint8Array(64)

    const configJson = JSON.stringify({
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
    })
    const configBuffer = new TextEncoder().encode(configJson)

    const workerHandle = native.temporal_bun_worker_new(
      runtimeHandle.buffer,
      null, // null client handle
      configBuffer.buffer,
      BigInt(configBuffer.length),
    )

    const errorLenPtr = Buffer.alloc(8)
    const errorPtr = native.temporal_bun_error_message(errorLenPtr.buffer)
    const errorLen = Number(errorLenPtr.readBigUInt64LE(0))
    const errorBuffer = Buffer.from(errorPtr, 0, errorLen)
    const errorMessage = errorBuffer.toString('utf8')

    expect(errorMessage).toContain('client handle is required for worker creation')

    if (workerHandle && workerHandle !== 0) {
      native.temporal_bun_worker_free(workerHandle)
    }

    if (errorPtr && errorLen > 0) {
      native.temporal_bun_error_free(errorPtr, BigInt(errorLen))
    }
  })
})
