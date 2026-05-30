import { isAuthorized } from './auth'
import { CompanyProfileHintSchema } from './company'
import { jsonResponse } from './http'
import {
  AutotraderAppendEventInputSchema,
  AutotraderCreateTradeTicketInputSchema,
  AutotraderFinalizeSessionInputSchema,
  AutotraderGetScorecardInputSchema,
  AutotraderRecordFillInputSchema,
  AutotraderRecordOrderInputSchema,
  AutotraderRecordPositionSnapshotInputSchema,
  AutotraderRecordRiskCheckInputSchema,
  AutotraderStartSessionInputSchema,
  AutotraderUpsertStatusInputSchema,
} from './autotrader-schema'
import { getAutotraderStore } from './autotrader-store'
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
  'synthesis_prefill_company',
  'synthesis_record_feedback',
  'autotrader_start_session',
  'autotrader_upsert_status',
  'autotrader_append_event',
  'autotrader_create_trade_ticket',
  'autotrader_record_risk_check',
  'autotrader_record_order',
  'autotrader_record_fill',
  'autotrader_record_position_snapshot',
  'autotrader_finalize_session',
])

const numericStringSchema = { type: 'string', description: 'Decimal value encoded as a string.' } as const
const payloadSchema = { type: 'object', additionalProperties: true } as const
const optionalStringArraySchema = { type: 'array', items: { type: 'string' } } as const
const setupGradeSchema = { type: 'string', enum: ['A+', 'A', 'B', 'C', 'blocked'] } as const
const sideSchema = {
  type: 'string',
  enum: ['buy', 'sell', 'sell_short', 'buy_to_cover', 'buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'],
} as const
const instrumentSchema = { type: 'string', enum: ['stock', 'etf', 'option', 'crypto', 'other'] } as const

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
                alt: {
                  type: 'string',
                  description: 'Required for source media; concise extracted visual information from the image.',
                },
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
                alt: { type: 'string', description: 'Concise description of the generated infographic.' },
                label: { type: 'string' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          },
          companySymbols: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 16,
            description:
              'Optional normalized public-company tickers/cashtags to associate with the item. The server also derives known symbols from item text, tags, and source posts.',
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
      name: 'synthesis_prefill_company',
      description:
        'Populate or refresh a Synthesis-owned normalized public-company profile keyed by stock symbol. Prefers Webull-backed provider data when the runtime bridge is configured, can attach optional Alpaca quote context, and falls back to official-source/manual hints or local fixtures when available.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker or cashtag such as NVDA or $AMD.' },
          companyName: { type: 'string', description: 'Optional official company name for manual fallback.' },
          exchange: { type: 'string' },
          category: { type: 'string' },
          sector: { type: 'string' },
          industry: { type: 'string' },
          ceo: { type: 'string' },
          employees: { type: 'integer', minimum: 1 },
          headquarters: { type: 'string' },
          address: { type: 'string' },
          establishedAt: { type: 'string' },
          incorporatedAt: { type: 'string' },
          description: { type: 'string' },
          dataSources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                url: { type: 'string' },
                fields: { type: 'array', items: { type: 'string' } },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
        required: ['symbol'],
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
    {
      name: 'autotrader_start_session',
      description:
        'Start or idempotently reopen a Synthesis-owned autonomous-trader market session. This creates durable canonical state before the AgentRun scans or trades.',
      inputSchema: {
        type: 'object',
        properties: {
          agentRunName: { type: 'string' },
          mode: {
            type: 'string',
            enum: ['market_session', 'market_open', 'dry_run', 'paper_smoke', 'scorecard_readback'],
          },
          tradingDate: { type: 'string' },
          accountId: { type: 'string' },
          goalEquity: numericStringSchema,
          openingEquity: numericStringSchema,
          marketOpenAt: { type: 'string' },
          marketCloseAt: { type: 'string' },
          analysisHead: { type: 'string' },
          analysisContextHash: { type: 'string' },
        },
        required: ['agentRunName', 'tradingDate', 'marketOpenAt', 'marketCloseAt'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_upsert_status',
      description: 'Write the latest live trading loop status for operator visibility and recovery.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          cycle: { type: 'integer', minimum: 0 },
          phase: {
            type: 'string',
            enum: [
              'preflight',
              'scan',
              'ticket',
              'risk_check',
              'order',
              'manage',
              'reconcile',
              'finalize',
              'blocked',
              'idle',
              'no_trade',
            ],
          },
          equity: numericStringSchema,
          buyingPower: numericStringSchema,
          daytradeBuyingPower: numericStringSchema,
          grossExposure: numericStringSchema,
          netExposure: numericStringSchema,
          realizedPnl: numericStringSchema,
          unrealizedPnl: numericStringSchema,
          currentAction: { type: 'string' },
          blocker: { type: ['string', 'null'] },
          payload: payloadSchema,
        },
        required: ['sessionId', 'cycle', 'phase', 'currentAction'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_append_event',
      description: 'Append or idempotently replace a sequenced autotrader session event.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          seq: { type: 'integer', minimum: 0 },
          occurredAt: { type: 'string' },
          eventType: { type: 'string' },
          symbol: { type: 'string' },
          setupType: { type: 'string' },
          setupGrade: setupGradeSchema,
          severity: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
          payload: payloadSchema,
        },
        required: ['sessionId', 'seq', 'eventType'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_create_trade_ticket',
      description:
        'Create or update the validated trade ticket that must exist before any non-smoke order. C setups should be recorded as blocked/no-trade tickets.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          idempotencyKey: { type: 'string' },
          symbol: { type: 'string' },
          instrument: instrumentSchema,
          side: sideSchema,
          setupType: { type: 'string' },
          setupGrade: setupGradeSchema,
          fatPitch: { type: 'boolean' },
          regime: { type: 'string' },
          timeBucket: { type: 'string' },
          thesis: { type: 'string' },
          entryTrigger: { type: 'string' },
          invalidation: { type: 'string' },
          entryLimitPrice: numericStringSchema,
          stopPrice: numericStringSchema,
          targetPrice: numericStringSchema,
          expectedR: numericStringSchema,
          maxLossAmount: numericStringSchema,
          riskDollars: numericStringSchema,
          plannedQuantity: numericStringSchema,
          protectionType: { type: 'string' },
          brokerOrderPlan: payloadSchema,
          status: { type: 'string', enum: ['candidate', 'validated', 'blocked', 'ordered', 'filled', 'closed'] },
          noTradeReason: { type: ['string', 'null'] },
        },
        required: [
          'sessionId',
          'idempotencyKey',
          'symbol',
          'instrument',
          'side',
          'setupType',
          'setupGrade',
          'regime',
          'thesis',
          'entryTrigger',
          'invalidation',
          'protectionType',
        ],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_record_risk_check',
      description: 'Record the ticket risk gate, including blocked/no-trade rationale.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          ticketId: { type: 'string' },
          idempotencyKey: { type: 'string' },
          checkType: { type: 'string' },
          passed: { type: 'boolean' },
          reason: { type: 'string' },
          payload: payloadSchema,
        },
        required: ['sessionId', 'idempotencyKey', 'checkType', 'passed'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_record_order',
      description: 'Record or reconcile an Alpaca order by client order id.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          ticketId: { type: 'string' },
          clientOrderId: { type: 'string', maxLength: 128 },
          brokerOrderId: { type: ['string', 'null'] },
          symbol: { type: 'string' },
          instrument: instrumentSchema,
          side: sideSchema,
          quantity: numericStringSchema,
          orderType: { type: 'string' },
          orderClass: { type: 'string' },
          limitPrice: numericStringSchema,
          stopPrice: numericStringSchema,
          takeProfitLimitPrice: numericStringSchema,
          stopLossStopPrice: numericStringSchema,
          stopLossLimitPrice: numericStringSchema,
          status: {
            type: 'string',
            enum: [
              'planned',
              'submitted',
              'accepted',
              'partially_filled',
              'filled',
              'canceled',
              'rejected',
              'expired',
              'reconciled',
              'replaced',
            ],
          },
          rejectReason: { type: ['string', 'null'] },
          brokerPayload: payloadSchema,
        },
        required: ['sessionId', 'clientOrderId', 'symbol', 'instrument', 'side', 'quantity', 'orderType', 'status'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_record_fill',
      description: 'Record or reconcile an Alpaca fill by broker fill id.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          clientOrderId: { type: 'string', maxLength: 128 },
          brokerFillId: { type: 'string' },
          symbol: { type: 'string' },
          side: sideSchema,
          quantity: numericStringSchema,
          price: numericStringSchema,
          filledAt: { type: 'string' },
          brokerPayload: payloadSchema,
        },
        required: ['sessionId', 'clientOrderId', 'brokerFillId', 'symbol', 'side', 'quantity', 'price', 'filledAt'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_record_position_snapshot',
      description: 'Record broker position state for reconciliation and UI visibility.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          symbol: { type: 'string' },
          quantity: numericStringSchema,
          marketValue: numericStringSchema,
          averageEntryPrice: numericStringSchema,
          unrealizedPnl: numericStringSchema,
          capturedAt: { type: 'string' },
          brokerPayload: payloadSchema,
        },
        required: ['sessionId', 'symbol', 'quantity', 'capturedAt'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_finalize_session',
      description:
        'Finalize the market session and update setup scorecards/examples from realized outcomes so the next run can compound evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          terminalReason: {
            type: 'string',
            enum: [
              'target_reached',
              'market_closed',
              'dry_run_complete',
              'scorecard_readback_waiting',
              'scorecard_readback_complete',
              'hard_stop',
            ],
          },
          openingEquity: numericStringSchema,
          closingEquity: numericStringSchema,
          realizedPnl: numericStringSchema,
          maxDrawdown: numericStringSchema,
          summary: payloadSchema,
          scorecardObservations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ticketId: { type: 'string' },
                symbol: { type: 'string' },
                setupType: { type: 'string' },
                setupGrade: setupGradeSchema,
                regime: { type: 'string' },
                timeBucket: { type: 'string' },
                outcome: { type: 'string', enum: ['win', 'loss', 'scratch', 'rejected_valid', 'rejected_invalid'] },
                realizedR: numericStringSchema,
                holdSeconds: numericStringSchema,
                mfeR: numericStringSchema,
                maeR: numericStringSchema,
                mistakeTags: optionalStringArraySchema,
                notes: { type: 'string' },
                payload: payloadSchema,
              },
              required: ['setupType', 'setupGrade', 'regime', 'timeBucket', 'outcome'],
              additionalProperties: false,
            },
          },
        },
        required: ['sessionId', 'terminalReason'],
        additionalProperties: false,
      },
    },
    {
      name: 'autotrader_get_scorecard',
      description:
        'Read prior setup scorecards and examples before grading new candidates. Scorecards inform filtering/sizing but do not replace live confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          setupType: { type: 'string' },
          setupGrade: setupGradeSchema,
          regime: { type: 'string' },
          timeBucket: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
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
          sourceMediaRequiresExtractedVisualNotes: true,
        },
        companies: {
          appOwnedProfiles: true,
          primaryProfileSource: 'Webull when configured; local official-source fixtures/manual hints otherwise',
          quoteContext: 'optional Alpaca market-data read only; never required for static prefill',
        },
        autotrader: {
          appOwnedState: true,
          brokerTruth: 'Alpaca MCP',
          durableState: 'Postgres autotrader schema',
          feedItems: 'milestone summaries only; never primary trade state',
          learning: 'scorecards/examples must be read before grading new candidates',
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
    if (name === 'synthesis_prefill_company') {
      const parsed = CompanyProfileHintSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid synthesis_prefill_company input')
      return asJsonRpcResponse(id, toTextToolResult({ ok: true, company: await store.prefillCompany(parsed.data) }))
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
    if (name === 'autotrader_start_session') {
      const parsed = AutotraderStartSessionInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_start_session input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, session: await getAutotraderStore().startSession(parsed.data) }),
      )
    }
    if (name === 'autotrader_upsert_status') {
      const parsed = AutotraderUpsertStatusInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_upsert_status input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, status: await getAutotraderStore().upsertStatus(parsed.data) }),
      )
    }
    if (name === 'autotrader_append_event') {
      const parsed = AutotraderAppendEventInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_append_event input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, event: await getAutotraderStore().appendEvent(parsed.data) }),
      )
    }
    if (name === 'autotrader_create_trade_ticket') {
      const parsed = AutotraderCreateTradeTicketInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_create_trade_ticket input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, ticket: await getAutotraderStore().createTradeTicket(parsed.data) }),
      )
    }
    if (name === 'autotrader_record_risk_check') {
      const parsed = AutotraderRecordRiskCheckInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_record_risk_check input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, riskCheck: await getAutotraderStore().recordRiskCheck(parsed.data) }),
      )
    }
    if (name === 'autotrader_record_order') {
      const parsed = AutotraderRecordOrderInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_record_order input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, order: await getAutotraderStore().recordOrder(parsed.data) }),
      )
    }
    if (name === 'autotrader_record_fill') {
      const parsed = AutotraderRecordFillInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_record_fill input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, fill: await getAutotraderStore().recordFill(parsed.data) }),
      )
    }
    if (name === 'autotrader_record_position_snapshot') {
      const parsed = AutotraderRecordPositionSnapshotInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_record_position_snapshot input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({
          ok: true,
          positionSnapshot: await getAutotraderStore().recordPositionSnapshot(parsed.data),
        }),
      )
    }
    if (name === 'autotrader_finalize_session') {
      const parsed = AutotraderFinalizeSessionInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_finalize_session input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, detail: await getAutotraderStore().finalizeSession(parsed.data) }),
      )
    }
    if (name === 'autotrader_get_scorecard') {
      const parsed = AutotraderGetScorecardInputSchema.safeParse(args)
      if (!parsed.success) return invalidParams(id, 'Invalid autotrader_get_scorecard input')
      return asJsonRpcResponse(
        id,
        toTextToolResult({ ok: true, ...(await getAutotraderStore().getScorecard(parsed.data)) }),
      )
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
