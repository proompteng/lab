import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS,
  startMaterialReentrySwarmReconcileLoop,
  startSwarmWatchers,
  stopMaterialReentrySwarmReconcileLoop,
} from '~/server/supporting-primitives-material-reentry-swarm-reconciler'

const ORIGINAL_ENV = { ...process.env }

describe('supporting primitives material reentry swarm reconciler', () => {
  afterEach(() => {
    stopMaterialReentrySwarmReconcileLoop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('polls Swarm resources through the Agents service boundary for watcher events', async () => {
    const handles: Array<{ stop: () => void }> = []
    const listSwarms = vi.fn(async (_namespace: string) => [
      { kind: 'Swarm', metadata: { name: 'jangar-control-plane', namespace: 'agents' } },
    ])
    const onEvent = vi.fn()

    startSwarmWatchers(['agents'], handles, onEvent, { listSwarms, intervalMs: 10_000 })

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(listSwarms).toHaveBeenCalledWith('agents')
    expect(onEvent).toHaveBeenCalledWith('agents', {
      type: 'SYNC',
      object: { kind: 'Swarm', metadata: { name: 'jangar-control-plane', namespace: 'agents' } },
    })

    expect(handles).toHaveLength(1)
    handles[0]?.stop()
  })

  it('queues material reentry reconciles from Agents service Swarm lists', async () => {
    vi.useFakeTimers()
    process.env.JANGAR_MATERIAL_REENTRY_REQUIREMENT_SIGNALS = 'true'

    const taskQueue: Array<() => Promise<void>> = []
    const listSwarms = vi.fn(async (_namespace: string) => [
      { kind: 'Swarm', metadata: { name: 'jangar-control-plane', namespace: 'agents' } },
    ])
    const reconcileSwarm = vi.fn(async () => {})
    const queueResourceTask = vi.fn((_namespace: string, _key: string, task: () => Promise<void>) => {
      taskQueue.push(task)
    })

    startMaterialReentrySwarmReconcileLoop({
      canReconcile: () => true,
      listSwarms,
      namespaces: ['agents'],
      queueResourceTask,
      reconcileSwarm,
    })

    await vi.advanceTimersByTimeAsync(MATERIAL_REENTRY_SWARM_RECONCILE_INTERVAL_MS)
    expect(queueResourceTask).toHaveBeenCalledWith('agents', 'agents/Swarm/material-reentry-scan', expect.any(Function))
    expect(taskQueue).toHaveLength(1)

    await taskQueue[0]?.()
    expect(listSwarms).toHaveBeenCalledWith('agents')
    expect(reconcileSwarm).toHaveBeenCalledWith(
      { kind: 'Swarm', metadata: { name: 'jangar-control-plane', namespace: 'agents' } },
      'agents',
    )
  })
})
