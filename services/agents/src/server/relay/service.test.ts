import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createRelayRunsService, type RelayRunsDependencies } from './service'
import type { Invocation, Target } from './contract'
import type { Submission, SubmissionStore } from './store'
import type { PrimitivesStore, AgentRunRecord } from '../primitives-store'

const target: Target = {
  id: 'agents/lab',
  name: 'Lab',
  workspaceId: randomUUID(),
  namespace: 'agents',
  namespaceUid: randomUUID(),
  agent: 'codex-agent',
  repository: 'proompteng/lab',
  base: 'main',
  vcsRef: 'github',
  secretBindingRef: 'codex-github-token',
  secrets: ['codex-auth', 'agents-artifacts'],
  timeoutSeconds: 7200,
}
const invocation = (action = 'agents.runs.start'): Invocation => ({
  operationId: randomUUID(),
  clientService: 'opencode',
  actor: 'workload:spiffe://proompteng.ai/ns/opencode/sa/opencode',
  authorizationReceiptId: randomUUID(),
  action,
  resources: [{ kind: 'agents.target', id: target.id, target: '' }],
})

function fixture() {
  const rows = new Map<string, Submission>()
  const projections = new Map<string, AgentRunRecord>()
  const resources = new Map<string, Record<string, unknown>>()
  const submissions: SubmissionStore = {
    reserve: async (input) => {
      const existing = rows.get(input.operation_id)
      if (existing) {
        if (
          existing.request_hash !== input.request_hash ||
          existing.actor !== input.actor ||
          existing.target_id !== input.target_id
        )
          throw new Error('submission identity conflicts')
        return { created: false, submission: existing }
      }
      const row = { ...input, projection_id: null, rejection: null, created_at: new Date() }
      rows.set(row.operation_id, row)
      return { created: true, submission: row }
    },
    get: async (id, workspace, destination) => {
      const row = rows.get(id)
      return row?.workspace_id === workspace && row.target_id === destination ? row : null
    },
    list: async (workspace, destination, limit) =>
      [...rows.values()]
        .filter((row) => row.workspace_id === workspace && row.target_id === destination)
        .slice(0, limit)
        .map((row) => ({ ...row, phase: projections.get(row.operation_id)?.status ?? null })),
    accepted: async (id, projection) => {
      const row = rows.get(id)
      if (row) row.projection_id = projection
    },
    rejected: async (id, status, message) => {
      const row = rows.get(id)
      if (row) row.rejection = { status, message }
    },
  }
  const store = {
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    getAgentRunByDeliveryId: vi.fn(async (id: string) => projections.get(id) ?? null),
    createAgentRun: vi.fn(async (input: Parameters<PrimitivesStore['createAgentRun']>[0]) => {
      const record = {
        ...input,
        externalRunId: input.externalRunId ?? null,
        payload: input.payload ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
        id: randomUUID(),
      }
      projections.set(input.deliveryId, record)
      return record
    }),
  }
  const kube = {
    get: vi.fn(async (kind: string, name: string) =>
      kind === 'namespace' ? { metadata: { uid: target.namespaceUid } } : (resources.get(name) ?? null),
    ),
  }
  const submit = vi.fn(async (request: Request) => {
    const payload = await request.json()
    const resource = {
      metadata: { ...payload.metadata, namespace: target.namespace, uid: randomUUID() },
      status: { phase: 'Pending' },
    }
    resources.set(payload.metadata.name, resource)
    const record = await store.createAgentRun({
      agentName: target.agent,
      deliveryId: request.headers.get('idempotency-key')!,
      provider: 'job',
      status: 'Pending',
      externalRunId: payload.metadata.name,
      payload: { request: payload, resource },
    })
    return Response.json({ agentRun: record, resource }, { status: 201 })
  })
  const read = vi.fn(async (id: string) =>
    Response.json({
      agentRun: { id, status: 'Running' },
      resource: { status: { runner: { telemetry: { heartbeat: 'now' } } } },
    }),
  )
  const cancel = vi.fn(async (_id: string) => Response.json({ agentRun: { status: 'Cancelling' } }, { status: 202 }))
  const logs = vi.fn(async () => Response.json({ logs: 'one line\n', source: 'artifact', truncated: true }))
  const deps: RelayRunsDependencies = {
    submissions,
    primitives: () => store,
    kube,
    submit,
    read,
    cancel,
    logs,
    result: vi.fn(async () => ({ responseText: 'done', responseTruncated: false })),
  }
  return {
    service: createRelayRunsService(deps),
    rows,
    projections,
    resources,
    store,
    kube,
    submit,
    read,
    cancel,
    logs,
    deps,
  }
}

