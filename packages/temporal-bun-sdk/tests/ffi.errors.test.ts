import { describe, expect, test } from 'bun:test'
import { TemporalBridgeError } from '../src/errors.ts'
import { closeClient, drainErrorForTest, StatusCodes, startWorker } from '../src/ffi.ts'
import { ClientHandle } from '../src/handles.ts'

describe('ffi error handling', () => {
  test('closing unknown client surfaces native payload', () => {
    try {
      closeClient(999n)
      expect.unreachable('closeClient should throw for unknown handle')
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.code).toBe(StatusCodes.notFound)
      expect(bridgeError.where).toBe('te_client_close')
    }
    expect(drainErrorForTest()).toBeNull()
  })

  test('starting worker on closed client reports typed error', () => {
    const client = ClientHandle.create()
    client.close()
    try {
      startWorker(client.id)
      expect.unreachable('startWorker should throw when client is closed')
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.code).toBe(StatusCodes.invalidArgument)
      expect(bridgeError.where).toBe('te_worker_start')
    }
    expect(drainErrorForTest()).toBeNull()
  })

  test('RAII close guards against double close', () => {
    const client = ClientHandle.create()
    client.close()
    try {
      client.close()
      expect.unreachable('ClientHandle.close should throw on second invocation')
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalBridgeError)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.code).toBe(StatusCodes.alreadyClosed)
      expect(bridgeError.where).toBe('ClientHandle.close')
    }
    expect(drainErrorForTest()).toBeNull()
  })
})
