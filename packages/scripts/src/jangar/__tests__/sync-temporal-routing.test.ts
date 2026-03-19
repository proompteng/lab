import { afterEach, describe, expect, it } from 'bun:test'

import { __private } from '../sync-temporal-routing'

const originalSpawn = Bun.spawn
const originalSleep = Bun.sleep

afterEach(() => {
  Bun.spawn = originalSpawn
  Bun.sleep = originalSleep
})

describe('sync-temporal-routing', () => {
  it('parses boolean and value args', () => {
    const parsed = __private.parseArgs([
      '--address',
      'temporal.example:7233',
      '--namespace',
      'default',
      '--task-queue',
      'jangar',
      '--deployment-name',
      'jangar-deployment',
      '--migrate-stale-running',
      '--migrate-unversioned-running',
      '--dry-run',
      '--reason',
      'test',
    ])

    expect(parsed.address).toBe('temporal.example:7233')
    expect(parsed.namespace).toBe('default')
    expect(parsed.taskQueue).toBe('jangar')
    expect(parsed.deploymentName).toBe('jangar-deployment')
    expect(parsed.migrateStaleRunning).toBe(true)
    expect(parsed.migrateUnversionedRunning).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reason).toBe('test')
  })

  it('extracts versioned workflow poller build IDs', () => {
    const buildIds = __private.extractVersionedPollerBuildIds(
      [
        {
          buildId: 'jangar-deployment:workflow-code@abc123',
          taskQueueType: 'workflow',
          identity: 'worker-1',
        },
        {
          buildId: 'jangar-deployment:workflow-code@abc123',
          taskQueueType: 'activity',
          identity: 'worker-1',
        },
      ],
      'jangar-deployment',
    )

    expect(buildIds).toEqual(['workflow-code@abc123'])
  })

  it('selects a single poller build ID and fails on multiple', () => {
    expect(__private.selectTargetBuildId(['workflow-code@abc123'], 'jangar-deployment')).toBe('workflow-code@abc123')

    expect(() =>
      __private.selectTargetBuildId(['workflow-code@abc123', 'workflow-code@def456'], 'jangar-deployment'),
    ).toThrow('Multiple workflow poller build IDs detected')
  })

  it('strips deployment prefix from poller build ID', () => {
    expect(__private.stripDeploymentPrefix('jangar-deployment:jangar@dev', 'jangar-deployment')).toBe('jangar@dev')
    expect(__private.stripDeploymentPrefix('UNVERSIONED', 'jangar-deployment')).toBeUndefined()
  })

  it('classifies transient temporal connectivity failures', () => {
    expect(__private.isTransientTemporalConnectivityError('failed reaching server: context deadline exceeded')).toBe(
      true,
    )
    expect(__private.isTransientTemporalConnectivityError('rpc error: code = unavailable')).toBe(true)
    expect(__private.isTransientTemporalConnectivityError('unknown namespace')).toBe(false)
  })

  it('retries transient temporal failures before succeeding', async () => {
    const sleepCalls: number[] = []
    Bun.sleep = (async (ms: number) => {
      sleepCalls.push(ms)
    }) as typeof Bun.sleep

    let spawnCount = 0
    Bun.spawn = ((..._args: Parameters<typeof Bun.spawn>) => {
      spawnCount += 1
      if (spawnCount === 1) {
        return {
          stdout: new Blob(['']).stream(),
          stderr: new Blob(['failed reaching server: context deadline exceeded']).stream(),
          exited: Promise.resolve(1),
        } as unknown as ReturnType<typeof Bun.spawn>
      }

      return {
        stdout: new Blob(['{"count":0}']).stream(),
        stderr: new Blob(['']).stream(),
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    const result = await __private.runTemporal({ address: 'temporal.example:7233', namespace: 'default' }, [
      'workflow',
      'count',
      '--query',
      'TaskQueue="jangar"',
      '-o',
      'json',
    ])

    expect(spawnCount).toBe(2)
    expect(sleepCalls).toEqual([__private.getTemporalRetryDelayMs(1)])
    expect(result.stdout).toBe('{"count":0}')
  })

  it('does not retry non-transient temporal failures', async () => {
    let spawnCount = 0
    Bun.spawn = ((..._args: Parameters<typeof Bun.spawn>) => {
      spawnCount += 1
      return {
        stdout: new Blob(['']).stream(),
        stderr: new Blob(['namespace not found']).stream(),
        exited: Promise.resolve(1),
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    await expect(
      __private.runTemporal({ address: 'temporal.example:7233', namespace: 'default' }, [
        'worker',
        'deployment',
        'describe',
        '--name',
        'jangar-deployment',
        '-o',
        'json',
      ]),
    ).rejects.toThrow(/namespace not found/)

    expect(spawnCount).toBe(1)
  })
})
