import { isAuthorized } from './auth'
import { jsonResponse } from './http'
import {
  ListFeedInputSchema,
  RecordFeedbackInputSchema,
  StartRunInputSchema,
  SubmitBatchInputSchema,
  SubmitItemInputSchema,
} from './schema'
import { getSynthesisStore, type SynthesisStore } from './store'

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
const MCP_SERVER_INFO = { name: 'synthesis-control-plane', version: '0.1.0' } as const
const MCP_CONFIG_RESOURCE_URI = 'synthesis://config'

const mutatingTools = new Set([
  'synthesis_start_run',
  'synthesis_submit_item',
  'synthesis_submit_batch',
  'synthesis_record_feedback',
])

const toolsListResult = {
  tools: [
    {
      name: 'synthesis_start_run',
      description: 'Start an X.com feed synthesis run.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Feed source, normally x.com/home.' },
          notes: { type: 'string', description: 'Optional run notes.' },
          interests: { type: 'array', items: { type: 'string' }, description: 'Interest tags for the run.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'synthesis_submit_item',
      description:
        'Submit one polished synthesis item. One item can represent multiple X posts; raw post text is stored only as source/audit material.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          title: { type: 'string', description: 'Human title for the synthesized theme.' },
          synthesis: { type: 'string', description: 'Concise human synthesis, not a raw post summary.' },
          takeaways: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          whyValuable: { type: 'string', description: 'Why this item belongs in the curated feed.' },
          sourcePosts: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                originalUrl: { type: 'string' },
                authorHandle: { type: 'string' },
                authorName: { type: 'string' },
                postedAt: { type: 'string' },
                observedAt: { type: 'string' },
                observedText: { type: 'string' },
              },
              required: ['originalUrl', 'observedText'],
              additionalProperties: false,
            },
            description: 'Original X posts that support the synthesis. Can contain multiple posts for one theme.',
          },
          factChecks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                claim: { type: 'string' },
                status: { type: 'string', enum: ['verified', 'unclear', 'refuted', 'rumor'] },
                explanation: { type: 'string' },
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      url: { type: 'string' },
                      publisher: { type: 'string' },
                      checkedAt: { type: 'string' },
                    },
                    required: ['url'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['claim', 'status', 'explanation'],
              additionalProperties: false,
            },
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['source_image', 'source_screenshot', 'generated_infographic'] },
                url: { type: 'string' },
                data: { type: 'string' },
                sourceUrl: { type: 'string' },
                mimeType: { type: 'string' },
                alt: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
          generatedAttachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['generated_infographic'] },
                url: { type: 'string' },
                data: { type: 'string' },
                sourceUrl: { type: 'string' },
                mimeType: { type: 'string' },
                alt: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
          dedupeKey: { type: 'string' },
          topicTags: { type: 'array', items: { type: 'string' } },
          score: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['title', 'synthesis', 'takeaways', 'whyValuable', 'sourcePosts', 'dedupeKey', 'score', 'confidence'],
        additionalProperties: false,
      },
    },
    {
      name: 'synthesis_submit_batch',
      description: 'Submit multiple polished synthesis theme items.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          items: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 50 },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
    {
      name: 'synthesis_list_feed',
      description: 'List stored synthesis feed items.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          tag: { type: 'string' },
          minScore: { type: 'number', minimum: 0, maximum: 1 },
          query: { type: 'string', description: 'Semantic search query ranked against stored item embeddings.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'synthesis_get_item',
      description: 'Get one stored synthesis item by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'synthesis_record_feedback',
      description: 'Record feedback on a synthesis item and update interest weights.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { type: 'string', enum: ['up', 'down', 'save', 'hide'] },
          reason: { type: 'string' },
        },
        required: ['id', 'value'],
        additionalProperties: false,
      },
    },
  ],
} as const

const resourcesListResult = {
  resources: [
    {
      uri: MCP_CONFIG_RESOURCE_URI,
      name: 'Synthesis MCP config',
      description: 'Server metadata, auth requirements, and tool list for Synthesis.',
      mimeType: 'application/json',
    },
  ],
} as const

const withMcpSessionHeaders = (request: Request, init: ResponseInit = {}): ResponseInit => {
  const sessionId = request.headers.get(MCP_SESSION_HEADER)
  if (!sessionId) return init
  const headers = new Headers(init.headers)
  headers.set(MCP_SESSION_HEADER, sessionId)
  return {
    ...init,
    headers,
  }
}

const asJsonRpcResponse = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
const asJsonRpcError = (id: JsonRpcId, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: '2.0', id, error })

const toTextToolResult = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseToolCall = (params: unknown): { name: string; args: Record<string, unknown> } | JsonRpcError => {
  if (!isRecord(params)) return { code: -32602, message: 'Invalid params' }
  const name = params.name
  if (typeof name !== 'string' || name.length === 0) {
    return { code: -32602, message: 'Invalid params: missing tool name' }
  }
  const args = params.arguments
  if (args == null) return { name, args: {} }
  if (!isRecord(args)) return { code: -32602, message: 'Invalid params: arguments must be an object' }
  return { name, args }
}

const parseResourceReadParams = (params: unknown): { uri: string } | JsonRpcError => {
  if (!isRecord(params)) return { code: -32602, message: 'Invalid params' }
  const uri = params.uri
  if (typeof uri !== 'string' || uri.length === 0) {
    return { code: -32602, message: 'Invalid params: missing resource uri' }
  }
  return { uri }
}

