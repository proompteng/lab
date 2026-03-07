import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node:child_process', () => childProcessMocks)

const recordWatchEventMock = vi.hoisted(() => vi.fn())
const recordWatchErrorMock = vi.hoisted(() => vi.fn())
const recordWatchRestartMock = vi.hoisted(() => vi.fn())

vi.mock('~/server/metrics', () => ({
  recordKubeWatchEvent: (...args: unknown[]) => recordWatchEventMock(...args),
  recordKubeWatchError: (...args: unknown[]) => recordWatchErrorMock(...args),
  recordKubeWatchRestart: (...args: unknown[]) => recordWatchRestartMock(...args),
}))

import { startResourceWatch } from '~/server/kube-watch'

type MockWatchProcess = EventEmitter & {
  stdout: EventEmitter & { setEncoding: (encoding: string | undefined) => void }
  stderr: EventEmitter & { setEncoding: (encoding: string | undefined) => void }
  kill: ReturnType<typeof vi.fn>
}

const createMockWatchProcess = () => {
  const mockProcess = new EventEmitter() as MockWatchProcess
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string | undefined) => void }
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string | undefined) => void }
  stdout.setEncoding = () => {}
  stderr.setEncoding = () => {}

  mockProcess.stdout = stdout
  mockProcess.stderr = stderr
  mockProcess.kill = vi.fn()
  return mockProcess
}

describe('kube-watch', () => {
  const spawnMocks = childProcessMocks.spawn
  let watchHandle: ReturnType<typeof startResourceWatch> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMocks.mockReset()
    recordWatchEventMock.mockReset()
    recordWatchErrorMock.mockReset()
    recordWatchRestartMock.mockReset()
  })

  afterEach(() => {
    if (watchHandle) {
      watchHandle.stop()
      watchHandle = null
    }
    vi.useRealTimers()
  })

  it('records watch events and forwards payloads to the event handler', () => {
    const watchProcess = createMockWatchProcess()
    spawnMocks.mockReturnValue(watchProcess)

    const onEvent = vi.fn()
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent,
    })

    ;(watchProcess.stdout as MockWatchProcess['stdout']).emit('data', '{"type":"ADDED","object":{"kind":"AgentRun"}}')
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'ADDED', object: { kind: 'AgentRun' } })
    expect(recordWatchEventMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      type: 'ADDED',
    })

    ;(watchProcess.stdout as MockWatchProcess['stdout']).emit('data', '{"type":"BOOKMARK"}')
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(recordWatchEventMock).toHaveBeenCalledTimes(1)
  })

  it('records parse errors and forwards them to onError', () => {
    const watchProcess = createMockWatchProcess()
    spawnMocks.mockReturnValue(watchProcess)

    const onError = vi.fn()
    startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent: vi.fn(),
      onError,
    })

    ;(watchProcess.stdout as MockWatchProcess['stdout']).emit('data', '{type:"BAD"}')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('failed to parse watch event'),
      }),
    )
    expect(recordWatchErrorMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      reason: 'parse_error',
    })
  })

  it('restarts watch and records restart metrics when the process exits non-zero', () => {
    const watchProcesses: MockWatchProcess[] = []
    spawnMocks.mockImplementation(() => {
      const watchProcess = createMockWatchProcess()
      watchProcesses.push(watchProcess)
      return watchProcess
    })

    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })
    expect(spawnMocks).toHaveBeenCalledTimes(1)

    const first = watchProcesses[0]
    expect(first).toBeDefined()
    first.emit('close', 1)

    expect(recordWatchErrorMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      reason: 'close_1',
    })
    expect(recordWatchRestartMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      reason: 'nonzero_exit',
    })

    vi.advanceTimersByTime(2000)
    expect(spawnMocks).toHaveBeenCalledTimes(2)
  })

  it('invokes onRestart with the restart reason when the process exits non-zero', () => {
    const watchProcess = createMockWatchProcess()
    spawnMocks.mockReturnValue(watchProcess)

    const onRestart = vi.fn()
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent: vi.fn(),
      onRestart,
      restartDelayMs: 2000,
    })

    watchProcess.emit('close', 1)

    expect(onRestart).toHaveBeenCalledWith('nonzero_exit')
  })
})
