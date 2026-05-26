import { Effect, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import type {
  AgentsAgentRunGetInput,
  AgentsAgentRunListInput,
  AgentsAgentRunLogsInput,
  AgentsAgentRunResourceListInput,
  AgentsAgentRunRerunSubmitInput,
  AgentsAgentRunSubmitInput,
  AgentsAgentRunTerminalEventAckInput,
  AgentsAgentRunTerminalEventsListInput,
  AgentsMemoryNoteRecord,
} from '@proompteng/agent-contracts'

import {
  AgentRunsMcp,
  handleMcpRequestEffect,
  MemoryNotesMcp,
  type AgentRunsMcpService,
  type MemoryNotesMcpService,
} from './mcp'

const makeService = (): { service: MemoryNotesMcpService; saved: AgentsMemoryNoteRecord[] } => {
  const saved: AgentsMemoryNoteRecord[] = []

  const service: MemoryNotesMcpService = {
    persist: ({ namespace, content, summary, tags, metadata }) =>
      Effect.sync(() => {
        const record: AgentsMemoryNoteRecord = {
          id: `mem-${saved.length + 1}`,
          namespace: namespace ?? 'default',
          content,
          summary: summary ?? null,
          tags: tags ?? [],
          metadata: metadata ?? {},
          createdAt: new Date().toISOString(),
        }
        saved.push(record)
        return record
      }),
    retrieve: ({ namespace, query, limit }) =>
      Effect.sync(() =>
        saved
          .filter((mem) => (namespace ? mem.namespace === namespace : true))
          .filter((mem) => mem.content.includes(query) || (mem.summary ?? '').includes(query))
          .slice(0, limit ?? 10),
      ),
  }

  return { service, saved }
}

const makeAgentRunsService = () => {
  const calls: Record<string, unknown[]> = {
    create: [],
    list: [],
    get: [],
    listResources: [],
    getLogs: [],
    listTerminalEvents: [],
    ackTerminalEvent: [],
    rerun: [],
  }

  const service: AgentRunsMcpService = {
    create: (input: AgentsAgentRunSubmitInput) =>
      Effect.sync(() => {
        calls.create.push(input)
        return {
          ok: true,
          agentRun: { id: 'run-1', deliveryId: input.deliveryId, externalRunId: 'mcp-smoke-run' },
          resource: { kind: 'AgentRun', metadata: { name: 'mcp-smoke-run', namespace: 'agents' } },
        }
      }),
    list: (input: AgentsAgentRunListInput) =>
      Effect.sync(() => {
        calls.list.push(input)
        return { ok: true, runs: [{ id: 'run-1', status: 'Running', externalRunId: 'mcp-smoke-run' }] }
      }),
    get: (input: AgentsAgentRunGetInput) =>
      Effect.sync(() => {
        calls.get.push(input)
        return { ok: true, agentRun: { id: input.id, externalRunId: 'mcp-smoke-run' }, resource: null }
      }),
    listResources: (input: AgentsAgentRunResourceListInput) =>
      Effect.sync(() => {
        calls.listResources.push(input)
        return { ok: true, items: [{ kind: 'AgentRun', metadata: { name: 'mcp-smoke-run' } }] }
      }),
    getLogs: (input: AgentsAgentRunLogsInput) =>
      Effect.sync(() => {
        calls.getLogs.push(input)
        return {
          ok: true,
          name: input.name,
          namespace: input.namespace,
          pod: 'mcp-smoke-pod',
          container: 'agent-runner',
          tailLines: input.tailLines ?? null,
          pods: [],
          logs: 'line-4\nline-5\n',
        }
      }),
    listTerminalEvents: (input: AgentsAgentRunTerminalEventsListInput) =>
      Effect.sync(() => {
        calls.listTerminalEvents.push(input)
        return {
          ok: true,
          namespace: input.namespace ?? 'agents',
          consumer: input.consumer ?? null,
          total: 1,
          events: [{ eventId: 'agents/mcp-smoke-run/uid/Succeeded', phase: 'Succeeded' }],
        }
      }),
    ackTerminalEvent: (input: AgentsAgentRunTerminalEventAckInput) =>
      Effect.sync(() => {
        calls.ackTerminalEvent.push(input)
        return { ok: true, eventId: input.eventId, consumer: input.consumer }
      }),
    rerun: (input: AgentsAgentRunRerunSubmitInput) =>
      Effect.sync(() => {
        calls.rerun.push(input)
        return { ok: true, idempotent: false, agentRun: { id: input.agentRunId } }
      }),
  }

  return { service, calls }
}

const post = async (
  service: MemoryNotesMcpService,
  body: unknown,
  headers: Record<string, string> = {},
  agentRunsService: AgentRunsMcpService = makeAgentRunsService().service,
) => {
  const request = new Request('http://agents.local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  const response = await Effect.runPromise(
    pipe(
      handleMcpRequestEffect(request),
      Effect.provideService(MemoryNotesMcp, service),
      Effect.provideService(AgentRunsMcp, agentRunsService),
    ),
  )
  const json = response.status === 202 || response.status === 204 ? null : await response.json()
  return { response, json }
}

describe('Agents MCP handler', () => {
  it('supports initialize + tools/list', async () => {
    const { service } = makeService()

    const init = await post(service, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init.response.status).toBe(200)
    expect(init.json?.result?.serverInfo?.name).toBe('agents-control-plane')

    const list = await post(service, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.response.status).toBe(200)
    const tools = list.json?.result?.tools as Array<{
      name: string
      description?: string
      inputSchema?: { properties?: Record<string, unknown> }
    }>
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'persist_memory',
        'retrieve_memory',
        'create_agent_run',
        'list_agent_runs',
        'get_agent_run',
        'list_agent_run_resources',
        'get_agent_run_logs',
        'list_agent_run_terminal_events',
        'ack_agent_run_terminal_event',
        'rerun_agent_run',
      ]),
    )
    const createTool = tools.find((tool) => tool.name === 'create_agent_run')
    expect(createTool?.description).toContain('secretBindingRef')
    expect(createTool?.description).toContain('payload.parameters.repository')
    expect(createTool?.inputSchema?.properties?.secretBindingRef).toBeDefined()
  })

  it('supports resources/list + resources/templates/list', async () => {
    const { service } = makeService()

    const resources = await post(service, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    expect(resources.response.status).toBe(200)
    expect(resources.json?.result?.resources?.[0]?.uri).toBe('agents://config')

    const templates = await post(service, { jsonrpc: '2.0', id: 2, method: 'resources/templates/list' })
    expect(templates.response.status).toBe(200)
    expect(templates.json?.result?.resourceTemplates).toEqual([])
  })

  it('supports resources/read for the config resource', async () => {
    const { service } = makeService()

    const resource = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'agents://config' },
    })
    expect(resource.response.status).toBe(200)
    const text = resource.json?.result?.contents?.[0]?.text as string
    expect(text).toContain('"serverInfo"')
    expect(text).toContain('"agents-control-plane"')
  })

  it('supports persist_memory + retrieve_memory', async () => {
    const { service } = makeService()

    const persist = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { namespace: 'n1', content: 'hello world', tags: ['a'] } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.result?.content?.[0]?.type).toBe('text')

    const retrieve = await post(service, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { namespace: 'n1', query: 'hello', limit: 5 } },
    })
    expect(retrieve.response.status).toBe(200)
    const text = retrieve.json?.result?.content?.[0]?.text as string
    expect(text).toContain('hello world')
  })

  it('returns JSON-RPC invalid params errors for missing required arguments', async () => {
    const { service } = makeService()

    const persist = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { namespace: 'n1' } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.error?.code).toBe(-32602)

    const retrieve = await post(service, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { namespace: 'n1' } },
    })
    expect(retrieve.response.status).toBe(200)
    expect(retrieve.json?.error?.code).toBe(-32602)
  })

  it('supports AgentRun create, read, logs, terminal ack, and rerun tools', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-1',
            payload: {
              agentRef: { name: 'codex-spark-agent' },
              runtime: { type: 'workflow' },
              goal: { objective: 'prove mcp AgentRun creation' },
            },
          },
        },
      },
      {},
      agentRunsService,
    )
    expect(create.response.status).toBe(200)
    expect(create.json?.result?.content?.[0]?.text).toContain('mcp-smoke-run')
    expect(calls.create).toEqual([
      {
        deliveryId: 'delivery-1',
        payload: {
          agentRef: { name: 'codex-spark-agent' },
          runtime: { type: 'workflow' },
          goal: { objective: 'prove mcp AgentRun creation' },
        },
        dryRun: null,
      },
    ])

    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_agent_runs', arguments: { statuses: ['Running'], limit: 5 } },
      },
      {},
      agentRunsService,
    )
    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_agent_run', arguments: { id: 'run-1' } },
      },
      {},
      agentRunsService,
    )
    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_agent_run_logs', arguments: { name: 'mcp-smoke-run', namespace: 'agents', tailLines: 5 } },
      },
      {},
      agentRunsService,
    )
    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'list_agent_run_terminal_events',
          arguments: { namespace: 'agents', consumer: 'codex-mcp-smoke', limit: 5 },
        },
      },
      {},
      agentRunsService,
    )
    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'ack_agent_run_terminal_event',
          arguments: {
            eventId: 'agents/mcp-smoke-run/uid/Succeeded',
            consumer: 'codex-mcp-smoke',
            outcome: 'checked',
          },
        },
      },
      {},
      agentRunsService,
    )
    await post(
      service,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'rerun_agent_run',
          arguments: { agentRunId: 'run-1', deliveryId: 'rerun-1', payload: { reason: 'mcp smoke' } },
        },
      },
      {},
      agentRunsService,
    )

    expect(calls.list).toEqual([{ agentName: null, statuses: ['Running'], limit: 5 }])
    expect(calls.get).toEqual([{ id: 'run-1', namespace: 'agents' }])
    expect(calls.getLogs).toEqual([
      { name: 'mcp-smoke-run', namespace: 'agents', pod: null, container: null, tailLines: 5 },
    ])
    expect(calls.listTerminalEvents).toEqual([
      { namespace: 'agents', runIdPrefix: null, consumer: 'codex-mcp-smoke', includeAcked: null, limit: 5 },
    ])
    expect(calls.ackTerminalEvent).toEqual([
      {
        eventId: 'agents/mcp-smoke-run/uid/Succeeded',
        consumer: 'codex-mcp-smoke',
        outcome: 'checked',
        message: null,
        receiptRef: null,
        annotations: null,
      },
    ])
    expect(calls.rerun).toEqual([{ agentRunId: 'run-1', deliveryId: 'rerun-1', payload: { reason: 'mcp smoke' } }])
  })

  it('injects create_agent_run secretBindingRef into payload policy', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-with-secrets',
            secretBindingRef: 'codex-github-token',
            payload: {
              agentRef: { name: 'codex-agent' },
              implementation: { text: 'Implement the requested change.' },
              runtime: { type: 'job' },
              secrets: ['github-token', 'codex-auth'],
              parameters: {
                repository: 'proompteng/lab',
                base: 'main',
                head: 'codex/demo',
                stage: 'implementation',
              },
            },
          },
        },
      },
      {},
      agentRunsService,
    )

    expect(create.response.status).toBe(200)
    expect(calls.create).toEqual([
      {
        deliveryId: 'delivery-with-secrets',
        payload: {
          agentRef: { name: 'codex-agent' },
          implementation: { text: 'Implement the requested change.' },
          runtime: { type: 'job' },
          secrets: ['github-token', 'codex-auth'],
          parameters: {
            repository: 'proompteng/lab',
            base: 'main',
            head: 'codex/demo',
            stage: 'implementation',
          },
          policy: { secretBindingRef: 'codex-github-token' },
        },
        dryRun: null,
      },
    ])
  })

  it('rejects create_agent_run submissions that request secrets without a SecretBinding', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-missing-binding',
            payload: {
              agentRef: { name: 'codex-agent' },
              implementation: { text: 'Implement the requested change.' },
              runtime: { type: 'job' },
              secrets: ['github-token'],
            },
          },
        },
      },
      {},
      agentRunsService,
    )

    expect(create.response.status).toBe(200)
    expect(create.json?.error?.code).toBe(-32602)
    expect(create.json?.error?.message).toContain('payload.policy.secretBindingRef is required')
    expect(calls.create).toEqual([])
  })

  it('rejects create_agent_run VCS credential requests without a SecretBinding', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-missing-vcs-binding',
            payload: {
              agentRef: { name: 'codex-agent' },
              implementation: { text: 'Implement the requested change.' },
              runtime: { type: 'job' },
              vcsRef: { name: 'github' },
              vcsPolicy: { required: true, mode: 'read-write' },
            },
          },
        },
      },
      {},
      agentRunsService,
    )

    expect(create.response.status).toBe(200)
    expect(create.json?.error?.code).toBe(-32602)
    expect(create.json?.error?.message).toContain('payload.policy.secretBindingRef is required')
    expect(calls.create).toEqual([])
  })

  it('rejects create_agent_run VCS submissions without a repository parameter', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-missing-vcs-repository',
            payload: {
              agentRef: { name: 'codex-agent' },
              implementation: { text: 'Implement the requested change.' },
              runtime: { type: 'job' },
              policy: { secretBindingRef: 'codex-github-token' },
              vcsRef: { name: 'github' },
              vcsPolicy: { required: true, mode: 'read-write' },
              parameters: { head: 'codex/demo' },
            },
          },
        },
      },
      {},
      agentRunsService,
    )

    expect(create.response.status).toBe(200)
    expect(create.json?.error?.code).toBe(-32602)
    expect(create.json?.error?.message).toContain('payload.parameters.repository is required')
    expect(calls.create).toEqual([])
  })

  it('rejects create_agent_run prompt parameters before calling the AgentRun API', async () => {
    const { service } = makeService()
    const { service: agentRunsService, calls } = makeAgentRunsService()

    const create = await post(
      service,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_agent_run',
          arguments: {
            deliveryId: 'delivery-prompt',
            payload: {
              agentRef: { name: 'codex-agent' },
              implementationSpecRef: { name: 'demo-spec' },
              runtime: { type: 'job' },
              parameters: { prompt: 'do the thing' },
            },
          },
        },
      },
      {},
      agentRunsService,
    )

    expect(create.response.status).toBe(200)
    expect(create.json?.error?.code).toBe(-32602)
    expect(create.json?.error?.message).toContain('payload.parameters.prompt is not allowed')
    expect(calls.create).toEqual([])
  })

  it('returns JSON-RPC tool errors when the underlying service fails', async () => {
    const failing: MemoryNotesMcpService = {
      persist: () => Effect.fail(new Error('persist failed')),
      retrieve: () => Effect.fail(new Error('retrieve failed')),
    }

    const persist = await post(failing, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { content: 'hello world' } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.error?.code).toBe(-32000)
    expect(persist.json?.error?.message).toContain('persist failed')

    const retrieve = await post(failing, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { query: 'hello' } },
    })
    expect(retrieve.response.status).toBe(200)
    expect(retrieve.json?.error?.code).toBe(-32000)
    expect(retrieve.json?.error?.message).toContain('retrieve failed')
  })

  it('handles batches with mixed successes and failures', async () => {
    const failing: MemoryNotesMcpService = {
      persist: () => Effect.fail(new Error('persist failed')),
      retrieve: () => Effect.fail(new Error('retrieve failed')),
    }

    const batch = await post(
      failing,
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'persist_memory', arguments: { content: 'hello world' } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'retrieve_memory', arguments: { query: 'hello' } },
        },
      ],
      { 'Mcp-Session-Id': 'session-1' },
    )
    expect(batch.response.status).toBe(200)
    expect(batch.response.headers.get('Mcp-Session-Id')).toBe('session-1')
    expect(Array.isArray(batch.json)).toBe(true)
    expect(batch.json?.map((item: { id: number }) => item.id)).toEqual([1, 2, 3])
    expect(batch.json?.find((item: { id: number }) => item.id === 1)?.result?.serverInfo?.name).toBe(
      'agents-control-plane',
    )
    expect(batch.json?.find((item: { id: number }) => item.id === 2)?.error?.code).toBe(-32000)
    expect(batch.json?.find((item: { id: number }) => item.id === 3)?.error?.code).toBe(-32000)
  })
})
