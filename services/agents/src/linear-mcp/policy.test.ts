import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import type { LinearMcpRunIdentity } from './identity'
import { createLinearMcpPolicyService } from './policy'
import type { LinearMutationReceipt, LinearMutationReceiptStore } from './receipts'
import type { LinearUpstream } from './upstream'

const ISSUE_UUID = '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9'

const identity: LinearMcpRunIdentity = {
  namespace: 'agents',
  podName: 'run-pod',
  podUid: 'pod-uid-1',
  jobName: 'run-job',
  jobUid: 'job-uid-1',
  agentRunName: 'linear-run',
  agentRunUid: 'run-uid-1',
  agentName: 'codex-linear-agent',
  providerName: 'codex-linear',
  issueIdentifier: 'PROOMPT-123',
  issueUuid: ISSUE_UUID,
  issueUrl: 'https://linear.app/issue/PROOMPT-123',
  phase: 'Running',
}

const issueResult = (options: { labels?: string[]; identifier?: string; status?: string } = {}): CallToolResult => ({
  content: [],
  structuredContent: {
    id: ISSUE_UUID,
    identifier: options.identifier ?? 'PROOMPT-123',
    team: { id: 'team-uuid-1', key: 'PROOMPT' },
    labels: (options.labels ?? ['agentrun']).map((name) => ({ name })),
    status: { name: options.status ?? 'In Progress' },
  },
})

const statusResult = (): CallToolResult => ({
  content: [],
  structuredContent: {
    nodes: [
      { id: 'status-done', name: 'Done' },
      { id: 'status-progress', name: 'In Progress' },
    ],
  },
})

const mutationResult = (id: string): CallToolResult => ({
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { id },
})

const createUpstream = (overrides: Partial<LinearUpstream> = {}) =>
  ({
    checkContract: vi.fn(),
    getIssue: vi.fn(async () => issueResult()),
    listComments: vi.fn(async () => ({ content: [], structuredContent: { nodes: [] } })),
    listIssueStatuses: vi.fn(async () => statusResult()),
    createComment: vi.fn(async () => mutationResult('comment-uuid-1')),
    updateIssueStatus: vi.fn(async () => mutationResult(ISSUE_UUID)),
    close: vi.fn(),
    ...overrides,
  }) as LinearUpstream

const createReceiptStore = (): LinearMutationReceiptStore & { values: Map<string, LinearMutationReceipt> } => {
  const values = new Map<string, LinearMutationReceipt>()
  return {
    values,
    reserve: async (input) => {
      const key = `${input.agentRunUid}:${input.tool}:${input.canonicalArgumentHash}`
      const current = values.get(key)
      if (current) return { created: false, receipt: current }
      const receipt: LinearMutationReceipt = {
        id: key,
        agent_run_uid: input.agentRunUid,
        agent_run_name: input.agentRunName,
        agent_run_namespace: input.namespace,
        issue_uuid: input.issueUuid,
        issue_identifier: input.issueIdentifier,
        tool: input.tool,
        canonical_argument_hash: input.canonicalArgumentHash,
        state: 'preparing',
        attempt_count: 0,
        sanitized_result_id: null,
        last_error_code: null,
        requested_at: new Date(),
        started_at: null,
        completed_at: null,
        updated_at: new Date(),
      }
      values.set(key, receipt)
      return { created: true, receipt }
    },
    claim: async (id) => {
      const current = values.get(id)
      if (!current || current.state !== 'preparing') return null
      const next = { ...current, state: 'in_flight', attempt_count: current.attempt_count + 1, started_at: new Date() }
      values.set(id, next)
      return next
    },
    get: async (id) => values.get(id) ?? null,
    succeed: async (id, resultId) => {
      const current = values.get(id)!
      values.set(id, { ...current, state: 'succeeded', sanitized_result_id: resultId, completed_at: new Date() })
    },
    indeterminate: async (id, code) => {
      const current = values.get(id)!
      values.set(id, { ...current, state: 'indeterminate', last_error_code: code, completed_at: new Date() })
    },
  }
}

const context = {
  identity,
  revalidateIdentity: vi.fn(async () => identity),
}

const service = (upstream: LinearUpstream, receipts = createReceiptStore()) => ({
  policy: createLinearMcpPolicyService({
    upstream,
    receipts,
    triggerLabel: 'agentrun',
    actorId: 'linear-app-actor-1',
  }),
  receipts,
})

