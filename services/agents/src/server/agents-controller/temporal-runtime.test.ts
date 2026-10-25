import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTemporalRuntimeTools } from '~/server/agents-controller/temporal-runtime'

const buildDeps = () => {
  const start = vi.fn().mockResolvedValue({ workflowId: 'wf-1', namespace: 'temporal', runId: 'run-1' })
  const result = vi.fn().mockResolvedValue(undefined)
  const getTemporalClient = vi.fn().mockResolvedValue({
    workflow: {
      start,
      result,
    },
  })
  const resolveParameters = vi.fn().mockReturnValue({ topic: 'docs' })
  const buildRunSpec = vi.fn().mockReturnValue({ run: true })
  const setStatus = vi.fn().mockResolvedValue(undefined)
  const buildConditions = vi.fn().mockReturnValue([])

  return {
    deps: {
      getTemporalClient,
      resolveParameters,
      buildRunSpec,
      makeName: (base: string, suffix: string) => `${base}-${suffix}`,
      buildConditions,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      setStatus,
    },
    mocks: {
      start,
      result,
      getTemporalClient,
      resolveParameters,
      buildRunSpec,
      setStatus,
      buildConditions,
    },
  }
}

describe('agents controller temporal-runtime module', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits custom runtime request and returns custom runtime ref', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ accepted: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { deps } = buildDeps()
    const { submitCustomRun } = createTemporalRuntimeTools(deps)
    const runtimeRef = await submitCustomRun(
      { spec: { runtime: { config: { endpoint: 'https://runner.internal/submit' } } } },
      { text: 'impl' },
      null,
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runner.internal/submit',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(runtimeRef).toEqual({
      type: 'custom',
      name: 'https://runner.internal/submit',
      namespace: 'external',
      response: { accepted: true },
    })
  })

  it('throws when temporal runtime config is missing required fields', async () => {
    const { deps } = buildDeps()
    const { submitTemporalRun } = createTemporalRuntimeTools(deps)

    await expect(
      submitTemporalRun({ spec: { runtime: { config: { taskQueue: 'q' } } } }, {}, {}, {}, null),
    ).rejects.toThrow('spec.runtime.config.workflowType is required for temporal runtime')
  })

  it('starts temporal workflow with generated payload and workflow id', async () => {
    const { deps, mocks } = buildDeps()
    const { submitTemporalRun } = createTemporalRuntimeTools(deps)

    const runtimeRef = await submitTemporalRun(
      {
        metadata: { name: 'run-42' },
        spec: { runtime: { config: { workflowType: 'MyWorkflow', taskQueue: 'agents-queue' } } },
      },
      { metadata: { name: 'agent-a' } },
      { metadata: { name: 'provider-a' }, spec: { outputArtifacts: [{ name: 'log' }] } },
      { text: 'impl' },
      null,
    )

    expect(mocks.buildRunSpec).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { topic: 'docs' },
      null,
      [{ name: 'log' }],
      'provider-a',
      undefined,
      null,
    )
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'MyWorkflow',
        taskQueue: 'agents-queue',
        workflowId: 'run-42-temporal',
      }),
    )
    expect(runtimeRef).toEqual({
      type: 'temporal',
      name: 'wf-1',
      namespace: 'temporal',
      workflowId: 'wf-1',
      runId: 'run-1',
      taskQueue: 'agents-queue',
    })
  })

  it('marks temporal runtime as succeeded when result resolves', async () => {
    const { deps, mocks } = buildDeps()
    const { reconcileTemporalRun } = createTemporalRuntimeTools(deps)

    await reconcileTemporalRun(
      { patchStatus: vi.fn() },
      { metadata: { generation: 2 }, status: { vcs: { repository: 'owner/repo' } } },
      { type: 'temporal', name: 'wf-1', workflowId: 'wf-1', runId: 'run-1', namespace: 'temporal' },
    )

    expect(mocks.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        phase: 'Succeeded',
      }),
    )
  })

  it('treats temporal poll timeout errors as pending and leaves status unchanged', async () => {
    const { deps, mocks } = buildDeps()
    mocks.result.mockRejectedValue(new Error('deadline exceeded'))
    const { reconcileTemporalRun } = createTemporalRuntimeTools(deps)

    await reconcileTemporalRun(
      { patchStatus: vi.fn() },
      { metadata: { generation: 1 } },
      { type: 'temporal', name: 'wf-1', workflowId: 'wf-1' },
    )

    expect(mocks.setStatus).not.toHaveBeenCalled()
  })
})
