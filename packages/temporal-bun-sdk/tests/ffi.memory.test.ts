import { describe, expect, test } from 'bun:test'
import { TemporalBridgeError } from '../src/errors.ts'
import { closeClient, connectClient, drainErrorForTest, StatusCodes } from '../src/ffi.ts'
import { ClientHandle } from '../src/handles.ts'

describe('ffi memory contract', () => {
  test('error buffers are freed after mapping', () => {
    try {
      closeClient(123n)
      expect.unreachable('closeClient should throw for unknown handle')
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.code).toBe(StatusCodes.notFound)
    }
    expect(drainErrorForTest()).toBeNull()
  })

  test('successful lifecycle leaves no dangling buffers', () => {
    const handle = connectClient()
    expect(handle).toBeGreaterThan(0n)
    closeClient(handle)
    expect(drainErrorForTest()).toBeNull()
  })

  test('RAII cleanup swallows native errors during shutdown', () => {
    const client = ClientHandle.create()
    client.close()
    try {
      client.close()
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
    }
    expect(drainErrorForTest()).toBeNull()
  })
})
