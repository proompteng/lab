import { Context, Effect, Layer, ManagedRuntime } from 'effect'

import {
  ackAgentRunTerminalEventViaAgentsService,
  fetchAgentRunFromAgentsService,
  fetchAgentRunLogsFromAgentsService,
  fetchAgentRunResourcesFromAgentsService,
  fetchAgentRunsFromAgentsService,
  fetchAgentRunTerminalEventsFromAgentsService,
  MAX_MEMORY_NOTE_CONTENT_CHARS,
  MAX_MEMORY_NOTE_QUERY_CHARS,
  MAX_MEMORY_NOTE_SUMMARY_CHARS,
  parsePersistMemoryNoteInput,
  parseRetrieveMemoryNotesInput,
  resolveAgentsServiceBaseUrl,
  submitAgentRunRerunToAgentsService,
  submitAgentRunToAgentsService,
  type AgentsAgentRunGetInput,
  type AgentsAgentRunListInput,
  type AgentsAgentRunLogsInput,
  type AgentsAgentRunResourceListInput,
  type AgentsAgentRunRerunSubmitInput,
  type AgentsAgentRunSubmitInput,
  type AgentsAgentRunTerminalEventAckInput,
  type AgentsAgentRunTerminalEventsListInput,
  type AgentsMemoryNoteRecord,
  type AgentsPersistMemoryNoteInput,
  type AgentsRetrieveMemoryNotesInput,
  type AgentsServiceJsonResult,
  type EnvSource,
} from '@proompteng/agent-contracts'

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

export type AgentRunsMcpService = {
  create: (input: AgentsAgentRunSubmitInput) => Effect.Effect<unknown, Error>
  list: (input: AgentsAgentRunListInput) => Effect.Effect<unknown, Error>
  get: (input: AgentsAgentRunGetInput) => Effect.Effect<unknown, Error>
  listResources: (input: AgentsAgentRunResourceListInput) => Effect.Effect<unknown, Error>
  getLogs: (input: AgentsAgentRunLogsInput) => Effect.Effect<unknown, Error>
  listTerminalEvents: (input: AgentsAgentRunTerminalEventsListInput) => Effect.Effect<unknown, Error>
  ackTerminalEvent: (input: AgentsAgentRunTerminalEventAckInput) => Effect.Effect<unknown, Error>
  rerun: (input: AgentsAgentRunRerunSubmitInput) => Effect.Effect<unknown, Error>
}

