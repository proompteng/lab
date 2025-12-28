import { Effect, Layer, ManagedRuntime } from 'effect'

import { Atlas, AtlasLive } from './atlas'
import { parseAtlasIndexInput, parseAtlasSearchInput } from './atlas-http'
import { Memories, MemoriesLive } from './memories'

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

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_SERVER_INFO = { name: 'memories', version: '0.1.0' } as const

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
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
      ...(init.headers ?? {}),
      [MCP_SESSION_HEADER]: sessionId,
    },
  }
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  'atlas.index': 'atlas_index',
  'atlas.search': 'atlas_search',
  'atlas.stats': 'atlas_stats',
}

const normalizeToolName = (name: string) => TOOL_NAME_ALIASES[name] ?? name

const toolsListResult = {
  tools: [
    {
      name: 'persist_memory',
      description: 'Persist a memory record to Postgres (pgvector embedding for semantic retrieval).',
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
      description:
        'Retrieve relevant memories from Postgres using semantic search (OpenAI embeddings + pgvector cosine distance).',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Optional namespace (defaults to "default")' },
          query: { type: 'string', description: 'Search query (required)' },
          limit: { type: 'integer', description: 'Max results (default 10, max 50)', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'atlas_index',
      description: 'Request Atlas enrichment for a repository file path (indexed in Postgres).',
      inputSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'Repository name (required).' },
          ref: { type: 'string', description: 'Git ref (default main).' },
          commit: { type: 'string', description: 'Commit SHA for the file.' },
          path: { type: 'string', description: 'Path within the repository (required).' },
          contentHash: { type: 'string', description: 'Content hash for the file.' },
          metadata: { type: 'object', description: 'Optional metadata to attach to the file version.' },
        },
        required: ['repository', 'path'],
        additionalProperties: false,
      },
    },
    {
      name: 'atlas_search',
      description: 'Search Atlas enrichments with semantic similarity and optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (required).' },
          limit: { type: 'integer', description: 'Max results (default 10, max 50).', minimum: 1, maximum: 50 },
          repository: { type: 'string', description: 'Filter by repository name.' },
          ref: { type: 'string', description: 'Filter by repository ref.' },
          pathPrefix: { type: 'string', description: 'Filter by file path prefix.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by enrichment tags.' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Filter by enrichment kinds.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'atlas_stats',
      description: 'Return Atlas table counts and ingestion stats.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
} as const

const MCP_CONFIG_RESOURCE_URI = 'memories://config'

