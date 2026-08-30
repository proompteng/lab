import { describe, expect, it, vi } from 'vitest'

import { reconcileRuntimeDebris } from './runtime-debris'

const staleCreatedAt = '2026-05-31T00:00:00.000Z'
const freshCreatedAt = '2026-05-31T23:45:00.000Z'
const nowMs = Date.parse('2026-06-01T00:00:00.000Z')

const buildPod = (
  name: string,
  overrides: {
    createdAt?: Date | string
    deletionTimestamp?: string
    labels?: Record<string, string>
    ownerReferences?: Array<Record<string, unknown>>
    phase?: string
  } = {},
) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name,
    namespace: 'agents',
    creationTimestamp: overrides.createdAt ?? staleCreatedAt,
    ...(overrides.deletionTimestamp ? { deletionTimestamp: overrides.deletionTimestamp } : {}),
    labels: {
      'agents.proompteng.ai/agent-run': 'run-1',
      ...overrides.labels,
    },
    ...(overrides.ownerReferences ? { ownerReferences: overrides.ownerReferences } : {}),
  },
  status: {
    phase: overrides.phase ?? 'Succeeded',
  },
})

const buildJob = (name: string) => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name,
    namespace: 'agents',
    labels: {
      'agents.proompteng.ai/agent-run': 'run-1',
    },
  },
})

const buildKube = (pods: Record<string, unknown>[], jobs: Record<string, unknown>[] = []) => ({
  list: vi.fn(async (resource: string) => {
    if (resource === 'pods') return { items: pods }
    if (resource === 'jobs') return { items: jobs }
    return { items: [] }
  }),
  delete: vi.fn(async () => ({})),
})

describe('runtime debris cleanup', () => {
  it('audits stale terminal orphan Pods without deleting them', async () => {
    const kube = buildKube([buildPod('orphan-old')])

    const summary = await reconcileRuntimeDebris({
      config: {
        maxDeletesPerNamespace: 25,
        mode: 'audit',
        orphanPodRetentionSeconds: 3600,
      },
      kube: kube as never,
      namespace: 'agents',
      nowMs,
    })

    expect(kube.delete).not.toHaveBeenCalled()
    expect(summary).toMatchObject({
      deletedPods: 0,
      mode: 'audit',
      orphanTerminalPods: 1,
      scannedPods: 1,
    })
  })

  it('treats Kubernetes client Date creation timestamps as stale candidates', async () => {
    const kube = buildKube([buildPod('orphan-old-date', { createdAt: new Date(staleCreatedAt) })])

    const summary = await reconcileRuntimeDebris({
      config: {
        maxDeletesPerNamespace: 25,
        mode: 'audit',
        orphanPodRetentionSeconds: 3600,
      },
      kube: kube as never,
      namespace: 'agents',
      nowMs,
    })

    expect(summary).toMatchObject({
      mode: 'audit',
      orphanTerminalPods: 1,
      scannedPods: 1,
    })
  })

  it('deletes only stale terminal Pods without a valid Job owner', async () => {
    const pods = [
      buildPod('orphan-old'),
      buildPod('fresh-terminal', { createdAt: freshCreatedAt }),
      buildPod('running-orphan', { phase: 'Running' }),
      buildPod('terminating-orphan', { deletionTimestamp: '2026-05-31T23:59:00.000Z' }),
      buildPod('owned-by-existing-job', {
        ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'job-owned', uid: 'job-owned-uid' }],
      }),
      buildPod('owned-by-missing-job', {
        ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'job-missing', uid: 'job-missing-uid' }],
      }),
    ]
    const kube = buildKube(pods, [buildJob('job-owned')])

    const summary = await reconcileRuntimeDebris({
      config: {
        maxDeletesPerNamespace: 25,
        mode: 'delete',
        orphanPodRetentionSeconds: 3600,
      },
      kube: kube as never,
      namespace: 'agents',
      nowMs,
    })

    expect(kube.delete).toHaveBeenCalledTimes(2)
    expect(kube.delete).toHaveBeenNthCalledWith(1, 'pod', 'orphan-old', 'agents', { wait: false })
    expect(kube.delete).toHaveBeenNthCalledWith(2, 'pod', 'owned-by-missing-job', 'agents', { wait: false })
    expect(summary).toMatchObject({
      deletedPods: 2,
      mode: 'delete',
      orphanTerminalPods: 2,
      scannedPods: 6,
    })
  })

  it('rate limits deletes per namespace while reporting all candidates', async () => {
    const kube = buildKube([buildPod('orphan-1'), buildPod('orphan-2'), buildPod('orphan-3')])

    const summary = await reconcileRuntimeDebris({
      config: {
        maxDeletesPerNamespace: 2,
        mode: 'delete',
        orphanPodRetentionSeconds: 3600,
      },
      kube: kube as never,
      namespace: 'agents',
      nowMs,
    })

    expect(kube.delete).toHaveBeenCalledTimes(2)
    expect(kube.delete).toHaveBeenNthCalledWith(1, 'pod', 'orphan-1', 'agents', { wait: false })
    expect(kube.delete).toHaveBeenNthCalledWith(2, 'pod', 'orphan-2', 'agents', { wait: false })
    expect(summary).toMatchObject({
      deletedPods: 2,
      orphanTerminalPods: 3,
      rateLimitedPods: 1,
    })
  })
})
