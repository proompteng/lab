import { describe, expect, it } from 'bun:test'

import { __private } from '../sync-temporal-routing'

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
})
