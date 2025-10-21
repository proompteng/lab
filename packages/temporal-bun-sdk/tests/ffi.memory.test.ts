import { describe, expect, test } from 'bun:test'

import { TemporalBridgeError, TemporalBridgeErrorCode } from '../src/errors'
import { __testing, clientClose, clientConnect } from '../src/ffi'

function drain(): { status: number; ptr: bigint; len: bigint } {
  return __testing.drainErrorSlot()
}

const INVALID_HANDLE = BigInt(Number.MAX_SAFE_INTEGER)

function getLastErrorRaw() {
  return __testing.getLastErrorRaw()
}

describe('Temporal bridge buffers', () => {
  test('te_get_last_error returns empty when slot clear', () => {
    const empty = getLastErrorRaw()
    expect(empty.status).toBe(0)
    expect(empty.ptr).toBe(0n)
    expect(empty.len).toBe(0n)
  })

  test('error buffers are released after mapping an error', () => {
    try {
      clientClose(INVALID_HANDLE)
      throw new Error('clientClose should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
      expect((error as TemporalBridgeError).code).toBe(TemporalBridgeErrorCode.NotFound)
    }

    const drained = drain()
    expect(drained.ptr).toBe(0n)
    expect(drained.len).toBe(0n)
  })

  test('successful calls do not leave residual buffers', () => {
    const handle = clientConnect()
    expect(handle).toBeGreaterThan(0n)
    clientClose(handle)

    const drained = drain()
    expect(drained.ptr).toBe(0n)
    expect(drained.len).toBe(0n)
  })

  test('double free surfaces not found without crashing', () => {
    const status = __testing.callClientClose(INVALID_HANDLE)
    expect(status).toBe(TemporalBridgeErrorCode.NotFound)

    const raw = getLastErrorRaw()
    expect(raw.status).toBe(0)
    expect(raw.ptr).not.toBe(0n)
    expect(raw.len).toBeGreaterThan(0n)
    expect(__testing.freeBuffer(raw.ptr, Number(raw.len))).toBe(0)
    expect(__testing.freeBuffer(raw.ptr, Number(raw.len))).toBe(TemporalBridgeErrorCode.NotFound)

    const drained = drain()
    expect(drained.ptr).not.toBe(0n)
    expect(drained.len).toBeGreaterThan(0n)

    const cleared = drain()
    expect(cleared.ptr).toBe(0n)
    expect(cleared.len).toBe(0n)
  })

  test('length mismatch frees buffer and reports invalid argument', () => {
    const status = __testing.callClientClose(INVALID_HANDLE)
    expect(status).toBe(TemporalBridgeErrorCode.NotFound)

    const raw = getLastErrorRaw()
    expect(raw.status).toBe(0)
    expect(raw.ptr).not.toBe(0n)
    expect(raw.len).toBeGreaterThan(0n)

    const mismatch = Number(raw.len + 1n)
    expect(__testing.freeBuffer(raw.ptr, mismatch)).toBe(TemporalBridgeErrorCode.InvalidArgument)
    const drainedAfterMismatch = drain()
    expect(drainedAfterMismatch.ptr).not.toBe(0n)
    expect(drainedAfterMismatch.len).toBeGreaterThan(0n)

    const slotCleared = drain()
    expect(slotCleared.ptr).toBe(0n)
    expect(slotCleared.len).toBe(0n)

    expect(__testing.freeBuffer(raw.ptr, Number(raw.len))).toBe(TemporalBridgeErrorCode.NotFound)
    const drainedFinal = drain()
    expect(drainedFinal.ptr).not.toBe(0n)
    expect(drainedFinal.len).toBeGreaterThan(0n)

    const finalClear = drain()
    expect(finalClear.ptr).toBe(0n)
    expect(finalClear.len).toBe(0n)
  })
})
