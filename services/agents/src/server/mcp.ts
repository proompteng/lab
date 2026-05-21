import { Context, Effect, Layer, ManagedRuntime } from 'effect'

import {
  MAX_MEMORY_NOTE_CONTENT_CHARS,
  MAX_MEMORY_NOTE_QUERY_CHARS,
  MAX_MEMORY_NOTE_SUMMARY_CHARS,
  parsePersistMemoryNoteInput,
  parseRetrieveMemoryNotesInput,
  type AgentsMemoryNoteRecord,
  type AgentsPersistMemoryNoteInput,
  type AgentsRetrieveMemoryNotesInput,
} from '@proompteng/agent-contracts/memory-client'

import { createPostgresMemoriesStore, type MemoriesStore } from './memory-notes-store'

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export type MemoryNotesMcpService = {
  persist: (input: AgentsPersistMemoryNoteInput) => Effect.Effect<AgentsMemoryNoteRecord, Error>
  retrieve: (input: AgentsRetrieveMemoryNotesInput) => Effect.Effect<AgentsMemoryNoteRecord[], Error>
}

export class MemoryNotesMcp extends Context.Tag('agents/MemoryNotesMcp')<MemoryNotesMcp, MemoryNotesMcpService>() {}

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_SERVER_INFO = { name: 'agents-memory-notes', version: '0.1.0' } as const
const MCP_CONFIG_RESOURCE_URI = 'memories://config'

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

const asJsonRpcResponse = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })

const asJsonRpcError = (id: JsonRpcId, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: '2.0', id, error })

const withMcpSessionHeaders = (request: Request, init: ResponseInit = {}): ResponseInit => {
  const sessionId = request.headers.get(MCP_SESSION_HEADER)
  if (!sessionId) return init

  return {
    ...init,
    headers: {
      ...init.headers,
      [MCP_SESSION_HEADER]: sessionId,
    },
  }
}

const toolsListResult = {
  tools: [
    {
      name: 'persist_memory',
      description: 'Persist a memory record through the Agents memory note service.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Optional namespace (defaults to "default")' },
          content: { type: 'string', description: 'Memory content (required)' },
          summary: { type: 'string', description: 'Optional short summary' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
          metadata: { type: 'object', description: 'Optional metadata to attach to the memory record' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    {
      name: 'retrieve_memory',
      description: 'Retrieve relevant memories through the Agents memory note service.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'Optional namespace filter (omit to search across all namespaces)',
          },
          query: { type: 'string', description: 'Search query (required)' },
          limit: { type: 'integer', description: 'Max results (default 10, max 50)', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
} as const

const resourcesListResult = {
  resources: [
    {
      uri: MCP_CONFIG_RESOURCE_URI,
      name: 'Agents memory MCP config',
      description: 'Server metadata and defaults for the Agents memory note tools.',
      mimeType: 'application/json',
    },
  ],
} as const

const toTextToolResult = (text: string) => ({
  content: [{ type: 'text', text }],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseToolCall = (params: unknown): { name: string; args: Record<string, unknown> } | JsonRpcError => {
  if (!isRecord(params)) {
    return { code: -32602, message: 'Invalid params' }
  }
  const name = params.name
  if (typeof name !== 'string' || name.length === 0) {
    return { code: -32602, message: 'Invalid params: missing tool name' }
  }
  const args = params.arguments
  if (args == null) return { name, args: {} }
  if (!isRecord(args)) {
    return { code: -32602, message: 'Invalid params: arguments must be an object' }
  }
  return { name, args: args as Record<string, unknown> }
}

const parseResourceReadParams = (params: unknown): { uri: string } | JsonRpcError => {
  if (!isRecord(params)) {
    return { code: -32602, message: 'Invalid params' }
  }
  const uri = params.uri
  if (typeof uri !== 'string' || uri.length === 0) {
    return { code: -32602, message: 'Invalid params: missing resource uri' }
  }
  return { uri }
}

const toolError = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32000, message, data })

const invalidParams = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32602, message, data })

const buildConfigResource = (request: Request) => {
  const endpoint = new URL(request.url).toString()
  return {
    uri: MCP_CONFIG_RESOURCE_URI,
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: MCP_SERVER_INFO,
        endpoint,
        tools: toolsListResult.tools,
        defaults: {
          namespace: 'default',
          limits: {
            maxContentChars: MAX_MEMORY_NOTE_CONTENT_CHARS,
            maxQueryChars: MAX_MEMORY_NOTE_QUERY_CHARS,
            maxSummaryChars: MAX_MEMORY_NOTE_SUMMARY_CHARS,
          },
        },
      },
      null,
      2,
    ),
  }
}