export class MemoryNotesMcp extends Context.Tag('agents/MemoryNotesMcp')<MemoryNotesMcp, MemoryNotesMcpService>() {}
export class AgentRunsMcp extends Context.Tag('agents/AgentRunsMcp')<AgentRunsMcp, AgentRunsMcpService>() {}

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_SERVER_INFO = { name: 'agents-control-plane', version: '0.2.0' } as const
const MCP_CONFIG_RESOURCE_URI = 'agents://config'
const DEFAULT_AGENT_RUN_NAMESPACE = 'agents'

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
    {
      name: 'create_agent_run',
      description:
        'Create a real AgentRun through the Agents v1 API. Requires an idempotent deliveryId. For VCS runs, set payload.parameters.repository plus secretBindingRef or payload.policy.secretBindingRef.',
      inputSchema: {
        type: 'object',
        properties: {
          deliveryId: { type: 'string', description: 'Required idempotency key for the AgentRun submission' },
          secretBindingRef: {
            type: 'string',
            description:
              'Optional convenience value injected into payload.policy.secretBindingRef; required when payload.secrets are non-empty or vcsRef/vcsPolicy needs credentials.',
          },
          payload: {
            type: 'object',
            description:
              'AgentRun submission payload accepted by POST /v1/agent-runs. Use top-level goal for Codex goals, omit goal.tokenBudget for no-budget runs, and never set parameters.prompt.',
            properties: {
              agentRef: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: true,
              },
              implementationSpecRef: {
                type: 'object',
                properties: { name: { type: 'string' } },
                additionalProperties: true,
              },
              implementation: {
                type: 'object',
                description: 'Inline implementation source; the API wraps this as spec.implementation.inline.',
                additionalProperties: true,
              },
              goal: {
                type: 'object',
                description: 'Optional Codex goal. Omit tokenBudget entirely for a goal with no token budget.',
                additionalProperties: true,
              },
              parameters: {
                type: 'object',
                description:
                  'Run parameters such as repository/base/head/stage. VCS runs require repository. parameters.prompt is rejected; use implementation text or ImplementationSpec text.',
                additionalProperties: true,
              },
              secrets: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Secret names to mount. If non-empty, secretBindingRef or payload.policy.secretBindingRef is required.',
              },
              policy: {
                type: 'object',
                properties: {
                  secretBindingRef: {
                    type: 'string',
                    description: 'SecretBinding authorizing requested secrets and VCS credentials.',
                  },
                },
                additionalProperties: true,
              },
              vcsRef: {
                type: 'object',
                properties: { name: { type: 'string' } },
                additionalProperties: true,
              },
              vcsPolicy: {
                type: 'object',
                properties: {
                  required: { type: 'boolean' },
                  mode: { type: 'string', enum: ['read-write', 'read-only', 'none'] },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
          dryRun: { type: ['string', 'boolean'], description: 'Optional dryRun query value' },
        },
        required: ['deliveryId', 'payload'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_agent_runs',
      description: 'List AgentRun projection records by agent name or status.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Optional Agent name filter' },
          statuses: { type: 'array', items: { type: 'string' }, description: 'Optional status filters' },
          limit: { type: 'integer', description: 'Max results (default 50, max 500)', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_agent_run',
      description: 'Get one AgentRun projection record and its live Kubernetes resource when available.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Required AgentRun projection id' },
          namespace: { type: 'string', description: 'Optional Kubernetes namespace, defaults to agents' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_agent_run_resources',
      description: 'List live Kubernetes AgentRun resources through the typed v1 resource endpoint.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Optional namespace, defaults to agents' },
          labelSelector: { type: 'string', description: 'Optional Kubernetes label selector' },
          phase: { type: 'string', description: 'Optional AgentRun status.phase filter' },
          runtime: { type: 'string', description: 'Optional spec.runtime.type filter' },
          limit: { type: 'integer', description: 'Max results (max 500)', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_agent_run_logs',
      description: 'Fetch a non-streaming AgentRun log snapshot. Use tailLines for last-N-line reads.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Required AgentRun Kubernetes resource name' },
          namespace: { type: 'string', description: 'Required Kubernetes namespace' },
          pod: { type: 'string', description: 'Optional selected pod name' },
          container: { type: 'string', description: 'Optional selected container name' },
          tailLines: {
            type: 'integer',
            description: 'Optional log tail line count (max 5000)',
            minimum: 1,
            maximum: 5000,
          },
        },
        required: ['name', 'namespace'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_agent_run_terminal_events',
      description: 'List derived terminal AgentRun completion events for a consumer.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Optional namespace, defaults to agents' },
          runIdPrefix: { type: 'string', description: 'Optional runId prefix filter' },
          consumer: { type: 'string', description: 'Optional consumer name used for ack filtering' },
          includeAcked: { type: 'boolean', description: 'Include events already acked by the consumer' },
          limit: { type: 'integer', description: 'Max results (default 100, max 500)', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ack_agent_run_terminal_event',
      description: 'Ack a terminal AgentRun event for a consumer after it has been processed.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Required namespace/name/uid/phase terminal event id' },
          consumer: { type: 'string', description: 'Required consumer name' },
          outcome: { type: 'string', description: 'Optional processing outcome' },
          message: { type: 'string', description: 'Optional processing note' },
          receiptRef: { type: 'string', description: 'Optional durable receipt reference' },
          annotations: {
            type: 'object',
            description: 'Optional extra annotations to patch onto the AgentRun resource',
          },
        },
        required: ['eventId', 'consumer'],
        additionalProperties: false,
      },
    },
    {
      name: 'rerun_agent_run',
      description: 'Submit an idempotent rerun for an existing AgentRun projection id.',
      inputSchema: {
        type: 'object',
        properties: {
          agentRunId: { type: 'string', description: 'Required parent AgentRun projection id' },
          deliveryId: { type: 'string', description: 'Required idempotency key for the rerun' },
          payload: { type: 'object', description: 'Rerun payload accepted by POST /v1/agent-runs/{id}/reruns' },
        },
        required: ['agentRunId', 'deliveryId', 'payload'],
        additionalProperties: false,
      },
    },
  ],
} as const

