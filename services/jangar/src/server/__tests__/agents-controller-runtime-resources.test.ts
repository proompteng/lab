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

  it('deletes runtime resources and throws on kubectl failure', async () => {
    const runKubectl = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    await deleteRuntimeResource(runKubectl, 'job', 'run-1', 'agents')
    expect(runKubectl).toHaveBeenCalledWith(['delete', 'job', 'run-1', '-n', 'agents'])

    const failed = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' })
    await expect(deleteRuntimeResource(failed, 'job', 'run-1', 'agents')).rejects.toThrow('boom')
  })

  it('cancels job runtime by deleting job', async () => {
    const runKubectl = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    await cancelRuntime({ runtimeRef: { type: 'job', name: 'run-1' }, namespace: 'agents', runKubectl })

    expect(runKubectl).toHaveBeenCalledWith(['delete', 'job', 'run-1', '-n', 'agents'])
  })

  it('cancels workflow runtime by deleting labeled jobs', async () => {
    const runKubectl = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    await cancelRuntime({ runtimeRef: { type: 'workflow', name: 'run-1' }, namespace: 'agents', runKubectl })

    expect(runKubectl).toHaveBeenCalledWith([
      'delete',
      'job',
      '-n',
      'agents',
      '-l',
      'agents.proompteng.ai/agent-run=run-1',
      '--ignore-not-found',
    ])
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
      runKubectl: vi.fn(),
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
    const runKubectl = vi.fn()
    await cancelRuntime({ runtimeRef: { type: 'job' }, namespace: 'agents', runKubectl })
    expect(runKubectl).not.toHaveBeenCalled()
  })
})