const buildConfigResource = (request: Request) => ({
  uri: MCP_CONFIG_RESOURCE_URI,
  mimeType: 'application/json',
  text: JSON.stringify(
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: MCP_SERVER_INFO,
      endpoint: new URL(request.url).toString(),
      auth: {
        header: 'Authorization: Bearer $SYNTHESIS_MCP_TOKEN',
        mutatingTools: [...mutatingTools],
      },
      guardrails: {
        embeddings: {
          createdByServer: true,
          localModelRequired: true,
          clientSuppliedEmbeddingsAccepted: false,
        },
        search: {
          queryMode: 'semantic',
          textSubstringSearch: false,
        },
        assets: {
          sourceMediaMustBeAttachments: true,
          objectStorageBackedWhenConfigured: true,
        },
      },
      tools: toolsListResult.tools,
    },
    null,
    2,
  ),
})

const invalidParams = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32602, message, data })

const toolError = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32000, message, data })

const unauthorizedTool = (id: JsonRpcId): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32001, message: 'Unauthorized: bearer token required' })

const handleToolCall = async (
  request: Request,
  store: SynthesisStore,
  id: JsonRpcId,
  name: string,
  args: Record<string, unknown>,
) => {
  if (mutatingTools.has(name) && !isAuthorized(request)) return unauthorizedTool(id)

  try {
    if (name === 'synthesis_start_run') {
      const parsed = StartRunInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_start_run input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, run: await store.startRun(parsed.data) }))
    }
    if (name === 'synthesis_submit_item') {
      const parsed = SubmitItemInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_submit_item input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, ...(await store.submitItem(parsed.data)) }))
    }
    if (name === 'synthesis_submit_batch') {
      const parsed = SubmitBatchInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_submit_batch input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, ...(await store.submitBatch(parsed.data)) }))
    }
    if (name === 'synthesis_list_feed') {
      const parsed = ListFeedInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_list_feed input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, ...(await store.listFeed(parsed.data)) }))
    }
    if (name === 'synthesis_get_item') {
      const idArg = args.id
      if (typeof idArg !== 'string' || idArg.length === 0) return invalidParams(id, 'Invalid synthesis_get_item input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, item: await store.getItem(idArg) }))
    }
    if (name === 'synthesis_record_feedback') {
      const parsed = RecordFeedbackInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_record_feedback input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, feedback: await store.recordFeedback(parsed.data) }))
    }

    return asJsonRpcError(id, { code: -32601, message: `Unknown tool: ${name}` })
  } catch (error) {
    return toolError(id, error instanceof Error ? error.message : 'Tool failed', { tool: name })
  }
}

const handleJsonRpcMessage = async (
  request: Request,
  store: SynthesisStore,
  raw: unknown,
): Promise<JsonRpcResponse | null> => {
  if (!isRecord(raw)) return asJsonRpcError(null, { code: -32600, message: 'Invalid Request' })

  const msg = raw as JsonRpcRequest
  const id: JsonRpcId = typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null ? msg.id : null
  const method = msg.method
  if (typeof method !== 'string' || method.length === 0) {
    return asJsonRpcError(id, { code: -32600, message: 'Invalid Request: missing method' })
  }

  const isNotification = !('id' in msg)

  if (method === 'initialize') {
    if (isNotification) return null
    return asJsonRpcResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: MCP_SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized') return null
  if (method === 'tools/list') return isNotification ? null : asJsonRpcResponse(id, toolsListResult)
  if (method === 'resources/list') return isNotification ? null : asJsonRpcResponse(id, resourcesListResult)
  if (method === 'resources/templates/list')
    return isNotification ? null : asJsonRpcResponse(id, { resourceTemplates: [] })
  if (method === 'resources/read') {
    const parsed = parseResourceReadParams(msg.params)
    if ('code' in parsed) return isNotification ? null : asJsonRpcError(id, parsed)
    if (parsed.uri !== MCP_CONFIG_RESOURCE_URI) {
      return isNotification ? null : invalidParams(id, 'Invalid params: unknown resource uri')
    }
    return isNotification ? null : asJsonRpcResponse(id, { contents: [buildConfigResource(request)] })
  }
  if (method === 'tools/call') {
    const parsed = parseToolCall(msg.params)
    if ('code' in parsed) return isNotification ? null : asJsonRpcError(id, parsed)
    return isNotification ? null : handleToolCall(request, store, id, parsed.name, parsed.args)
  }

  return isNotification ? null : asJsonRpcError(id, { code: -32601, message: `Method not found: ${method}` })
}

export const handleMcpRequest = async (request: Request, store = getSynthesisStore()): Promise<Response> => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse(
      asJsonRpcError(null, { code: -32700, message: 'Parse error' }),
      withMcpSessionHeaders(request, { status: 400 }),
    )
  }

  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = []
    for (const item of body) {
      const response = await handleJsonRpcMessage(request, store, item)
      if (response) responses.push(response)
    }
    if (responses.length === 0) return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
    return jsonResponse(responses, withMcpSessionHeaders(request))
  }

  const response = await handleJsonRpcMessage(request, store, body)
  if (!response) return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
  return jsonResponse(response, withMcpSessionHeaders(request))
}