const resourcesListResult = {
  resources: [
    {
      uri: MCP_CONFIG_RESOURCE_URI,
      name: 'Agents MCP config',
      description: 'Server metadata and defaults for Agents memory and AgentRun tools.',
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

type ParsedToolInput<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      message: string
    }

const okInput = <T>(value: T): ParsedToolInput<T> => ({ ok: true, value })
const badInput = <T>(message: string): ParsedToolInput<T> => ({ ok: false, message })

const optionalString = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const requiredString = (args: Record<string, unknown>, key: string) => {
  const value = optionalString(args, key)
  if (!value) throw new Error(`${key} is required`)
  return value
}

const optionalInteger = (args: Record<string, unknown>, key: string, max: number) => {
  const value = args[key]
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`)
  }
  return Math.min(Math.floor(value), max)
}

const optionalBoolean = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (value == null) return null
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

const optionalStringArray = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (value == null) return null
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

const requiredRecord = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (!isRecord(value)) throw new Error(`${key} must be an object`)
  return value
}

const optionalStringNullMap = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (value == null) return null
  if (!isRecord(value)) throw new Error(`${key} must be an object`)
  const output: Record<string, string | null> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryValue === null || typeof entryValue === 'string') {
      output[entryKey] = entryValue
      continue
    }
    throw new Error(`${key}.${entryKey} must be a string or null`)
  }
  return output
}

const parseWithErrors = <T>(parse: () => T): ParsedToolInput<T> => {
  try {
    return okInput(parse())
  } catch (error) {
    return badInput(error instanceof Error ? error.message : String(error))
  }
}

const recordString = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const payloadRequestsSecrets = (payload: Record<string, unknown>) =>
  Array.isArray(payload.secrets) &&
  payload.secrets.some((entry) => typeof entry === 'string' && entry.trim().length > 0)

const payloadRequestsVcsCredentials = (payload: Record<string, unknown>) => {
  const vcsRef = isRecord(payload.vcsRef) ? payload.vcsRef : null
  const vcsPolicy = isRecord(payload.vcsPolicy) ? payload.vcsPolicy : null
  if (!recordString(vcsRef, 'name')) return false
  if (recordString(vcsPolicy, 'mode') === 'none') return false
  return true
}

const payloadSecretBindingRef = (payload: Record<string, unknown>) => {
  const policy = isRecord(payload.policy) ? payload.policy : null
  return recordString(policy, 'secretBindingRef')
}

const payloadRepository = (payload: Record<string, unknown>) => {
  const parameters = isRecord(payload.parameters) ? payload.parameters : null
  return recordString(parameters, 'repository')
}

const withSecretBindingRef = (payload: Record<string, unknown>, secretBindingRef: string | null) => {
  const current = payloadSecretBindingRef(payload)
  if (secretBindingRef && current && current !== secretBindingRef) {
    throw new Error('secretBindingRef must match payload.policy.secretBindingRef when both are provided')
  }
  if (!secretBindingRef) return payload
  const policy = isRecord(payload.policy) ? payload.policy : {}
  return {
    ...payload,
    policy: {
      ...policy,
      secretBindingRef,
    },
  }
}

const validateCreateAgentRunPayloadForMcp = (payload: Record<string, unknown>) => {
  const parameters = isRecord(payload.parameters) ? payload.parameters : {}
  const forbiddenPromptKey = Object.keys(parameters).find((key) => key.trim().toLowerCase() === 'prompt')
  if (forbiddenPromptKey) {
    throw new Error(
      `payload.parameters.${forbiddenPromptKey} is not allowed; use implementation text or ImplementationSpec text`,
    )
  }

  if (
    (payloadRequestsSecrets(payload) || payloadRequestsVcsCredentials(payload)) &&
    !payloadSecretBindingRef(payload)
  ) {
    throw new Error(
      'payload.policy.secretBindingRef is required when payload.secrets are requested or vcsRef/vcsPolicy needs credentials; pass secretBindingRef or payload.policy.secretBindingRef',
    )
  }

  if (payloadRequestsVcsCredentials(payload) && !payloadRepository(payload)) {
    throw new Error('payload.parameters.repository is required when vcsRef/vcsPolicy requests version control')
  }
}

const parseCreateAgentRunInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunSubmitInput>(() => {
    const rawDryRun = args.dryRun
    let dryRun: string | null
    if (typeof rawDryRun === 'boolean') {
      dryRun = rawDryRun ? 'true' : 'false'
    } else if (rawDryRun == null) {
      dryRun = null
    } else {
      dryRun = requiredString(args, 'dryRun')
    }
    const payload = withSecretBindingRef(requiredRecord(args, 'payload'), optionalString(args, 'secretBindingRef'))
    validateCreateAgentRunPayloadForMcp(payload)
    return {
      deliveryId: requiredString(args, 'deliveryId'),
      payload,
      dryRun,
    }
  })

const parseListAgentRunsInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunListInput>(() => ({
    agentName: optionalString(args, 'agentName'),
    statuses: optionalStringArray(args, 'statuses'),
    limit: optionalInteger(args, 'limit', 500),
  }))

const parseGetAgentRunInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunGetInput>(() => ({
    id: requiredString(args, 'id'),
    namespace: optionalString(args, 'namespace') ?? DEFAULT_AGENT_RUN_NAMESPACE,
  }))

const parseListAgentRunResourcesInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunResourceListInput>(() => ({
    namespace: optionalString(args, 'namespace') ?? DEFAULT_AGENT_RUN_NAMESPACE,
    labelSelector: optionalString(args, 'labelSelector'),
    phase: optionalString(args, 'phase'),
    runtime: optionalString(args, 'runtime'),
    limit: optionalInteger(args, 'limit', 500),
  }))

const parseGetAgentRunLogsInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunLogsInput>(() => ({
    name: requiredString(args, 'name'),
    namespace: requiredString(args, 'namespace'),
    pod: optionalString(args, 'pod'),
    container: optionalString(args, 'container'),
    tailLines: optionalInteger(args, 'tailLines', 5000),
  }))

const parseListTerminalEventsInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunTerminalEventsListInput>(() => ({
    namespace: optionalString(args, 'namespace') ?? DEFAULT_AGENT_RUN_NAMESPACE,
    runIdPrefix: optionalString(args, 'runIdPrefix'),
    consumer: optionalString(args, 'consumer'),
    includeAcked: optionalBoolean(args, 'includeAcked'),
    limit: optionalInteger(args, 'limit', 500),
  }))

const parseAckTerminalEventInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunTerminalEventAckInput>(() => ({
    eventId: requiredString(args, 'eventId'),
    consumer: requiredString(args, 'consumer'),
    outcome: optionalString(args, 'outcome'),
    message: optionalString(args, 'message'),
    receiptRef: optionalString(args, 'receiptRef'),
    annotations: optionalStringNullMap(args, 'annotations'),
  }))

const parseRerunAgentRunInput = (args: Record<string, unknown>) =>
  parseWithErrors<AgentsAgentRunRerunSubmitInput>(() => ({
    agentRunId: requiredString(args, 'agentRunId'),
    deliveryId: requiredString(args, 'deliveryId'),
    payload: requiredRecord(args, 'payload'),
  }))

const toolError = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32000, message, data })

const invalidParams = (id: JsonRpcId, message: string, data?: unknown): JsonRpcResponse =>
  asJsonRpcError(id, { code: -32602, message, data })

const resolveAgentsMcpEnv = (env: EnvSource = process.env): EnvSource => ({
  ...env,
  AGENTS_SERVICE_CLIENT_NAME: env.AGENTS_SERVICE_CLIENT_NAME ?? 'agents-mcp',
})

const agentsResultEffect = <T>(
  toolName: string,
  run: () => Promise<AgentsServiceJsonResult<T>>,
): Effect.Effect<T, Error> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.ok) return Effect.succeed(result.body)
      return Effect.fail(new Error(result.error ?? `Agents service returned HTTP ${result.status}`))
    }),
    Effect.mapError((error) => new Error(`${toolName} failed: ${error.message}`)),
  )

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
          memoryNamespace: 'default',
          agentRunNamespace: DEFAULT_AGENT_RUN_NAMESPACE,
          agentsServiceBaseUrl: resolveAgentsServiceBaseUrl(resolveAgentsMcpEnv()),
          limits: {
            maxContentChars: MAX_MEMORY_NOTE_CONTENT_CHARS,
            maxQueryChars: MAX_MEMORY_NOTE_QUERY_CHARS,
            maxSummaryChars: MAX_MEMORY_NOTE_SUMMARY_CHARS,
            maxAgentRunLogTailLines: 5000,
          },
        },
      },
      null,
      2,
    ),
  }
}

const successToolResponse = (id: JsonRpcId, baseUrl: URL, toolName: string, result: unknown) =>
  asJsonRpcResponse(
    id,
    toTextToolResult(JSON.stringify({ ok: true, result, mcp: { server: baseUrl.origin, tool: toolName } }, null, 2)),
  )

const handleToolCallEffect = (request: Request, id: JsonRpcId, toolName: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const memories = yield* MemoryNotesMcp
    const agents = yield* AgentRunsMcp
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

    if (toolName === 'create_agent_run') {
      const parsed = parseCreateAgentRunInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.create(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'list_agent_runs') {
      const parsed = parseListAgentRunsInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.list(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'get_agent_run') {
      const parsed = parseGetAgentRunInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.get(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'list_agent_run_resources') {
      const parsed = parseListAgentRunResourcesInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.listResources(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'get_agent_run_logs') {
      const parsed = parseGetAgentRunLogsInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.getLogs(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'list_agent_run_terminal_events') {
      const parsed = parseListTerminalEventsInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.listTerminalEvents(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'ack_agent_run_terminal_event') {
      const parsed = parseAckTerminalEventInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.ackTerminalEvent(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
    }

    if (toolName === 'rerun_agent_run') {
      const parsed = parseRerunAgentRunInput(args)
      if (!parsed.ok) return invalidParams(id, `Invalid params: ${parsed.message}`)
      const result = yield* Effect.either(agents.rerun(parsed.value))
      if (result._tag === 'Left') return toolError(id, result.left.message, { tool: toolName })
      return successToolResponse(id, baseUrl, toolName, result.right)
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

export const AgentRunsMcpLive = Layer.succeed(AgentRunsMcp, {
  create: (input) =>
    agentsResultEffect('create_agent_run', () => submitAgentRunToAgentsService(input, resolveAgentsMcpEnv())),
  list: (input) =>
    agentsResultEffect('list_agent_runs', () => fetchAgentRunsFromAgentsService(input, resolveAgentsMcpEnv())),
  get: (input) =>
    agentsResultEffect('get_agent_run', () => fetchAgentRunFromAgentsService(input, resolveAgentsMcpEnv())),
  listResources: (input) =>
    agentsResultEffect('list_agent_run_resources', () =>
      fetchAgentRunResourcesFromAgentsService(input, resolveAgentsMcpEnv()),
    ),
  getLogs: (input) =>
    agentsResultEffect('get_agent_run_logs', () => fetchAgentRunLogsFromAgentsService(input, resolveAgentsMcpEnv())),
  listTerminalEvents: (input) =>
    agentsResultEffect('list_agent_run_terminal_events', () =>
      fetchAgentRunTerminalEventsFromAgentsService(input, resolveAgentsMcpEnv()),
    ),
  ackTerminalEvent: (input) =>
    agentsResultEffect('ack_agent_run_terminal_event', () =>
      ackAgentRunTerminalEventViaAgentsService(input, resolveAgentsMcpEnv()),
    ),
  rerun: (input) =>
    agentsResultEffect('rerun_agent_run', () => submitAgentRunRerunToAgentsService(input, resolveAgentsMcpEnv())),
} satisfies AgentRunsMcpService)

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoryNotesMcpLive, AgentRunsMcpLive))

export const handleMcpRequest = (request: Request): Promise<Response> =>
  handlerRuntime.runPromise(handleMcpRequestEffect(request))
