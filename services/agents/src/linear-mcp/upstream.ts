import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import { validateLinearUpstreamContract, type LinearUpstreamContract } from './contract'

export class LinearUpstreamError extends Error {
  constructor(
    message: string,
    readonly code: 'contract_drift' | 'tool_error' | 'transport_error',
  ) {
    super(message)
    this.name = 'LinearUpstreamError'
  }
}

export type LinearUpstream = {
  checkContract: () => Promise<LinearUpstreamContract>
  getIssue: (identifier: string) => Promise<CallToolResult>
  listComments: (identifier: string) => Promise<CallToolResult>
  listIssueStatuses: (team: string) => Promise<CallToolResult>
  createComment: (identifier: string, body: string) => Promise<CallToolResult>
  updateIssueStatus: (identifier: string, status: string) => Promise<CallToolResult>
  close: () => Promise<void>
}

const asCallToolResult = (value: unknown): CallToolResult => {
  if (!value || typeof value !== 'object' || !('content' in value)) {
    throw new LinearUpstreamError('Linear MCP returned an incompatible tool result', 'tool_error')
  }
  const result = value as CallToolResult
  if (result.isError) throw new LinearUpstreamError('Linear MCP tool call failed', 'tool_error')
  return result
}

export const createLinearUpstream = (options: { url: URL; fetch: FetchLike; timeoutMs: number }): LinearUpstream => {
  let client: Client | null = null
  let transport: StreamableHTTPClientTransport | null = null
  let connecting: Promise<Client> | null = null
  let contract: LinearUpstreamContract | null = null

  const resetConnection = async () => {
    client = null
    contract = null
    const active = transport
    transport = null
    if (active) await active.close().catch(() => undefined)
  }

  const getClient = async () => {
    if (client) return client
    if (!connecting) {
      connecting = (async () => {
        const nextClient = new Client({ name: 'agents-linear-mcp-gateway', version: '1.0.0' })
        const nextTransport = new StreamableHTTPClientTransport(options.url, {
          fetch: options.fetch,
          reconnectionOptions: {
            maxReconnectionDelay: 10_000,
            initialReconnectionDelay: 500,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 1,
          },
        })
        try {
          await nextClient.connect(nextTransport, { timeout: options.timeoutMs })
        } catch (error) {
          await nextTransport.close().catch(() => undefined)
          throw new LinearUpstreamError(
            `failed to connect to Linear MCP: ${error instanceof Error ? error.message : String(error)}`,
            'transport_error',
          )
        }
        client = nextClient
        transport = nextTransport
        return nextClient
      })().finally(() => {
        connecting = null
      })
    }
    return connecting
  }

  const checkContract = async () => {
    const connected = await getClient()
    let result: Awaited<ReturnType<Client['listTools']>>
    try {
      result = await connected.listTools({}, { timeout: options.timeoutMs })
    } catch (error) {
      await resetConnection()
      throw new LinearUpstreamError(
        `failed to list Linear MCP tools: ${error instanceof Error ? error.message : String(error)}`,
        'transport_error',
      )
    }
    const validation = validateLinearUpstreamContract(result.tools as Tool[])
    if (!validation.ok) {
      contract = null
      throw new LinearUpstreamError(`Linear MCP contract drift: ${validation.errors.join('; ')}`, 'contract_drift')
    }
    contract = validation.contract
    return validation.contract
  }

  const requireContract = () => contract ?? checkContract()
  const call = async (name: string, args: Record<string, unknown>) => {
    const connected = await getClient()
    try {
      return asCallToolResult(
        await connected.callTool({ name, arguments: args }, undefined, { timeout: options.timeoutMs }),
      )
    } catch (error) {
      if (error instanceof LinearUpstreamError) throw error
      await resetConnection()
      throw new LinearUpstreamError(
        `Linear MCP ${name} call failed: ${error instanceof Error ? error.message : String(error)}`,
        'transport_error',
      )
    }
  }

  return {
    checkContract,
    getIssue: async (identifier) => {
      const selected = (await requireContract()).getIssue
      return call(selected.name, { [selected.issueArgument]: identifier })
    },
    listComments: async (identifier) => {
      const selected = (await requireContract()).listComments
      return call(selected.name, { [selected.issueArgument]: identifier })
    },
    listIssueStatuses: async (team) => {
      const selected = (await requireContract()).listIssueStatuses
      return call(selected.name, { [selected.teamArgument]: team })
    },
    createComment: async (identifier, body) => {
      const selected = (await requireContract()).createComment
      return call(selected.name, { [selected.issueArgument]: identifier, body })
    },
    updateIssueStatus: async (identifier, status) => {
      const selected = (await requireContract()).updateIssue
      return call(selected.name, {
        [selected.issueArgument]: identifier,
        [selected.statusArgument]: status,
      })
    },
    close: async () => {
      await resetConnection()
    },
  }
}
