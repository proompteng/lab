import { describe, expect, it, vi } from 'vitest'

import {
  buildRuntimeRef,
  cancelRuntime,
  deleteRuntimeResource,
  parseRuntimeRef,
} from '~/server/agents-controller/runtime-resources'

describe('agents controller runtime-resources module', () => {
  it('parses and builds runtime references', () => {
    expect(parseRuntimeRef({ type: 'job', name: 'run-1' })).toEqual({ type: 'job', name: 'run-1' })
    expect(parseRuntimeRef(null)).toBeNull()
    expect(parseRuntimeRef('bad')).toBeNull()

    expect(buildRuntimeRef('job', 'run-1', 'agents', { uid: 'abc' })).toEqual({
      type: 'job',
      name: 'run-1',
      namespace: 'agents',
      uid: 'abc',
    })
  })

  it('deletes runtime resources through the kube client', async () => {
    const kube = {
      delete: vi.fn().mockResolvedValue({}),
    }
    await deleteRuntimeResource(kube, 'job', 'run-1', 'agents')
    expect(kube.delete).toHaveBeenCalledWith('job', 'run-1', 'agents', { wait: false })
  })

  it('cancels job runtime by deleting job', async () => {
    const kube = {
      delete: vi.fn().mockResolvedValue({}),
      list: vi.fn(),
    }
    await cancelRuntime({ runtimeRef: { type: 'job', name: 'run-1' }, namespace: 'agents', kube })

    expect(kube.delete).toHaveBeenCalledWith('job', 'run-1', 'agents', { wait: false })
  })

  it('cancels workflow runtime by deleting listed workflow jobs', async () => {
    const kube = {
      delete: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({
        items: [{ metadata: { name: 'run-1-a' } }, { metadata: { name: 'run-1-b' } }],
      }),
    }
    await cancelRuntime({ runtimeRef: { type: 'workflow', name: 'run-1' }, namespace: 'agents', kube })

    expect(kube.list).toHaveBeenCalledWith('jobs.batch', 'agents', 'agents.proompteng.ai/agent-run=run-1')
    expect(kube.delete).toHaveBeenNthCalledWith(1, 'job', 'run-1-a', 'agents', { wait: false })
    expect(kube.delete).toHaveBeenNthCalledWith(2, 'job', 'run-1-b', 'agents', { wait: false })
  })

  it('cancels temporal runtime using temporal client', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const getTemporalClient = vi.fn().mockResolvedValue({ workflow: { cancel } })

    await cancelRuntime({
      runtimeRef: {
        type: 'temporal',
        name: 'fallback-workflow-id',
        workflowId: 'wf-1',
        runId: 'run-123',
        namespace: 'temporal-ns',
      },
      namespace: 'agents',
      kube: { delete: vi.fn(), list: vi.fn() },
      getTemporalClient,
    })

    expect(getTemporalClient).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      runId: 'run-123',
      namespace: 'temporal-ns',
    })
  })

  it('returns early when runtime reference has no name', async () => {
    const kube = { delete: vi.fn(), list: vi.fn() }
    await cancelRuntime({ runtimeRef: { type: 'job' }, namespace: 'agents', kube })
    expect(kube.delete).not.toHaveBeenCalled()
    expect(kube.list).not.toHaveBeenCalled()
  })
})
