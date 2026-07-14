import { afterEach, describe, expect, it } from 'bun:test'
import { RoutingConfigUpdateState } from '@proompteng/temporal-bun-sdk/worker'

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
      '--build-id',
      'jangar@new',
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
    expect(parsed.buildId).toBe('jangar@new')
    expect(parsed.migrateStaleRunning).toBe(true)
    expect(parsed.migrateUnversionedRunning).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reason).toBe('test')
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

  it('uses an explicit SDK build ID and waits for routing propagation', async () => {
    Bun.sleep = (async () => undefined) as typeof Bun.sleep

    const responses = [
      {
        workerDeploymentInfo: {
          routingConfig: { currentDeploymentVersion: { buildId: 'jangar@old' } },
          routingConfigUpdateState: RoutingConfigUpdateState.COMPLETED,
          versionSummaries: [
            { deploymentVersion: { buildId: 'jangar@old' } },
            { deploymentVersion: { buildId: 'jangar@new' } },
          ],
        },
      },
      {
        workerDeploymentInfo: {
          routingConfig: { currentDeploymentVersion: { buildId: 'jangar@new' } },
          routingConfigUpdateState: RoutingConfigUpdateState.COMPLETED,
          versionSummaries: [],
        },
      },
    ]
    const setRequests: unknown[] = []
    const client = {
      deployments: {
        describeWorkerDeployment: async () => responses.shift() as never,
        setWorkerDeploymentCurrentVersion: async (request: unknown) => {
          setRequests.push(request)
          return {} as never
        },
      },
    }

    const options = __private.resolveOptions({
      address: 'temporal.example:7233',
      namespace: 'default',
      taskQueue: 'jangar',
      deploymentName: 'jangar-deployment',
      buildId: 'jangar@new',
    })
    const result = await __private.syncCurrentVersion(options, client as never)

    expect(result).toMatchObject({
      changed: true,
      previousBuildId: 'jangar@old',
      targetBuildId: 'jangar@new',
    })
    expect(setRequests).toEqual([
      {
        deploymentName: 'jangar-deployment',
        buildId: 'jangar@new',
        allowNoPollers: false,
        ignoreMissingTaskQueues: false,
        identity: `sync-temporal-routing/${process.pid}`,
      },
    ])
  })

  it('verifies the worker-selected current build without a Temporal CLI fallback', async () => {
    const client = {
      deployments: {
        describeWorkerDeployment: async () =>
          ({
            workerDeploymentInfo: {
              routingConfig: { currentDeploymentVersion: { buildId: 'jangar@current' } },
              routingConfigUpdateState: RoutingConfigUpdateState.COMPLETED,
              versionSummaries: [{ deploymentVersion: { buildId: 'jangar@current' } }],
            },
          }) as never,
        setWorkerDeploymentCurrentVersion: async () => {
          throw new Error('should not set routing')
        },
      },
    }

    const result = await __private.syncCurrentVersion(
      __private.resolveOptions({
        address: 'temporal.example:7233',
        namespace: 'default',
        taskQueue: 'jangar',
        deploymentName: 'jangar-deployment',
      }),
      client as never,
    )

    expect(result).toMatchObject({
      changed: false,
      previousBuildId: 'jangar@current',
      targetBuildId: 'jangar@current',
    })
  })

  it('normalizes legacy deployment versions before selecting stale builds', async () => {
    const client = {
      deployments: {
        describeWorkerDeployment: async () =>
          ({
            workerDeploymentInfo: {
              routingConfig: { currentVersion: 'jangar-deployment.jangar@current' },
              routingConfigUpdateState: RoutingConfigUpdateState.COMPLETED,
              versionSummaries: [
                { version: 'jangar-deployment.jangar@old' },
                { version: 'jangar-deployment.jangar@current' },
              ],
            },
          }) as never,
        setWorkerDeploymentCurrentVersion: async () => {
          throw new Error('should not set routing')
        },
      },
    }

    const result = await __private.syncCurrentVersion(
      __private.resolveOptions({
        address: 'temporal.example:7233',
        namespace: 'default',
        taskQueue: 'jangar',
        deploymentName: 'jangar-deployment',
      }),
      client as never,
    )

    expect(result).toMatchObject({
      changed: false,
      previousBuildId: 'jangar@current',
      targetBuildId: 'jangar@current',
      deploymentBuildIds: ['jangar@old', 'jangar@current'],
    })
    expect(result.deploymentBuildIds.filter((buildId) => buildId !== result.targetBuildId)).toEqual(['jangar@old'])
  })
})