describe('Relay AgentRuns', () => {
  it('submits the intended task once with fixed credentials, repository and runtime bounds', async () => {
    const f = fixture(),
      ctx = invocation()
    const result = await f.service.call('start_run', { task: 'Implement and verify the change' }, ctx, target)
    expect(result).toMatchObject({ runId: ctx.operationId, status: 'Pending' })
    const body = f.rows.get(ctx.operationId)!.request_payload
    expect(body).toMatchObject({
      namespace: 'agents',
      agentRef: { name: target.agent },
      implementation: { text: 'Implement and verify the change' },
      runtime: { type: 'job', config: { activeDeadlineSeconds: 7200 } },
      policy: { secretBindingRef: target.secretBindingRef },
      parameters: { repository: target.repository },
      metadata: { name: `relay-${ctx.operationId}` },
    })
    expect(body.goal).toBeUndefined()
    await Promise.all([
      f.service.call('start_run', { task: 'Implement and verify the change' }, ctx, target),
      f.service.call('start_run', { task: 'Implement and verify the change' }, ctx, target),
    ])
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('rejects raw admin arguments, action substitution and a recreated namespace before submission', async () => {
    const f = fixture()
    await expect(f.service.call('start_run', { task: 'x', namespace: 'ofz' }, invocation(), target)).rejects.toThrow()
    await expect(f.service.call('start_run', { task: 'x' }, invocation('agents.runs.read'), target)).rejects.toThrow(
      'authorized',
    )
    await expect(
      f.service.call('start_run', { task: 'x' }, invocation(), { ...target, namespaceUid: randomUUID() }),
    ).rejects.toThrow('namespace identity')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('rejects changing the task or actor for an existing submission', async () => {
    const f = fixture(),
      ctx = invocation()
    await f.service.call('start_run', { task: 'x' }, ctx, target)
    await expect(f.service.call('start_run', { task: 'different' }, ctx, target)).rejects.toThrow('conflicts')
    await expect(f.service.call('start_run', { task: 'x' }, { ...ctx, actor: 'human:other' }, target)).rejects.toThrow(
      'conflicts',
    )
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('recovers a lost reply from the existing projection without another submission', async () => {
    const f = fixture(),
      ctx = invocation(),
      original = f.submit.getMockImplementation()!
    f.submit.mockImplementation(async (request) => {
      await original(request)
      throw new Error('connection lost after acceptance')
    })
    await expect(f.service.call('start_run', { task: 'x' }, ctx, target)).rejects.toThrow('connection lost')
    const reopened = createRelayRunsService(f.deps)
    expect(
      await reopened.call('get_run', { runId: ctx.operationId }, invocation('agents.runs.read'), target),
    ).toMatchObject({ runId: ctx.operationId, status: 'Running' })
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.rows.get(ctx.operationId)!.projection_id).toBeTruthy()
  })
  it('repairs the projection after Kubernetes acceptance without applying the run again', async () => {
    const f = fixture(),
      ctx = invocation()
    f.submit.mockImplementation(async (request) => {
      const payload = await request.json()
      f.resources.set(payload.metadata.name, {
        metadata: { ...payload.metadata, uid: randomUUID() },
        status: { phase: 'Running' },
      })
      throw new Error('projection commit lost')
    })
    await expect(f.service.call('start_run', { task: 'x' }, ctx, target)).rejects.toThrow()
    expect(
      await f.service.call('get_run', { runId: ctx.operationId }, invocation('agents.runs.read'), target),
    ).toMatchObject({ status: 'Running' })
    expect(f.store.createAgentRun).toHaveBeenCalledTimes(1)
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('links a reconciler-created projection without requiring a submission request on that projection', async () => {
    const f = fixture(),
      ctx = invocation(),
      original = f.submit.getMockImplementation()!
    f.submit.mockImplementation(async (request) => {
      await original(request)
      const record = f.projections.get(ctx.operationId)!
      record.payload = { resource: record.payload.resource, status: { phase: 'Running' } }
      throw new Error('submission projection write lost')
    })
    await expect(f.service.call('start_run', { task: 'x' }, ctx, target)).rejects.toThrow('write lost')
    expect(
      await f.service.call('get_run', { runId: ctx.operationId }, invocation('agents.runs.read'), target),
    ).toMatchObject({ runId: ctx.operationId, status: 'Running' })
    expect(f.rows.get(ctx.operationId)!.projection_id).toBe(f.projections.get(ctx.operationId)!.id)
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('retains uncertainty across restart when no accepted run can be found', async () => {
    const f = fixture(),
      ctx = invocation()
    f.submit.mockRejectedValue(new Error('disconnected'))
    await expect(f.service.call('start_run', { task: 'x' }, ctx, target)).rejects.toThrow()
    const reopened = createRelayRunsService(f.deps)
    expect(
      await reopened.call('get_run', { runId: ctx.operationId }, invocation('agents.runs.read'), target),
    ).toMatchObject({ status: 'Unconfirmed' })
    await reopened.call('start_run', { task: 'x' }, ctx, target)
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('does not disclose or cancel runs from a different workspace', async () => {
    const f = fixture(),
      ctx = invocation()
    await f.service.call('start_run', { task: 'x' }, ctx, target)
    const other = { ...target, workspaceId: randomUUID() }
    for (const name of ['get_run', 'cancel_run', 'read_logs', 'get_result'] as const) {
      const action =
        name === 'cancel_run' ? 'agents.runs.cancel' : name === 'read_logs' ? 'agents.runs.logs' : 'agents.runs.read'
      await expect(f.service.call(name, { runId: ctx.operationId }, invocation(action), other)).rejects.toThrow(
        'not found',
      )
    }
    expect(await f.service.call('list_runs', {}, invocation('agents.runs.read'), other)).toEqual({ runs: [] })
    expect(f.cancel).not.toHaveBeenCalled()
  })
  it('cancels the original projection and preserves bounded retained logs', async () => {
    const f = fixture(),
      ctx = invocation()
    await f.service.call('start_run', { task: 'x' }, ctx, target)
    const id = f.rows.get(ctx.operationId)!.projection_id
    expect(
      await f.service.call('cancel_run', { runId: ctx.operationId }, invocation('agents.runs.cancel'), target),
    ).toMatchObject({ status: 'Cancelling' })
    expect(f.cancel.mock.calls[0]?.[0]).toBe(id)
    expect(
      await f.service.call('read_logs', { runId: ctx.operationId, lines: 1 }, invocation('agents.runs.logs'), target),
    ).toMatchObject({ logs: 'one line\n', truncated: true })
    await expect(
      f.service.call('read_logs', { runId: ctx.operationId, lines: 501 }, invocation('agents.runs.logs'), target),
    ).rejects.toThrow()
  })
})