describe('Linear MCP source-bound policy', () => {
  it('injects the source issue identifier into every read', async () => {
    const upstream = createUpstream()
    const { policy } = service(upstream)

    await policy.call('get_issue', {}, context)
    await policy.call('list_comments', {}, context)
    await policy.call('list_issue_statuses', {}, context)

    expect(upstream.getIssue).toHaveBeenCalledWith(ISSUE_UUID)
    expect(upstream.listComments).toHaveBeenCalledWith(ISSUE_UUID)
    expect(upstream.listIssueStatuses).toHaveBeenCalledWith('team-uuid-1')
  })

  it('derives a team returned as a direct string without persisting or accepting it from the caller', async () => {
    const upstream = createUpstream({
      getIssue: vi.fn(async () => ({
        content: [],
        structuredContent: {
          id: 'PROOMPT-123',
          team: 'PROOMPT',
          labels: ['agentrun'],
          status: 'In Progress',
        },
      })),
    })
    const { policy } = service(upstream)

    await policy.call('list_issue_statuses', {}, context)

    expect(upstream.listIssueStatuses).toHaveBeenCalledWith('PROOMPT')
  })

  it('accepts the current Linear issue response shape after exact UUID lookup', async () => {
    const upstream = createUpstream({
      getIssue: vi.fn(async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: 'PROOMPT-123',
              title: 'Source-bound issue',
              team: 'proompteng',
              teamId: 'd72e1619-5333-4258-b2b2-09d8822101bb',
              labels: ['agentrun'],
              status: 'In Progress',
            }),
          },
        ],
      })),
    })
    const { policy } = service(upstream)

    await expect(policy.call('get_issue', {}, context)).resolves.toMatchObject({
      content: [expect.objectContaining({ type: 'text' })],
    })
    expect(upstream.getIssue).toHaveBeenCalledWith(ISSUE_UUID)
  })

  it('rejects a mismatched upstream issue before returning or mutating it', async () => {
    const upstream = createUpstream({ getIssue: vi.fn(async () => issueResult({ identifier: 'PROOMPT-999' })) })
    const { policy } = service(upstream)

    await expect(policy.call('get_issue', {}, context)).rejects.toMatchObject({
      code: 'issue_mismatch',
    })
    expect(upstream.createComment).not.toHaveBeenCalled()
    expect(upstream.updateIssueStatus).not.toHaveBeenCalled()
  })

  it('performs zero upstream mutation when the agentrun label has been removed', async () => {
    const upstream = createUpstream({ getIssue: vi.fn(async () => issueResult({ labels: [] })) })
    const { policy, receipts } = service(upstream)

    await expect(policy.call('create_comment', { body: 'implementation complete' }, context)).rejects.toMatchObject({
      code: 'label_revoked',
    })
    expect(upstream.createComment).not.toHaveBeenCalled()
    expect(receipts.values.size).toBe(0)
  })

  it('only accepts statuses from the source issue workflow', async () => {
    const upstream = createUpstream()
    const { policy } = service(upstream)

    await expect(policy.call('update_issue', { status: 'Secret Project Status' }, context)).rejects.toMatchObject({
      code: 'status_invalid',
    })
    expect(upstream.updateIssueStatus).not.toHaveBeenCalled()
  })

  it('deduplicates a successful comment mutation through its durable receipt', async () => {
    const upstream = createUpstream()
    const { policy } = service(upstream)

    await policy.call('create_comment', { body: 'implementation complete' }, context)
    const replay = await policy.call('create_comment', { body: 'implementation complete' }, context)

    expect(upstream.createComment).toHaveBeenCalledTimes(1)
    expect(replay.structuredContent).toMatchObject({ state: 'succeeded', resultId: 'comment-uuid-1' })
  })

  it('does not reconcile a concurrent mutation while its first request is still in flight', async () => {
    let completeMutation: ((value: CallToolResult) => void) | undefined
    const upstream = createUpstream({
      createComment: vi.fn(
        () =>
          new Promise<CallToolResult>((resolve) => {
            completeMutation = resolve
          }),
      ),
    })
    const { policy } = service(upstream)

    const first = policy.call('create_comment', { body: 'implementation complete' }, context)
    await vi.waitFor(() => expect(upstream.createComment).toHaveBeenCalledOnce())

    await expect(policy.call('create_comment', { body: 'implementation complete' }, context)).rejects.toMatchObject({
      code: 'mutation_in_progress',
    })
    expect(upstream.listComments).not.toHaveBeenCalled()

    completeMutation?.(mutationResult('comment-uuid-1'))
    await expect(first).resolves.toMatchObject({ structuredContent: { id: 'comment-uuid-1' } })
  })

  it('marks an unprovable comment write indeterminate and blocks blind retries', async () => {
    const upstream = createUpstream({
      createComment: vi.fn(async () => {
        throw new Error('upstream timeout')
      }),
    })
    const { policy, receipts } = service(upstream)

    await expect(policy.call('create_comment', { body: 'implementation complete' }, context)).rejects.toMatchObject({
      code: 'indeterminate_write',
    })
    expect([...receipts.values.values()][0]?.state).toBe('indeterminate')

    await expect(policy.call('create_comment', { body: 'implementation complete' }, context)).rejects.toMatchObject({
      code: 'indeterminate_write',
    })
    expect(upstream.createComment).toHaveBeenCalledTimes(1)
  })

  it('reconciles a comment returned with the current author shape', async () => {
    const body = 'implementation complete'
    const upstream = createUpstream({
      createComment: vi.fn(async () => {
        throw new Error('upstream timeout')
      }),
      listComments: vi.fn(async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              comments: [
                {
                  id: 'comment-uuid-1',
                  body,
                  createdAt: new Date().toISOString(),
                  author: { id: 'linear-app-actor-1', name: 'Linear MCP' },
                },
              ],
            }),
          },
        ],
      })),
    })
    const { policy, receipts } = service(upstream)

    const result = await policy.call('create_comment', { body }, context)

    expect(result.structuredContent).toMatchObject({ state: 'succeeded', resultId: 'comment-uuid-1' })
    expect([...receipts.values.values()][0]?.state).toBe('succeeded')
    expect(upstream.listComments).toHaveBeenCalledWith(ISSUE_UUID)
  })

  it('maps an allowed status to the source issue without accepting caller issue fields', async () => {
    const upstream = createUpstream()
    const { policy } = service(upstream)

    await policy.call('update_issue', { status: 'status-done' }, context)

    expect(upstream.updateIssueStatus).toHaveBeenCalledWith(ISSUE_UUID, 'Done')
  })
})
