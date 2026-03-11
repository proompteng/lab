import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
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

import { resetKubectlWatchCompatibilityCacheForTests, startResourceWatch } from '~/server/kube-watch'

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
  const spawnSyncMocks = childProcessMocks.spawnSync
  let watchHandle: ReturnType<typeof startResourceWatch> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMocks.mockReset()
    spawnSyncMocks.mockReset()
    spawnSyncMocks.mockReturnValue({
      stdout: '    --resource-version="":\n',
      stderr: '',
    })
    recordWatchEventMock.mockReset()
    recordWatchErrorMock.mockReset()
    recordWatchRestartMock.mockReset()
    resetKubectlWatchCompatibilityCacheForTests()
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

  it('starts the watch with the requested resource version', () => {
    const watchProcess = createMockWatchProcess()
    spawnMocks.mockReturnValue(watchProcess)

    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
    })

    expect(spawnMocks).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['--resource-version=12345']),
      expect.any(Object),
    )
  })

  it('restarts from the latest observed resource version after a non-zero exit', () => {
    const watchProcesses: MockWatchProcess[] = []
    spawnMocks.mockImplementation(() => {
      const watchProcess = createMockWatchProcess()
      watchProcesses.push(watchProcess)
      return watchProcess
    })

    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })

    expect(spawnMocks.mock.calls[0]?.[1]).toContain('--resource-version=12345')

    const first = watchProcesses[0]
    expect(first).toBeDefined()
    ;(first.stdout as MockWatchProcess['stdout']).emit(
      'data',
      '{"type":"MODIFIED","object":{"kind":"AgentRun","metadata":{"resourceVersion":"12399"}}}',
    )
    first.emit('close', 1)

    vi.advanceTimersByTime(2000)

    expect(spawnMocks).toHaveBeenCalledTimes(2)
    expect(spawnMocks.mock.calls[1]?.[1]).toContain('--resource-version=12399')
  })

  it('drops the carried resource version when a restarted watch exits before any event', () => {
    const watchProcesses: MockWatchProcess[] = []
    spawnMocks.mockImplementation(() => {
      const watchProcess = createMockWatchProcess()
      watchProcesses.push(watchProcess)
      return watchProcess
    })

    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })

    expect(spawnMocks.mock.calls[0]?.[1]).toContain('--resource-version=12345')

    const first = watchProcesses[0]
    expect(first).toBeDefined()
    first.emit('close', 1)

    vi.advanceTimersByTime(2000)

    expect(spawnMocks).toHaveBeenCalledTimes(2)
    expect(spawnMocks.mock.calls[1]?.[1]).not.toContain('--resource-version=12345')
  })

  it('skips the resource version flag when kubectl get does not support it', () => {
    const watchProcess = createMockWatchProcess()
    spawnMocks.mockReturnValue(watchProcess)
    spawnSyncMocks.mockReturnValue({
      stdout: '    --watch-only=false:\n',
      stderr: '',
    })

    watchHandle = startResourceWatch({
      resource: 'approvalpolicies.approvals.proompteng.ai',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
    })

    expect(spawnSyncMocks).toHaveBeenCalledWith(
      'kubectl',
      ['get', '--help'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    )
    expect(spawnMocks.mock.calls[0]?.[1]).not.toContain('--resource-version=12345')
  })
})
