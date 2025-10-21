import { describe, expect, test } from 'bun:test'

import { buildTemporalBridgeError, TemporalBridgeError, TemporalBridgeErrorCode } from '../src/errors'
import { clientClose, workerShutdown } from '../src/ffi'
import { ClientHandle } from '../src/handles'

function expectTemporalError(error: unknown, code: TemporalBridgeErrorCode) {
  expect(error).toBeInstanceOf(TemporalBridgeError)
  expect((error as TemporalBridgeError).code).toBe(code)
}

describe('Temporal bridge errors', () => {
  const INVALID_HANDLE = BigInt(Number.MAX_SAFE_INTEGER)

  test('closing an unknown client surfaces not found', () => {
    try {
      clientClose(INVALID_HANDLE)
      throw new Error('clientClose should have thrown')
    } catch (error) {
      expectTemporalError(error, TemporalBridgeErrorCode.NotFound)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.message).toContain('client handle not found')
      expect(bridgeError.where).toBe('te_client_close')
      expect(bridgeError.raw).toContain('"message":"client handle not found"')
    }
  })

  test('client handle throws on double close', () => {
    const client = ClientHandle.open()
    client.close()
    try {
      client.close()
      throw new Error('close should throw on already closed client')
    } catch (error) {
      expectTemporalError(error, TemporalBridgeErrorCode.AlreadyClosed)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.where).toBe('te_client_close')
    }
  })

  test('worker shutdown reports already closed', () => {
    const client = ClientHandle.open()
    const worker = client.startWorker()
    worker.close()
    try {
      worker.close()
      throw new Error('worker.close() should throw when already closed')
    } catch (error) {
      expectTemporalError(error, TemporalBridgeErrorCode.AlreadyClosed)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.where).toBe('te_worker_shutdown')
    }
  })

  test('workerShutdown reports not found for unknown handles', () => {
    try {
      workerShutdown(INVALID_HANDLE)
      throw new Error('workerShutdown should throw')
    } catch (error) {
      expectTemporalError(error, TemporalBridgeErrorCode.NotFound)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.where).toBe('te_worker_shutdown')
    }
  })

  test('worker start fails when client already closed', () => {
    const client = ClientHandle.open()
    client.close()
    try {
      client.startWorker()
      throw new Error('startWorker should throw when client is closed')
    } catch (error) {
      expectTemporalError(error, TemporalBridgeErrorCode.AlreadyClosed)
      const bridgeError = error as TemporalBridgeError
      expect(bridgeError.where).toBe('te_worker_start')
    }
  })

  test('buildTemporalBridgeError falls back when payload invalid', () => {
    const buffer = new TextEncoder().encode('not json')
    const error = buildTemporalBridgeError({
      status: TemporalBridgeErrorCode.Internal,
      where: 'te_test',
      buffer,
    })
    expect(error.code).toBe(TemporalBridgeErrorCode.Internal)
    expect(error.where).toBe('te_test')
    expect(error.raw).toBe('not json')
  })

  test('buildTemporalBridgeError supports message and source fields', () => {
    const payload = {
      code: TemporalBridgeErrorCode.InvalidArgument,
      message: 'boom',
      source: 'native',
    }
    const buffer = new TextEncoder().encode(JSON.stringify(payload))
    const error = buildTemporalBridgeError({ status: 99, where: 'te_unused', buffer })
    expect(error.code).toBe(TemporalBridgeErrorCode.InvalidArgument)
    expect(error.where).toBe('native')
    expect(error.message).toBe('boom')
  })
})