const resourcesListResult = {
  resources: [
    {
      uri: MCP_CONFIG_RESOURCE_URI,
      name: 'Memories MCP config',
      description: 'Server metadata and defaults for the memories tools.',
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

const MAX_CONTENT_CHARS = 50_000
const MAX_QUERY_CHARS = 10_000
const MAX_SUMMARY_CHARS = 5_000

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
            maxContentChars: MAX_CONTENT_CHARS,
            maxQueryChars: MAX_QUERY_CHARS,
            maxSummaryChars: MAX_SUMMARY_CHARS,
          },
        },
      },
      null,
      2,
    ),
  }
}

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

    // Notifications (no id) should not receive responses.
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

        const memories = yield* Memories
        const atlas = yield* Atlas
        const baseUrl = new URL(request.url)
        const toolName = normalizeToolName(parsed.name)
        const args = parsed.args

        if (toolName === 'persist_memory') {
          const content = typeof args.content === 'string' ? args.content.trim() : ''
          if (!content) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: content is required')
          }
          if (content.length > MAX_CONTENT_CHARS) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: content is too large', { maxChars: MAX_CONTENT_CHARS })
          }

          const summary = typeof args.summary === 'string' ? args.summary.trim() : null
          if (summary && summary.length > MAX_SUMMARY_CHARS) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: summary is too large', { maxChars: MAX_SUMMARY_CHARS })
          }

          const namespace = typeof args.namespace === 'string' ? args.namespace : undefined
          const tags = Array.isArray(args.tags)
            ? (args.tags.filter((t) => typeof t === 'string') as string[])
            : undefined
          const metadata = isRecord(args.metadata) ? (args.metadata as Record<string, unknown>) : undefined

          const recordResult = yield* Effect.either(memories.persist({ namespace, content, summary, tags, metadata }))
          if (recordResult._tag === 'Left') {
            if (isNotification) return null
            return toolError(id, recordResult.left.message, { tool: toolName })
          }
          const record = recordResult.right
          if (isNotification) return null
          return asJsonRpcResponse(
            id,
            toTextToolResult(
              JSON.stringify({ ok: true, memory: record, mcp: { server: baseUrl.origin, tool: toolName } }, null, 2),
            ),
          )
        }

        if (toolName === 'retrieve_memory') {
          const query = typeof args.query === 'string' ? args.query.trim() : ''
          if (!query) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: query is required')
          }
          if (query.length > MAX_QUERY_CHARS) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: query is too large', { maxChars: MAX_QUERY_CHARS })
          }

          const namespace = typeof args.namespace === 'string' ? args.namespace : undefined
          const limit =
            typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined
          if (limit != null && (limit < 1 || limit > 50)) {
            if (isNotification) return null
            return invalidParams(id, 'Invalid params: limit must be between 1 and 50')
          }

          const recordsResult = yield* Effect.either(memories.retrieve({ namespace, query, limit }))
          if (recordsResult._tag === 'Left') {
            if (isNotification) return null
            return toolError(id, recordsResult.left.message, { tool: toolName })
          }
          const records = recordsResult.right
          if (isNotification) return null
          return asJsonRpcResponse(
            id,
            toTextToolResult(
              JSON.stringify({ ok: true, memories: records, mcp: { server: baseUrl.origin, tool: toolName } }, null, 2),
            ),
          )
        }

        if (toolName === 'atlas_index') {
          const parsed = parseAtlasIndexInput(args)
          if (!parsed.ok) {
            if (isNotification) return null
            return invalidParams(id, parsed.message)
          }

          const indexResult = yield* Effect.either(
            Effect.gen(function* () {
              const repository = yield* atlas.upsertRepository({
                name: parsed.value.repository,
                defaultRef: parsed.value.ref,
              })
              const fileKey = yield* atlas.upsertFileKey({
                repositoryId: repository.id,
                path: parsed.value.path,
              })
              const fileVersion = yield* atlas.upsertFileVersion({
                fileKeyId: fileKey.id,
                repositoryRef: parsed.value.ref,
                repositoryCommit: parsed.value.commit ?? null,
                contentHash: parsed.value.contentHash ?? null,
                metadata: parsed.value.metadata,
              })

              return { repository, fileKey, fileVersion }
            }),
          )

          if (indexResult._tag === 'Left') {
            if (isNotification) return null
            return toolError(id, indexResult.left.message, { tool: toolName })
          }
          if (isNotification) return null
          return asJsonRpcResponse(
            id,
            toTextToolResult(
              JSON.stringify(
                { ok: true, ...indexResult.right, mcp: { server: baseUrl.origin, tool: toolName } },
                null,
                2,
              ),
            ),
          )
        }

        if (toolName === 'atlas_search') {
          const parsed = parseAtlasSearchInput(args)
          if (!parsed.ok) {
            if (isNotification) return null
            return invalidParams(id, parsed.message)
          }

          const matchesResult = yield* Effect.either(atlas.search(parsed.value))
          if (matchesResult._tag === 'Left') {
            if (isNotification) return null
            return toolError(id, matchesResult.left.message, { tool: toolName })
          }
          if (isNotification) return null
          return asJsonRpcResponse(
            id,
            toTextToolResult(
              JSON.stringify(
                { ok: true, matches: matchesResult.right, mcp: { server: baseUrl.origin, tool: toolName } },
                null,
                2,
              ),
            ),
          )
        }

        if (toolName === 'atlas_stats') {
          const statsResult = yield* Effect.either(atlas.stats())
          if (statsResult._tag === 'Left') {
            if (isNotification) return null
            return toolError(id, statsResult.left.message, { tool: toolName })
          }
          if (isNotification) return null
          return asJsonRpcResponse(
            id,
            toTextToolResult(
              JSON.stringify(
                { ok: true, stats: statsResult.right, mcp: { server: baseUrl.origin, tool: toolName } },
                null,
                2,
              ),
            ),
          )
        }

        if (isNotification) return null
        return asJsonRpcError(id, { code: -32601, message: `Unknown tool: ${toolName}` })
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

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoriesLive, AtlasLive))

export const handleMcpRequest = (request: Request): Promise<Response> =>
  handlerRuntime.runPromise(handleMcpRequestEffect(request))