const handleToolCallEffect = (request: Request, id: JsonRpcId, toolName: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const memories = yield* MemoryNotesMcp
    const baseUrl = new URL(request.url)

    if (toolName === 'persist_memory') {
      const parsed = parsePersistMemoryNoteInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)

      const recordResult = yield* Effect.either(memories.persist(parsed.value))
      if (recordResult._tag === 'Left') return toolError(id, recordResult.left.message, { tool: toolName })

      return asJsonRpcResponse(
        id,
        toTextToolResult(
          JSON.stringify(
            { ok: true, memory: recordResult.right, mcp: { server: baseUrl.origin, tool: toolName } },
            null,
            2,
          ),
        ),
      )
    }

    if (toolName === 'retrieve_memory') {
      const parsed = parseRetrieveMemoryNotesInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)

      const recordsResult = yield* Effect.either(memories.retrieve(parsed.value))
      if (recordsResult._tag === 'Left') return toolError(id, recordsResult.left.message, { tool: toolName })

      return asJsonRpcResponse(
        id,
        toTextToolResult(
          JSON.stringify(
            { ok: true, memories: recordsResult.right, mcp: { server: baseUrl.origin, tool: toolName } },
            null,
            2,
          ),
        ),
      )
    }

    return asJsonRpcError(id, { code: -32601, message: `Unknown tool: ${toolName}` })
  })

const handleJsonRpcMessageEffect = (request: Request, raw: unknown) =>
  Effect.gen(function* () {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return asJsonRpcError(null, { code: -32600, message: 'Invalid Request' })
    }

    const msg = raw as JsonRpcRequest
    const id: JsonRpcId = typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null ? msg.id : null
    const method = msg.method
    if (typeof method !== 'string' || method.length === 0) {
      return asJsonRpcError(id, { code: -32600, message: 'Invalid Request: missing method' })
    }

    const isNotification = !('id' in msg)

    switch (method) {
      case 'initialize': {
        if (isNotification) return null
        return asJsonRpcResponse(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: MCP_SERVER_INFO,
        })
      }
      case 'notifications/initialized': {
        return null
      }
      case 'tools/list': {
        if (isNotification) return null
        return asJsonRpcResponse(id, toolsListResult)
      }
      case 'resources/list': {
        if (isNotification) return null
        return asJsonRpcResponse(id, resourcesListResult)
      }
      case 'resources/read': {
        const parsed = parseResourceReadParams(msg.params)
        if ('code' in parsed) {
          if (isNotification) return null
          return asJsonRpcError(id, parsed)
        }
        if (parsed.uri !== MCP_CONFIG_RESOURCE_URI) {
          if (isNotification) return null
          return invalidParams(id, 'Invalid params: unknown resource uri')
        }
        if (isNotification) return null
        return asJsonRpcResponse(id, { contents: [buildConfigResource(request)] })
      }
      case 'resources/templates/list': {
        if (isNotification) return null
        return asJsonRpcResponse(id, { resourceTemplates: [] })
      }
      case 'tools/call': {
        const parsed = parseToolCall(msg.params)
        if ('code' in parsed) {
          if (isNotification) return null
          return asJsonRpcError(id, parsed)
        }
        if (isNotification) return null
        return yield* handleToolCallEffect(request, id, parsed.name, parsed.args)
      }
      default: {
        if (isNotification) return null
        return asJsonRpcError(id, { code: -32601, message: `Method not found: ${method}` })
      }
    }
  })

export const handleMcpRequestEffect = (request: Request) =>
  Effect.gen(function* () {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    let body: unknown
    try {
      body = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new Error('Parse error'),
      })
    } catch {
      return jsonResponse(
        asJsonRpcError(null, { code: -32700, message: 'Parse error' }),
        withMcpSessionHeaders(request, { status: 400 }),
      )
    }

    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = []
      for (const item of body) {
        const response = yield* handleJsonRpcMessageEffect(request, item)
        if (response) responses.push(response)
      }
      if (responses.length === 0) {
        return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
      }
      return jsonResponse(responses, withMcpSessionHeaders(request))
    }

    const response = yield* handleJsonRpcMessageEffect(request, body)
    if (!response) return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
    return jsonResponse(response, withMcpSessionHeaders(request))
  })

const withStore = <T>(operation: (store: MemoriesStore) => Promise<T>) =>
  Effect.tryPromise({
    try: async () => {
      const store = createPostgresMemoriesStore()
      try {
        return await operation(store)
      } finally {
        await store.close()
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

export const MemoryNotesMcpLive = Layer.succeed(MemoryNotesMcp, {
  persist: (input) => withStore((store) => store.persist(input)),
  retrieve: (input) => withStore((store) => store.retrieve(input)),
} satisfies MemoryNotesMcpService)

const handlerRuntime = ManagedRuntime.make(MemoryNotesMcpLive)

export const handleMcpRequest = (request: Request): Promise<Response> =>
  handlerRuntime.runPromise(handleMcpRequestEffect(request))
